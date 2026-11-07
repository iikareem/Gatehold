import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  getDocClient,
  requireEnv,
  type EventItem,
} from "../../shared/src";

/**
 * Catalog — GET /events/{eventId}.
 * Public (no Cognito). Event name + sale status for the seat-map UI.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const eventId = event.pathParameters?.eventId?.trim();
  if (!eventId) {
    return json(400, { message: "missing eventId path parameter" });
  }

  const result = await getDocClient().send(
    new GetCommand({
      TableName: eventsTable,
      Key: { eventId },
    }),
  );
  const item = result.Item as EventItem | undefined;
  if (!item) {
    return json(404, { message: "event not found", eventId });
  }

  const body: Record<string, unknown> = {
    eventId: item.eventId,
    name: item.name,
    status: item.status,
    createdAt: item.createdAt,
  };
  if (item.cancelledAt != null) {
    body.cancelledAt = item.cancelledAt;
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
