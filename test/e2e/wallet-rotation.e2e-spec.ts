import { Keypair } from "@stellar/stellar-base";
import { createHash } from "crypto";
import * as request from "supertest";
import { SessionService } from "../../src/auth/session.service";
import { integrationDatabase } from "../integration/harness/database";
import { e2eApp } from "./harness/app";
import {
  AuthenticatedClient,
  authenticateNewWallet,
  authenticateWallet,
} from "./harness/wallet-auth";

const db = integrationDatabase();
const e2e = e2eApp();

function sign(key: Keypair, message: string): string {
  const hash = createHash("sha256")
    .update("Stellar Signed Message:\n", "utf8")
    .update(message, "utf8")
    .digest();
  return key.sign(hash).toString("base64");
}

interface Rotation {
  rotationId: string;
  currentMessage: string;
  newMessage: string;
}

async function initiate(client: AuthenticatedClient, replacement: Keypair): Promise<Rotation> {
  const response = await request(e2e.httpServer)
    .post("/api/v1/auth/wallet-rotation")
    .set("Authorization", `Bearer ${client.token}`)
    .send({ newWalletAddress: replacement.publicKey() })
    .expect(201);
  return response.body as Rotation;
}

function complete(
  client: AuthenticatedClient,
  rotation: Rotation,
  keys: { current: Keypair; replacement: Keypair },
) {
  return request(e2e.httpServer)
    .post(`/api/v1/auth/wallet-rotation/${rotation.rotationId}/complete`)
    .set("Authorization", `Bearer ${client.token}`)
    .send({
      currentSignature: sign(keys.current, rotation.currentMessage),
      newSignature: sign(keys.replacement, rotation.newMessage),
    });
}

async function sessionWorks(token: string): Promise<boolean> {
  const response = await request(e2e.httpServer)
    .get("/api/v1/auth/session")
    .set("Authorization", `Bearer ${token}`);
  return response.status === 200;
}

async function walletOf(userId: string): Promise<string> {
  return (await db.prisma.user.findUniqueOrThrow({ where: { id: userId } })).walletAddress;
}

describe("wallet address rotation", () => {
  it("rotates the wallet after both keys sign, and only the new key signs in to the account", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const otherSession = await authenticateWallet(e2e.httpServer, client.keypair);
    const replacement = Keypair.random();

    const rotation = await initiate(client, replacement);
    const response = await complete(client, rotation, {
      current: client.keypair,
      replacement,
    }).expect(200);

    expect(response.body).toEqual({
      walletAddress: replacement.publicKey(),
      sessionsRevoked: 2,
    });
    expect(await walletOf(client.userId)).toBe(replacement.publicKey());

    // Every session of the account is gone, including the one that asked.
    expect(await sessionWorks(client.token)).toBe(false);
    expect(await sessionWorks(otherSession.token)).toBe(false);

    // The replacement key now signs in to the same account.
    const viaNewKey = await authenticateWallet(e2e.httpServer, replacement);
    expect(viaNewKey.userId).toBe(client.userId);

    // The previous key no longer reaches it.
    const viaOldKey = await authenticateWallet(e2e.httpServer, client.keypair);
    expect(viaOldKey.userId).not.toBe(client.userId);

    const audit = await db.prisma.auditLog.findMany({
      where: { action: "user.wallet_rotated", resourceId: client.userId },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      rotationId: rotation.rotationId,
      sessionsRevoked: 2,
    });
    const serialised = JSON.stringify(audit[0]);
    expect(serialised).not.toContain(client.walletAddress);
    expect(serialised).not.toContain(replacement.publicKey());
  });

  it("refuses a replay of a completed rotation", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const replacement = Keypair.random();
    const rotation = await initiate(client, replacement);
    const body = {
      currentSignature: sign(client.keypair, rotation.currentMessage),
      newSignature: sign(replacement, rotation.newMessage),
    };

    await request(e2e.httpServer)
      .post(`/api/v1/auth/wallet-rotation/${rotation.rotationId}/complete`)
      .set("Authorization", `Bearer ${client.token}`)
      .send(body)
      .expect(200);

    // Replayed with a session for the rotated account.
    const again = await authenticateWallet(e2e.httpServer, replacement);
    await request(e2e.httpServer)
      .post(`/api/v1/auth/wallet-rotation/${rotation.rotationId}/complete`)
      .set("Authorization", `Bearer ${again.token}`)
      .send(body)
      .expect(401);
    expect(
      await db.prisma.auditLog.count({ where: { action: "user.wallet_rotated" } }),
    ).toBe(1);
  });

  it("lets exactly one of several concurrent completions win", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const replacement = Keypair.random();
    const rotation = await initiate(client, replacement);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        complete(client, rotation, { current: client.keypair, replacement }),
      ),
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401, 401, 401, 401]);
    expect(await walletOf(client.userId)).toBe(replacement.publicKey());
    expect(
      await db.prisma.auditLog.count({ where: { action: "user.wallet_rotated" } }),
    ).toBe(1);
  });

  it("rejects a replacement already bound to another account, even with valid signatures", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const owner = await authenticateNewWallet(e2e.httpServer);

    // Initiation does not reveal that the address is registered.
    const rotation = await initiate(client, owner.keypair);
    await complete(client, rotation, {
      current: client.keypair,
      replacement: owner.keypair,
    }).expect(409);

    expect(await walletOf(client.userId)).toBe(client.walletAddress);
    expect(await walletOf(owner.userId)).toBe(owner.walletAddress);
    expect(await sessionWorks(client.token)).toBe(true);
    expect(await sessionWorks(owner.token)).toBe(true);
  });

  it("makes no identity change for a partially signed rotation, which cannot be retried", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const replacement = Keypair.random();
    const rotation = await initiate(client, replacement);

    await complete(client, rotation, {
      current: client.keypair,
      replacement: Keypair.random(),
    }).expect(401);

    expect(await walletOf(client.userId)).toBe(client.walletAddress);
    expect(await sessionWorks(client.token)).toBe(true);

    await complete(client, rotation, { current: client.keypair, replacement }).expect(401);
    expect(await walletOf(client.userId)).toBe(client.walletAddress);
    expect(
      (await db.prisma.walletRotation.findUniqueOrThrow({ where: { id: rotation.rotationId } }))
        .status,
    ).toBe("FAILED");
  });

  it("makes no identity change for an expired rotation", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const replacement = Keypair.random();
    const rotation = await initiate(client, replacement);
    await db.prisma.walletRotation.update({
      where: { id: rotation.rotationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await complete(client, rotation, { current: client.keypair, replacement }).expect(401);
    expect(await walletOf(client.userId)).toBe(client.walletAddress);
  });

  it("rejects a rotation bound to another network", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const replacement = Keypair.random();
    const rotation = await initiate(client, replacement);
    await db.prisma.walletRotation.update({
      where: { id: rotation.rotationId },
      data: { networkPassphrase: "Public Global Stellar Network ; September 2015" },
    });

    await complete(client, rotation, { current: client.keypair, replacement }).expect(401);
    expect(await walletOf(client.userId)).toBe(client.walletAddress);
  });

  it("rejects completion from a different origin than the one the rotation was bound to", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const replacement = Keypair.random();
    const rotation = await initiate(client, replacement);

    await complete(client, rotation, { current: client.keypair, replacement })
      .set("Origin", "https://attacker.example.com")
      .expect(401);
    expect(await walletOf(client.userId)).toBe(client.walletAddress);
  });

  it("refuses another account's rotation and anonymous callers", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const intruder = await authenticateNewWallet(e2e.httpServer);
    const replacement = Keypair.random();
    const rotation = await initiate(client, replacement);

    await complete(intruder, rotation, { current: client.keypair, replacement }).expect(401);
    await request(e2e.httpServer)
      .post("/api/v1/auth/wallet-rotation")
      .send({ newWalletAddress: replacement.publicKey() })
      .expect(401);
    expect(await walletOf(client.userId)).toBe(client.walletAddress);

    // The intruder's attempt did not burn the owner's rotation.
    await complete(client, rotation, { current: client.keypair, replacement }).expect(200);
  });

  it("refuses a session issued to the previous wallet after the rotation", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);
    const replacement = Keypair.random();
    const rotation = await initiate(client, replacement);
    await complete(client, rotation, { current: client.keypair, replacement }).expect(200);

    // The losing side of a login/rotation race: a login with the previous key
    // that had already loaded the account inserts its session afterwards.
    const raced = await e2e.app.get(SessionService).create({
      id: client.userId,
      walletAddress: client.walletAddress,
      walletHash: `sha256:${createHash("sha256").update(client.walletAddress).digest("hex")}`,
      role: "WORKER",
    });

    expect(await sessionWorks(raced.token)).toBe(false);
  });

  it("validates the replacement address", async () => {
    const client = await authenticateNewWallet(e2e.httpServer);

    await request(e2e.httpServer)
      .post("/api/v1/auth/wallet-rotation")
      .set("Authorization", `Bearer ${client.token}`)
      .send({ newWalletAddress: client.walletAddress })
      .expect(400);
    await request(e2e.httpServer)
      .post("/api/v1/auth/wallet-rotation")
      .set("Authorization", `Bearer ${client.token}`)
      .send({ newWalletAddress: "G".padEnd(56, "A") })
      .expect(400);
  });
});
