import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

/**
 * Phase 9c — GET /admin/events/{eventId}/refunds (`gatehold-*-refunds`).
 * AuthZ is enforced by the admin TOKEN authorizer (admin group).
 * Behavior lands in Phase 11; return 501 until then.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const eventId = event.pathParameters?.eventId;
  return {
    statusCode: 501,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "not implemented",
      operation: "refunds",
      eventId: eventId ?? null,
      phase: 11,
    }),
  };
}
