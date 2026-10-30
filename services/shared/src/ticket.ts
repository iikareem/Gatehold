import { placeholderTicketId } from "./types";

/**
 * Canonical ticket payload (Phase 10).
 * Signed with KMS SIGN_VERIFY; stored with signature in S3.
 */
export interface TicketPayload {
  ticketId: string;
  orderId: string;
  eventId: string;
  seatId: string;
  userId: string;
}

/** S3 object body: readable payload + base64 signature (no keys). */
export interface TicketArtifact {
  payload: TicketPayload;
  /** Base64-encoded KMS signature over {@link ticketSigningMessage}. */
  signature: string;
}

export interface BuildTicketPayloadParams {
  orderId: string;
  eventId: string;
  seatId: string;
  userId: string;
  /** Defaults to `tkt:{orderId}:{seatId}`. */
  ticketId?: string;
}

/** S3 object key for a ticket artifact. */
export function ticketObjectKey(ticketId: string): string {
  return `tickets/${ticketId}.json`;
}

/** Build payload with deterministic ticketId. */
export function buildTicketPayload(
  params: BuildTicketPayloadParams,
): TicketPayload {
  const { orderId, eventId, seatId, userId } = params;
  const ticketId = params.ticketId ?? placeholderTicketId(orderId, seatId);
  return { ticketId, orderId, eventId, seatId, userId };
}

/**
 * Deterministic UTF-8 message for KMS Sign / Verify.
 * Fixed key order — do not JSON.stringify the object with arbitrary order.
 */
export function ticketSigningMessage(payload: TicketPayload): string {
  return JSON.stringify({
    ticketId: payload.ticketId,
    orderId: payload.orderId,
    eventId: payload.eventId,
    seatId: payload.seatId,
    userId: payload.userId,
  });
}

/** KMS SigningAlgorithm for RSA_2048 SIGN_VERIFY keys (contracts.md). */
export const TICKET_SIGNING_ALGORITHM =
  "RSASSA_PSS_SHA_256" as const;
