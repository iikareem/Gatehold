import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient } from "./dynamodb";
import { verifyTicketMessage } from "./kms";
import {
  ticketSigningMessage,
  type TicketArtifact,
  type TicketPayload,
} from "./ticket";
import type { EventItem } from "./types";

export type TicketVerifyRejectReason =
  | "invalid_signature"
  | "event_cancelled"
  | "event_not_found";

export type TicketVerifyResult =
  | { valid: true; payload: TicketPayload }
  | { valid: false; reason: TicketVerifyRejectReason };

/**
 * Gate check (Phase 10d): KMS.Verify then event status ≠ CANCELLED.
 * Signature OK is not enough — a cancelled show must still reject.
 */
export async function verifyTicketArtifact(
  params: {
    artifact: TicketArtifact;
    keyId: string;
    eventsTableName: string;
  },
): Promise<TicketVerifyResult> {
  const { artifact, keyId, eventsTableName } = params;
  const { payload, signature } = artifact;

  const message = ticketSigningMessage(payload);
  const signatureOk = await verifyTicketMessage(keyId, message, signature);
  if (!signatureOk) {
    return { valid: false, reason: "invalid_signature" };
  }

  const result = await getDocClient().send(
    new GetCommand({
      TableName: eventsTableName,
      Key: { eventId: payload.eventId },
    }),
  );
  const event = result.Item as EventItem | undefined;
  if (!event) {
    return { valid: false, reason: "event_not_found" };
  }
  if (event.status === "CANCELLED") {
    return { valid: false, reason: "event_cancelled" };
  }

  return { valid: true, payload };
}

/** True when value looks like a TicketPayload (all required string fields). */
export function isTicketPayload(value: unknown): value is TicketPayload {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.ticketId === "string" &&
    o.ticketId.length > 0 &&
    typeof o.orderId === "string" &&
    o.orderId.length > 0 &&
    typeof o.eventId === "string" &&
    o.eventId.length > 0 &&
    typeof o.seatId === "string" &&
    o.seatId.length > 0 &&
    typeof o.userId === "string" &&
    o.userId.length > 0
  );
}
