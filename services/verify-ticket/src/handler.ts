import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import {
  isTicketPayload,
  requireEnv,
  verifyTicketArtifact,
  type TicketArtifact,
} from "../../shared/src";

/**
 * Phase 10d — POST /tickets/verify (simulated gate scanner).
 * Body: `{ payload, signature }` from the S3 ticket artifact / QR.
 * No Cognito — crypto + event status are the gate checks.
 */
export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const eventsTable = requireEnv("EVENTS_TABLE_NAME");
  const keyId = requireEnv("TICKET_SIGNING_KEY_ID");

  const parsed = parseVerifyBody(event.body);
  if (!parsed.ok) {
    return json(400, { message: parsed.message });
  }

  const result = await verifyTicketArtifact({
    artifact: parsed.artifact,
    keyId,
    eventsTableName: eventsTable,
  });

  if (result.valid) {
    return json(200, {
      valid: true,
      ticketId: result.payload.ticketId,
      eventId: result.payload.eventId,
      seatId: result.payload.seatId,
      orderId: result.payload.orderId,
    });
  }

  return json(200, {
    valid: false,
    reason: result.reason,
  });
}

function parseVerifyBody(
  body: string | null,
):
  | { ok: true; artifact: TicketArtifact }
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

  const obj = data as { payload?: unknown; signature?: unknown };
  if (!isTicketPayload(obj.payload)) {
    return {
      ok: false,
      message:
        "payload must include non-empty ticketId, orderId, eventId, seatId, userId",
    };
  }
  if (typeof obj.signature !== "string" || obj.signature.length === 0) {
    return { ok: false, message: "signature must be a non-empty string" };
  }

  return {
    ok: true,
    artifact: { payload: obj.payload, signature: obj.signature },
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
