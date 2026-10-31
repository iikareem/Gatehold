import { randomUUID } from "crypto";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildHoldSeatsTransactWriteInput,
  callerUserId,
  DEFAULT_MAX_HOLD_SEATS,
  getDocClient,
  holdDurationMs,
  holdExpiresAt,
  maxHoldSeats,
  requireEnv,
} from "../../shared/src";

/** Default max seats (runtime cap comes from SSM via maxHoldSeats). */
export const MAX_HOLD_SEATS = DEFAULT_MAX_HOLD_SEATS;

/**
 * Phase 3 / 9d.3 / 11b — hold 1..N seats via TransactWriteItems.
 * Event must be ON_SALE (ConditionCheck). TTL + seat cap from SSM.
 * Identity: Cognito JWT `sub` from API Gateway authorizer (Phase 9b).
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const seatsTable = requireEnv("SEATS_TABLE_NAME");
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const eventId = event.pathParameters?.eventId;
  if (!eventId) {
    return json(400, { message: "missing eventId path parameter" });
  }

  const holdOwner = callerUserId(event);
  if (!holdOwner) {
    return json(401, { message: "unauthorized" });
  }

  const seatCap = await maxHoldSeats();
  const parsed = parseHoldBody(event.body, seatCap);
  if (!parsed.ok) {
    return json(400, { message: parsed.message });
  }
  const { seatIds } = parsed;

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const durationMs = await holdDurationMs();
  const expiresAt = holdExpiresAt(nowMs, durationMs);
  const holdId = `h_${randomUUID()}`;

  const transactInput = buildHoldSeatsTransactWriteInput({
    tableName: seatsTable,
    eventsTableName: eventsTable,
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
  maxSeats: number,
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
  if (seatIds.length < 1 || seatIds.length > maxSeats) {
    return {
      ok: false,
      message: `seatIds length must be between 1 and ${maxSeats}`,
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
