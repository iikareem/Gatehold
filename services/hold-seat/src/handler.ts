import { randomUUID } from "crypto";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildHoldSeatsTransactWriteInput,
  getDocClient,
  holdExpiresAt,
  requireEnv,
} from "../../shared/src";

const AUTH_STUB_USER = "test-user";

/** Max seats per hold request (Phase 3 seatIds path). */
export const MAX_HOLD_SEATS = 8;

/**
 * Phase 3 — hold 1..MAX_HOLD_SEATS seats via TransactWriteItems.
 * Auth stub: X-User-Id header, else test-user (Cognito in Phase 9).
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const seatsTable = requireEnv("SEATS_TABLE_NAME");
  const eventId = event.pathParameters?.eventId;
  if (!eventId) {
    return json(400, { message: "missing eventId path parameter" });
  }

  const parsed = parseHoldBody(event.body);
  if (!parsed.ok) {
    return json(400, { message: parsed.message });
  }
  const { seatIds } = parsed;

  const holdOwner = headerValue(event, "x-user-id") || AUTH_STUB_USER;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = holdExpiresAt(nowMs);
  const holdId = `h_${randomUUID()}`;

  const transactInput = buildHoldSeatsTransactWriteInput({
    tableName: seatsTable,
    eventId,
    seatIds,
    holdId,
    holdOwner,
    expiresAt,
    now,
  });

  try {
    await getDocClient().send(new TransactWriteCommand(transactInput));
  } catch (err) {
    // TransactWrite cancels the whole txn; Step 3 will map this cleanly to 409.
    if (isTransactionCanceled(err) || isConditionalCheckFailed(err)) {
      return json(409, {
        message: "seat not available",
        eventId,
        seatIds,
      });
    }
    throw err;
  }

  return json(201, {
    holdId,
    seatIds,
    expiresAt,
  });
}

function parseHoldBody(
  body: string | null,
): { ok: true; seatIds: string[] } | { ok: false; message: string } {
  if (!body) {
    return { ok: false, message: "missing JSON body" };
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, message: "invalid JSON body" };
  }

  if (!data || typeof data !== "object") {
    return { ok: false, message: "body must be a JSON object" };
  }

  const seatIds = (data as { seatIds?: unknown }).seatIds;
  if (!Array.isArray(seatIds)) {
    return { ok: false, message: "seatIds must be an array" };
  }
  if (seatIds.length < 1 || seatIds.length > MAX_HOLD_SEATS) {
    return {
      ok: false,
      message: `seatIds length must be between 1 and ${MAX_HOLD_SEATS}`,
    };
  }
  for (let i = 0; i < seatIds.length; i++) {
    if (typeof seatIds[i] !== "string" || seatIds[i].length === 0) {
      return {
        ok: false,
        message: `seatIds[${i}] must be a non-empty string`,
      };
    }
  }

  return { ok: true, seatIds: seatIds as string[] };
}

function headerValue(
  event: APIGatewayProxyEvent,
  name: string,
): string | undefined {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value) {
      return value;
    }
  }
  return undefined;
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "ConditionalCheckFailedException";
}

function isTransactionCanceled(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "TransactionCanceledException";
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
