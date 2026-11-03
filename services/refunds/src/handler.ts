import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  getDocClient,
  requireEnv,
  type EventItem,
  type RefundBatchItem,
} from "../../shared/src";

/**
 * Phase 11e — GET /admin/events/{eventId}/refunds (`gatehold-*-refunds`).
 * AuthZ: admin TOKEN authorizer (9c).
 * Loads event.refundBatchId → RefundBatch counters/status.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const refundBatchesTable = requireEnv("REFUND_BATCHES_TABLE_NAME");
  const eventId = event.pathParameters?.eventId?.trim();
  if (!eventId) {
    return json(400, { message: "missing eventId path parameter" });
  }

  const eventItem = await getEvent(eventsTable, eventId);
  if (!eventItem) {
    return json(404, { message: "event not found", eventId });
  }

  const batchId = eventItem.refundBatchId;
  if (!batchId) {
    return json(200, {
      eventId,
      eventStatus: eventItem.status,
      batch: null,
    });
  }

  const batch = await getBatch(refundBatchesTable, batchId);
  if (!batch) {
    return json(200, {
      eventId,
      eventStatus: eventItem.status,
      batchId,
      batch: null,
      message: "refund batch not found",
    });
  }

  return json(200, {
    eventId,
    eventStatus: eventItem.status,
    batchId: batch.batchId,
    status: batch.status,
    enqueued: batch.enqueued ?? 0,
    succeeded: batch.succeeded ?? 0,
    failed: batch.failed ?? 0,
    fanOutComplete: batch.fanOutComplete === true,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt ?? null,
  });
}

async function getEvent(
  tableName: string,
  eventId: string,
): Promise<EventItem | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { eventId },
    }),
  );
  return out.Item as EventItem | undefined;
}

async function getBatch(
  tableName: string,
  batchId: string,
): Promise<RefundBatchItem | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: tableName,
      Key: { batchId },
    }),
  );
  return out.Item as RefundBatchItem | undefined;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
