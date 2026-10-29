import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { requireEnv } from "./env";

/**
 * Secrets Manager client that honors AWS_ENDPOINT_URL (MiniStack / local emulator).
 * On real AWS, leave AWS_ENDPOINT_URL unset.
 */
export function createSecretsManagerClient(): SecretsManagerClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  return new SecretsManagerClient({
    region,
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
          },
        }
      : {}),
  });
}

let cachedClient: SecretsManagerClient | undefined;
const secretStringCache = new Map<string, string>();

function getSecretsClient(): SecretsManagerClient {
  if (!cachedClient) {
    cachedClient = createSecretsManagerClient();
  }
  return cachedClient;
}

/** Fetch a secret string once per cold start (cached by secret id). */
export async function getSecretString(secretId: string): Promise<string> {
  const cached = secretStringCache.get(secretId);
  if (cached !== undefined) return cached;

  const result = await getSecretsClient().send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  if (!result.SecretString || result.SecretString.length === 0) {
    throw new Error(`secret ${secretId} has empty SecretString`);
  }
  secretStringCache.set(secretId, result.SecretString);
  return result.SecretString;
}

/**
 * Mock payment provider base URL.
 *
 * Deployed Lambdas use MOCK_PAYMENT_SECRET_ARN (Secrets Manager).
 * MOCK_PAYMENT_URL remains a unit-test / local override when set.
 */
export async function mockPaymentBaseUrl(): Promise<string> {
  const override = process.env.MOCK_PAYMENT_URL?.trim();
  if (override) {
    return override.replace(/\/$/, "");
  }
  const secretId = requireEnv("MOCK_PAYMENT_SECRET_ARN");
  const value = await getSecretString(secretId);
  return value.replace(/\/$/, "");
}

/** Test helper — clear module caches between cases. */
export function resetSecretsCacheForTests(): void {
  cachedClient = undefined;
  secretStringCache.clear();
}
