import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient, requireEnv } from "../../shared/src";

/**
 * Phase 0 health / smoke Lambda.
 * GET /health — liveness + table names
 * GET /health?eventId=&seatId= — proves DynamoDB read path
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const stage = process.env.STAGE || "dev";
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const seatsTable = requireEnv("SEATS_TABLE_NAME");

  const qs = event.queryStringParameters || {};
  const eventId = qs.eventId;
  const seatId = qs.seatId;

  if (eventId && seatId) {
    const result = await getDocClient().send(
      new GetCommand({
        TableName: seatsTable,
        Key: { eventId, seatId },
      }),
    );

    if (!result.Item) {
      return json(404, {
        ok: false,
        message: "seat not found",
        eventId,
        seatId,
      });
    }

    return json(200, {
      ok: true,
      stage,
      seat: result.Item,
    });
  }

  return json(200, {
    ok: true,
    stage,
    tables: {
      events: eventsTable,
      seats: seatsTable,
    },
    hint: "Pass ?eventId=evt_001&seatId=A-12-01 after seeding to verify DynamoDB",
  });
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
