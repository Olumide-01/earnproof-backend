/**
 * Deterministic mocked Stellar CLI responses for anchoring integration tests.
 *
 * These mocks cover:
 * - Successful registration response
 * - Successful revocation response
 * - Network error (connection refused/timeout)
 * - Invalid/malformed CLI response
 * - Transient error suitable for retry (vs permanent failure)
 */

export type MockCliResponse = { type: "success"; stdout: string } | { type: "error"; error: Error };

/**
 * Factory for a successful registration response.
 * Returns a transaction hash that can be parsed.
 */
export function mockSuccessfulRegistration(txHash: string = "deadbeefTXHASH"): MockCliResponse {
  return {
    type: "success",
    stdout: `Submitting transaction to testnet...\n${txHash}\n`,
  };
}

/**
 * Factory for a successful revocation response.
 */
export function mockSuccessfulRevocation(txHash: string = "deadbeefREVOKE"): MockCliResponse {
  return {
    type: "success",
    stdout: `Revoking proof...\n${txHash}\n`,
  };
}

/**
 * Factory for a successful status check response (read-only query).
 */
export function mockSuccessfulStatusCheck(result: boolean = false): MockCliResponse {
  return {
    type: "success",
    stdout: `${result ? "true" : "false"}\n`,
  };
}

/**
 * Network error: connection refused (transient, suitable for retry).
 */
export function mockNetworkError(): MockCliResponse {
  const error = Object.assign(new Error("Network error: connection refused"), {
    code: "ECONNREFUSED",
  });
  return { type: "error", error };
}

/**
 * Network error: timeout (transient, suitable for retry).
 */
export function mockTimeoutError(): MockCliResponse {
  const error = Object.assign(new Error("Command timed out after 120000ms"), {
    code: "ETIMEDOUT",
  });
  return { type: "error", error };
}

/**
 * Malformed/invalid CLI response (permanent failure).
 * Indicates the contract or account is misconfigured.
 */
export function mockInvalidContractError(): MockCliResponse {
  return {
    type: "error",
    error: new Error("Invalid contract id: contract not found on network"),
  };
}

/**
 * Permission error (permanent failure).
 */
export function mockUnauthorizedError(): MockCliResponse {
  return {
    type: "error",
    error: new Error("Unauthorized: account does not have permission to invoke this function"),
  };
}

/**
 * Proof already registered (permanent failure).
 * Indicates an idempotency issue.
 */
export function mockAlreadyRegisteredError(): MockCliResponse {
  return {
    type: "error",
    error: new Error("Contract error: proof already registered on this account"),
  };
}

/**
 * Generic transient server error (suitable for retry).
 */
export function mockTransientServerError(): MockCliResponse {
  return {
    type: "error",
    error: new Error("Server error: temporarily unable to process request, please retry"),
  };
}
