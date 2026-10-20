import { Keypair } from "@stellar/stellar-base";
import { createHash } from "crypto";
import * as request from "supertest";

/**
 * Drives the real challenge/verify HTTP flow with a fresh, throwaway Stellar
 * keypair, so e2e specs authenticate exactly the way a real client does —
 * no service bypassed, no session inserted directly into the database.
 *
 * The message hash matches `AuthService`'s private `sep53MessageHash`
 * (SHA-256 of `"Stellar Signed Message:\n" + message`, SEP-53-style): there is
 * no exported helper to reuse, so this mirrors it deliberately rather than
 * reaching into the service's private implementation.
 */
function sep53MessageHash(message: string): Buffer {
  return createHash("sha256")
    .update("Stellar Signed Message:\n", "utf8")
    .update(message, "utf8")
    .digest();
}

export interface AuthenticatedClient {
  readonly userId: string;
  readonly walletAddress: string;
  readonly token: string;
  readonly sessionId: string;
  /** The wallet's key, so a spec can sign in as the same account again. */
  readonly keypair: Keypair;
}

/**
 * Runs the challenge/verify flow for `keypair` and returns the raw verify
 * response, whatever its status, for specs that assert a refused login.
 */
export async function signInWithKeypair(
  httpServer: import("http").Server,
  keypair: Keypair,
): Promise<request.Response> {
  const walletAddress = keypair.publicKey();

  const challengeResponse = await request(httpServer)
    .post("/api/v1/auth/challenge")
    .send({ walletAddress })
    .expect(201);

  const { id: challengeId, message } = challengeResponse.body as {
    id: string;
    message: string;
  };

  const signature = keypair.sign(sep53MessageHash(message)).toString("base64");

  return request(httpServer)
    .post("/api/v1/auth/verify")
    .send({ challengeId, walletAddress, signature });
}

/** Signs in as `keypair` and returns a live bearer token. */
export async function authenticateWallet(
  httpServer: import("http").Server,
  keypair: Keypair,
): Promise<AuthenticatedClient> {
  const verifyResponse = await signInWithKeypair(httpServer, keypair);
  if (verifyResponse.status !== 201) {
    throw new Error(`Wallet sign-in failed with HTTP ${verifyResponse.status}`);
  }

  const { user, session } = verifyResponse.body as {
    user: { id: string };
    session: { token: string; sessionId: string };
  };

  return {
    userId: user.id,
    walletAddress: keypair.publicKey(),
    token: session.token,
    sessionId: session.sessionId,
    keypair,
  };
}

/**
 * Registers (or logs back in as) a brand-new synthetic wallet and returns a
 * live bearer token, by actually calling `POST /auth/challenge` and
 * `POST /auth/verify` over HTTP.
 */
export async function authenticateNewWallet(
  httpServer: import("http").Server,
): Promise<AuthenticatedClient> {
  return authenticateWallet(httpServer, Keypair.random());
}
