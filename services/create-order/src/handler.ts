import { randomUUID } from "crypto";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  buildCreateOrderTransactWriteInput,
  callerUserId,
  getDocClient,
  getSqsClient,
  idempotencyTtlEpoch,
  payUntilAt,
  requireEnv,
  type IdempotencyItem,
  type OrderQueueMessage,
} from "../../shared/src";

/** Max seats per order (same cap as holds). */
export const MAX_ORDER_SEATS = 8;

/**
 * Phase 4 — accept order: claim idempotency, lock seats PAYING, create PENDING,
 * enqueue SQS, return 202. Identity: Cognito JWT `sub` from authorizer (9b).
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const seatsTable = requireEnv("SEATS_TABLE_NAME");
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");
  const idempotencyTable = requireEnv("IDEMPOTENCY_TABLE_NAME");
  const orderQueueUrl = requireEnv("ORDER_QUEUE_URL");

  const userId = callerUserId(event);
  if (!userId) {
    return json(401, { message: "unauthorized" });
  }

  const idempotencyKey = headerValue(event, "idempotency-key");
  if (!idempotencyKey) {
    return json(400, { message: "missing Idempotency-Key header" });
  }

  const parsed = parseOrderBody(event.body);
  if (!parsed.ok) {
    return json(400, { message: parsed.message });
  }
  const { eventId, holdId, seatIds } = parsed;

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const payUntil = payUntilAt(nowMs);
  const orderId = `ord_${randomUUID()}`;
  const ttl = idempotencyTtlEpoch(nowMs);

  const transactInput = buildCreateOrderTransactWriteInput({
    seatsTableName: seatsTable,
    eventsTableName: eventsTable,
    ordersTableName: ordersTable,
    idempotencyTableName: idempotencyTable,
    idempotencyKey,
    orderId,
    userId,
    eventId,
    holdId,
    seatIds,
    now,
    payUntil,
    ttl,
  });

  try {
    await getDocClient().send(new TransactWriteCommand(transactInput));
  } catch (err) {
    if (isTransactionCanceled(err) || isConditionalCheckFailed(err)) {
      if (isIdempotencyClaimConflict(err)) {
        return respondForExistingIdempotency(idempotencyTable, idempotencyKey);
      }
      return json(409, {
        message: "order not acceptable",
        eventId,
        holdId,
        seatIds,
      });
    }
    throw err;
  }

  const responseBody = { orderId, status: "PENDING" as const };
  const queueMessage: OrderQueueMessage = {
    orderId,
    eventId,
    holdId,
    seatIds,
    userId,
  };

  try {
    await getSqsClient().send(
      new SendMessageCommand({
        QueueUrl: orderQueueUrl,
        MessageBody: JSON.stringify(queueMessage),
      }),
    );
  } catch {
    // Txn committed; leave idempotency IN_PROGRESS so client can retry same key.
    return json(500, { message: "failed to enqueue order", orderId });
  }

  await markIdempotencyAccepted(
    idempotencyTable,
    idempotencyKey,
    202,
    responseBody,
  );

  return json(202, responseBody);
}

async function respondForExistingIdempotency(
  tableName: string,
  key: string,
): Promise<APIGatewayProxyResult> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { key },
    }),
  );
  const item = result.Item as IdempotencyItem | undefined;

  if (!item) {
    return json(409, { message: "idempotency conflict" });
  }

  if (item.status === "ACCEPTED" && item.responseBody != null) {
    const statusCode = item.responseStatus ?? 202;
    return {
      statusCode,
      headers: { "content-type": "application/json" },
      body: item.responseBody,
    };
  }

  return json(409, { message: "in progress", orderId: item.orderId });
}

async function markIdempotencyAccepted(
  tableName: string,
  key: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  try {
    await getDocClient().send(
      new UpdateCommand({
        TableName: tableName,
        Key: { key },
        UpdateExpression:
          "SET #status = :accepted, responseStatus = :responseStatus, responseBody = :responseBody",
        ConditionExpression: "#status = :inProgress",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":accepted": "ACCEPTED",
          ":inProgress": "IN_PROGRESS",
          ":responseStatus": responseStatus,
          ":responseBody": JSON.stringify(responseBody),
        },
      }),
    );
  } catch (err) {
    // SQS already sent; still return 202 to the client.
    if (!isConditionalCheckFailed(err)) {
      throw err;
    }
  }
}

function parseOrderBody(
  body: string | null,
):

  | { ok: true; eventId: string; holdId: string; seatIds: string[] }
  | { ok: false; message: string } {
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

  const obj = data as {
    eventId?: unknown;
    holdId?: unknown;
    seatIds?: unknown;
  };

  if (typeof obj.eventId !== "string" || obj.eventId.length === 0) {
    return { ok: false, message: "eventId must be a non-empty string" };
  }
  if (typeof obj.holdId !== "string" || obj.holdId.length === 0) {
    return { ok: false, message: "holdId must be a non-empty string" };
  }

  const seatIds = obj.seatIds;
  if (!Array.isArray(seatIds)) {
    return { ok: false, message: "seatIds must be an array" };
  }
  if (seatIds.length < 1 || seatIds.length > MAX_ORDER_SEATS) {
    return {
      ok: false,
      message: `seatIds length must be between 1 and ${MAX_ORDER_SEATS}`,
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

  return {
    ok: true,
    eventId: obj.eventId,
    holdId: obj.holdId,
    seatIds: seatIds as string[],
  };
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
  return (err as { name?: string }).name === "ConditionalCheckFailedException";
}

function isTransactionCanceled(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "TransactionCanceledException";
}

/** First TransactItem is the idempotency Put — its condition fail means duplicate key. */
function isIdempotencyClaimConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const reasons = (
    err as { CancellationReasons?: Array<{ Code?: string } | undefined> }
  ).CancellationReasons;
  if (!Array.isArray(reasons) || reasons.length === 0) {
    // No reasons attached — treat generic cancel as non-idempotency (409 seat/event).
    return false;
  }
  return reasons[0]?.Code === "ConditionalCheckFailed";
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
