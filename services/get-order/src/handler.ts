import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  callerUserId,
  DEFAULT_TICKET_DOWNLOAD_TTL_SECONDS,
  getDocClient,
  presignTicketGetUrl,
  requireEnv,
  ticketObjectKey,
  type OrderItem,
} from "../../shared/src";

/**
 * Phase 10c — GET /orders/{orderId}.
 * Owner-only poll; when CONFIRMED, short-lived S3 GetObject URLs for tickets.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const ordersTable = requireEnv("ORDERS_TABLE_NAME");
  const ticketsBucket = requireEnv("TICKETS_BUCKET");

  const userId = callerUserId(event);
  if (!userId) {
    return json(401, { message: "unauthorized" });
  }

  const orderId = event.pathParameters?.orderId;
  if (!orderId) {
    return json(400, { message: "missing orderId path parameter" });
  }

  const result = await getDocClient().send(
    new GetCommand({
      TableName: ordersTable,
      Key: { orderId },
    }),
  );
  const order = result.Item as OrderItem | undefined;

  // Same 404 for missing and non-owner — do not leak order existence.
  if (!order || order.userId !== userId) {
    return json(404, { message: "order not found" });
  }

  const body: Record<string, unknown> = {
    orderId: order.orderId,
    status: order.status,
    eventId: order.eventId,
    holdId: order.holdId,
    seatIds: order.seatIds,
    createdAt: order.createdAt,
  };

  if (order.amount != null) {
    body.amount = order.amount;
  }
  if (order.ticketIds != null) {
    body.ticketIds = order.ticketIds;
  }
  if (order.failReason != null) {
    body.failReason = order.failReason;
  }

  if (
    order.status === "CONFIRMED" &&
    Array.isArray(order.ticketIds) &&
    order.ticketIds.length > 0
  ) {
    const expiresInSeconds = DEFAULT_TICKET_DOWNLOAD_TTL_SECONDS;
    const tickets = await Promise.all(
      order.ticketIds.map(async (ticketId) => ({
        ticketId,
        downloadUrl: await presignTicketGetUrl({
          bucket: ticketsBucket,
          key: ticketObjectKey(ticketId),
          expiresInSeconds,
        }),
        expiresInSeconds,
      })),
    );
    body.tickets = tickets;
  }

  return json(200, body);
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
