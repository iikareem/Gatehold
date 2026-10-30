import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { HOLD_DURATION_MS } from "./hold";

/** Default max seats per hold/order (matches Config / contracts). */
export const DEFAULT_MAX_HOLD_SEATS = 8;

/**
 * SSM client that honors AWS_ENDPOINT_URL (MiniStack / local emulator).
 * On real AWS, leave AWS_ENDPOINT_URL unset.
 */
export function createSsmClient(): SSMClient {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

  return new SSMClient({
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

let cachedClient: SSMClient | undefined;
const parameterCache = new Map<string, string>();

function getSsmClient(): SSMClient {
  if (!cachedClient) {
    cachedClient = createSsmClient();
  }
  return cachedClient;
}

/** Fetch a String parameter once per cold start (cached by name). */
export async function getParameterString(name: string): Promise<string> {
  const cached = parameterCache.get(name);
  if (cached !== undefined) return cached;

  const result = await getSsmClient().send(
    new GetParameterCommand({ Name: name }),
  );
  const value = result.Parameter?.Value;
  if (!value || value.length === 0) {
    throw new Error(`SSM parameter ${name} has empty Value`);
  }
  parameterCache.set(name, value);
  return value;
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * Hold duration in milliseconds.
 *
 * Deployed: HOLD_TTL_MS_PARAM_NAME → SSM GetParameter (cached).
 * Unit tests: HOLD_DURATION_MS override, or default HOLD_DURATION_MS when unset.
 */
export async function holdDurationMs(): Promise<number> {
  const override = process.env.HOLD_DURATION_MS?.trim();
  if (override) {
    return parsePositiveInt(override, "HOLD_DURATION_MS");
  }
  const paramName = process.env.HOLD_TTL_MS_PARAM_NAME?.trim();
  if (!paramName) {
    return HOLD_DURATION_MS;
  }
  const value = await getParameterString(paramName);
  return parsePositiveInt(value, paramName);
}

/**
 * Max seats per hold / order.
 *
 * Deployed: MAX_HOLD_SEATS_PARAM_NAME → SSM GetParameter (cached).
 * Unit tests: MAX_HOLD_SEATS override, or DEFAULT_MAX_HOLD_SEATS when unset.
 */
export async function maxHoldSeats(): Promise<number> {
  const override = process.env.MAX_HOLD_SEATS?.trim();
  if (override) {
    return parsePositiveInt(override, "MAX_HOLD_SEATS");
  }
  const paramName = process.env.MAX_HOLD_SEATS_PARAM_NAME?.trim();
  if (!paramName) {
    return DEFAULT_MAX_HOLD_SEATS;
  }
  const value = await getParameterString(paramName);
  return parsePositiveInt(value, paramName);
}

/** Test helper — clear module caches between cases. */
export function resetSsmCacheForTests(): void {
  cachedClient = undefined;
  parameterCache.clear();
}
