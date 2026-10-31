import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildCancelEventUpdateInput,
  getDocClient,
  isConditionalCheckFailed,
  requireEnv,
} from "../../shared/src";

/**
 * Phase 11b — POST /admin/events/{eventId}/cancel (`gatehold-*-cancel`).
 * AuthZ: admin TOKEN authorizer (9c). Conditional ON_SALE → CANCELLING.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const eventId = event.pathParameters?.eventId?.trim();
  if (!eventId) {
    return json(400, { message: "missing eventId path parameter" });
  }

  const cancelledAt = new Date().toISOString();

  try {
    await getDocClient().send(
      new UpdateCommand(
        buildCancelEventUpdateInput({
          tableName: eventsTable,
          eventId,
          cancelledAt,
        }),
      ),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return json(409, {
        message: "event not on sale",
        eventId,
      });
    }
    throw err;
  }

  return json(200, {
    eventId,
    status: "CANCELLING",
  });
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
