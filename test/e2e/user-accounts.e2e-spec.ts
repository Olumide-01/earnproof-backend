import { ResourceStatus, UserRole } from "@prisma/client";
import * as request from "supertest";
import { SessionService } from "../../src/auth/session.service";
import { integrationDatabase } from "../integration/harness/database";
import { seedOrganization } from "../integration/harness/fixtures";
import { e2eApp } from "./harness/app";
import {
  AuthenticatedClient,
  authenticateNewWallet,
  authenticateWallet,
  signInWithKeypair,
} from "./harness/wallet-auth";

const db = integrationDatabase();
const e2e = e2eApp();

async function newAdmin(): Promise<AuthenticatedClient> {
  const admin = await authenticateNewWallet(e2e.httpServer);
  // The guard reads the role live, so promoting the row is enough.
  await db.prisma.user.update({
    where: { id: admin.userId },
    data: { role: UserRole.ADMIN },
  });
  return admin;
}

const bearer = (client: AuthenticatedClient) => `Bearer ${client.token}`;

describe("user profile and account status APIs", () => {
  describe("self-service profile", () => {
    it("returns the caller's own profile without the wallet hash", async () => {
      const client = await authenticateNewWallet(e2e.httpServer);

      const response = await request(e2e.httpServer)
        .get("/api/v1/users/me")
        .set("Authorization", bearer(client))
        .expect(200);

      expect(response.body).toMatchObject({
        id: client.userId,
        walletAddress: client.walletAddress,
        role: "WORKER",
        status: "ACTIVE",
        displayName: null,
      });
      expect(response.body).not.toHaveProperty("walletHash");
    });

    it("updates and clears the display name", async () => {
      const client = await authenticateNewWallet(e2e.httpServer);

      await request(e2e.httpServer)
        .patch("/api/v1/users/me")
        .set("Authorization", bearer(client))
        .send({ displayName: "  Synthetic Worker  " })
        .expect(200)
        .expect(({ body }) => expect(body.displayName).toBe("Synthetic Worker"));

      await request(e2e.httpServer)
        .patch("/api/v1/users/me")
        .set("Authorization", bearer(client))
        .send({ displayName: null })
        .expect(200)
        .expect(({ body }) => expect(body.displayName).toBeNull());
    });

    it.each([
      { role: "ADMIN" },
      { status: "ACTIVE" },
      { walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ])("refuses to let a user write %p about themselves", async (body) => {
      const client = await authenticateNewWallet(e2e.httpServer);

      await request(e2e.httpServer)
        .patch("/api/v1/users/me")
        .set("Authorization", bearer(client))
        .send(body)
        .expect(422);

      const row = await db.prisma.user.findUniqueOrThrow({ where: { id: client.userId } });
      expect(row.role).toBe(UserRole.WORKER);
      expect(row.status).toBe(ResourceStatus.ACTIVE);
      expect(row.walletAddress).toBe(client.walletAddress);
    });

    it("requires a session", async () => {
      await request(e2e.httpServer).get("/api/v1/users/me").expect(401);
      await request(e2e.httpServer).patch("/api/v1/users/me").send({}).expect(401);
    });
  });

  describe("authorization", () => {
    it("denies a non-admin every by-id route and changes nothing", async () => {
      const caller = await authenticateNewWallet(e2e.httpServer);
      const victim = await authenticateNewWallet(e2e.httpServer);

      for (const role of [UserRole.WORKER, UserRole.DEVELOPER, UserRole.ISSUER]) {
        await db.prisma.user.update({ where: { id: caller.userId }, data: { role } });

        await request(e2e.httpServer)
          .get(`/api/v1/users/${victim.userId}`)
          .set("Authorization", bearer(caller))
          .expect(403);
        await request(e2e.httpServer)
          .patch(`/api/v1/users/${victim.userId}/status`)
          .set("Authorization", bearer(caller))
          .send({ status: "SUSPENDED" })
          .expect(403);
        await request(e2e.httpServer)
          .patch(`/api/v1/users/${victim.userId}/role`)
          .set("Authorization", bearer(caller))
          .send({ role: "ADMIN" })
          .expect(403);
      }

      const row = await db.prisma.user.findUniqueOrThrow({ where: { id: victim.userId } });
      expect(row.status).toBe(ResourceStatus.ACTIVE);
      expect(row.role).toBe(UserRole.WORKER);
      expect(await db.prisma.auditLog.count()).toBe(0);
    });

    it("gives an administrator a view without wallet material", async () => {
      const admin = await newAdmin();
      const target = await authenticateNewWallet(e2e.httpServer);

      const response = await request(e2e.httpServer)
        .get(`/api/v1/users/${target.userId}`)
        .set("Authorization", bearer(admin))
        .expect(200);

      expect(response.body.id).toBe(target.userId);
      expect(response.body).not.toHaveProperty("walletAddress");
      expect(response.body).not.toHaveProperty("walletHash");
    });

    it("answers 404 for an unknown account", async () => {
      const admin = await newAdmin();

      await request(e2e.httpServer)
        .get("/api/v1/users/user_does_not_exist")
        .set("Authorization", bearer(admin))
        .expect(404);
      await request(e2e.httpServer)
        .patch("/api/v1/users/user_does_not_exist/status")
        .set("Authorization", bearer(admin))
        .send({ status: "SUSPENDED" })
        .expect(404);
    });

    it("forbids an administrator from changing their own status or role", async () => {
      const admin = await newAdmin();

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${admin.userId}/status`)
        .set("Authorization", bearer(admin))
        .send({ status: "SUSPENDED" })
        .expect(403);
      await request(e2e.httpServer)
        .patch(`/api/v1/users/${admin.userId}/role`)
        .set("Authorization", bearer(admin))
        .send({ role: "WORKER" })
        .expect(403);
    });
  });

  describe("status transitions", () => {
    it("suspension ends live sessions and blocks new logins until reinstatement", async () => {
      const admin = await newAdmin();
      const target = await authenticateNewWallet(e2e.httpServer);
      const secondSession = await authenticateWallet(e2e.httpServer, target.keypair);

      const suspended = await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/status`)
        .set("Authorization", bearer(admin))
        .send({ status: "SUSPENDED", reason: "SECURITY_INCIDENT" })
        .expect(200);
      expect(suspended.body).toMatchObject({
        status: "SUSPENDED",
        previousStatus: "ACTIVE",
        sessionsRevoked: 2,
      });

      // Both existing tokens stop working on the very next request.
      for (const token of [target.token, secondSession.token]) {
        await request(e2e.httpServer)
          .get("/api/v1/users/me")
          .set("Authorization", `Bearer ${token}`)
          .expect(401);
      }
      expect(
        await db.prisma.authSession.count({ where: { userId: target.userId, revokedAt: null } }),
      ).toBe(0);

      // A valid signature does not buy a suspended account a session.
      const refused = await signInWithKeypair(e2e.httpServer, target.keypair);
      expect(refused.status).toBe(401);
      expect(refused.body).not.toHaveProperty("session");
      expect(
        await db.prisma.authAuditEvent.count({ where: { eventType: "ACCOUNT_INACTIVE" } }),
      ).toBe(1);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/status`)
        .set("Authorization", bearer(admin))
        .send({ status: "ACTIVE", reason: "REVIEW_COMPLETED" })
        .expect(200)
        .expect(({ body }) => expect(body.sessionsRevoked).toBe(0));

      // Reinstatement restores login, never the revoked sessions.
      const fresh = await authenticateWallet(e2e.httpServer, target.keypair);
      await request(e2e.httpServer)
        .get("/api/v1/users/me")
        .set("Authorization", `Bearer ${fresh.token}`)
        .expect(200);
      await request(e2e.httpServer)
        .get("/api/v1/users/me")
        .set("Authorization", bearer(target))
        .expect(401);
    });

    it("reinstatement never resurrects a session minted during suspension", async () => {
      const admin = await newAdmin();
      const target = await authenticateNewWallet(e2e.httpServer);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/status`)
        .set("Authorization", bearer(admin))
        .send({ status: "SUSPENDED" })
        .expect(200);

      // The losing side of a login/suspension race: a login whose status check
      // ran just before the suspension committed still inserts its session.
      const raced = await e2e.app.get(SessionService).create({
        id: target.userId,
        walletAddress: target.walletAddress,
        walletHash: "unused",
        role: "WORKER",
      });
      await request(e2e.httpServer)
        .get("/api/v1/users/me")
        .set("Authorization", `Bearer ${raced.token}`)
        .expect(401);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/status`)
        .set("Authorization", bearer(admin))
        .send({ status: "ACTIVE" })
        .expect(200)
        .expect(({ body }) => expect(body.sessionsRevoked).toBe(1));

      await request(e2e.httpServer)
        .get("/api/v1/users/me")
        .set("Authorization", `Bearer ${raced.token}`)
        .expect(401);
    });

    it("revocation is terminal", async () => {
      const admin = await newAdmin();
      const target = await authenticateNewWallet(e2e.httpServer);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/status`)
        .set("Authorization", bearer(admin))
        .send({ status: "REVOKED" })
        .expect(200);

      await request(e2e.httpServer)
        .get("/api/v1/users/me")
        .set("Authorization", bearer(target))
        .expect(401);

      for (const status of ["ACTIVE", "SUSPENDED", "REVOKED"]) {
        await request(e2e.httpServer)
          .patch(`/api/v1/users/${target.userId}/status`)
          .set("Authorization", bearer(admin))
          .send({ status })
          .expect(409);
      }
      expect((await signInWithKeypair(e2e.httpServer, target.keypair)).status).toBe(401);
    });

    it.each(["DELETED", "PENDING", "BANNED"])(
      "rejects the non-assignable status %s",
      async (status) => {
        const admin = await newAdmin();
        const target = await authenticateNewWallet(e2e.httpServer);

        await request(e2e.httpServer)
          .patch(`/api/v1/users/${target.userId}/status`)
          .set("Authorization", bearer(admin))
          .send({ status })
          .expect(422);
      },
    );

    it("lets exactly one of two concurrent identical changes win", async () => {
      const admin = await newAdmin();
      const target = await authenticateNewWallet(e2e.httpServer);

      const send = () =>
        request(e2e.httpServer)
          .patch(`/api/v1/users/${target.userId}/status`)
          .set("Authorization", bearer(admin))
          .send({ status: "SUSPENDED" });
      const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort();

      expect(statuses).toEqual([200, 409]);
      expect(
        await db.prisma.auditLog.count({
          where: { action: "user.status_changed", resourceId: target.userId },
        }),
      ).toBe(1);
    });

    it("writes an audit record without wallet address or hash", async () => {
      const admin = await newAdmin();
      const target = await authenticateNewWallet(e2e.httpServer);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/status`)
        .set("Authorization", bearer(admin))
        .send({ status: "SUSPENDED", reason: "POLICY_VIOLATION" })
        .expect(200);

      const rows = await db.prisma.auditLog.findMany({ where: { resourceId: target.userId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: "user",
        actorId: admin.userId,
        action: "user.status_changed",
        resourceType: "user",
        metadata: {
          previousStatus: "ACTIVE",
          newStatus: "SUSPENDED",
          reason: "POLICY_VIOLATION",
          sessionsRevoked: 1,
        },
      });
      const serialised = JSON.stringify(rows[0]);
      expect(serialised).not.toContain(target.walletAddress);
      expect(serialised).not.toContain("sha256:");
    });
  });

  describe("role transitions", () => {
    it("applies a role change on the caller's next request", async () => {
      const admin = await newAdmin();
      const target = await newAdmin();

      await request(e2e.httpServer)
        .get(`/api/v1/users/${admin.userId}`)
        .set("Authorization", bearer(target))
        .expect(200);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/role`)
        .set("Authorization", bearer(admin))
        .send({ role: "DEVELOPER" })
        .expect(200)
        .expect(({ body }) =>
          expect(body).toMatchObject({ role: "DEVELOPER", previousRole: "ADMIN" }),
        );

      // Same token, no re-login: the demotion is already in force.
      await request(e2e.httpServer)
        .get(`/api/v1/users/${admin.userId}`)
        .set("Authorization", bearer(target))
        .expect(403);

      const audit = await db.prisma.auditLog.findFirstOrThrow({
        where: { action: "user.role_changed", resourceId: target.userId },
      });
      expect(audit.metadata).toEqual({ previousRole: "ADMIN", newRole: "DEVELOPER" });
    });

    it("refuses to demote a live organization owner to WORKER until ownership is retired", async () => {
      const admin = await newAdmin();
      const owner = await newAdmin();
      const organization = await seedOrganization(db.prisma, "owned-org", owner.userId);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${owner.userId}/role`)
        .set("Authorization", bearer(admin))
        .send({ role: "WORKER" })
        .expect(409);
      expect(
        (await db.prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).role,
      ).toBe(UserRole.ADMIN);

      await db.prisma.organization.update({
        where: { id: organization.id },
        data: { status: ResourceStatus.DELETED },
      });

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${owner.userId}/role`)
        .set("Authorization", bearer(admin))
        .send({ role: "WORKER" })
        .expect(200);
    });

    it("refuses a role change for a suspended account", async () => {
      const admin = await newAdmin();
      const target = await authenticateNewWallet(e2e.httpServer);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/status`)
        .set("Authorization", bearer(admin))
        .send({ status: "SUSPENDED" })
        .expect(200);

      await request(e2e.httpServer)
        .patch(`/api/v1/users/${target.userId}/role`)
        .set("Authorization", bearer(admin))
        .send({ role: "ADMIN" })
        .expect(409);
    });
  });
});
