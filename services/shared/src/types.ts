/** Shared domain types — keep in sync with docs/contracts.md */

export type SeatStatus = "AVAILABLE" | "HELD" | "PAYING" | "SOLD";

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "FAILED"
  | "REFUND_PENDING"
  | "REFUNDED";

export type EventStatus = "ON_SALE" | "CANCELLING" | "CANCELLED";

/** Idempotency record for POST /orders accept — not order confirmation. */
export type IdempotencyStatus = "IN_PROGRESS" | "ACCEPTED";

export interface EventItem {
  eventId: string;
  status: EventStatus;
  name: string;
  createdAt: string;
  cancelledAt?: string;
  refundBatchId?: string;
}

export interface SeatItem {
  eventId: string;
  seatId: string;
  status: SeatStatus;
  section: string;
  row: string;
  holdId?: string;
  holdOwner?: string;
  expiresAt?: string;
  payUntil?: string;
  orderId?: string;
  version: number;
}

export interface OrderItem {
  orderId: string;
  userId: string;
  eventId: string;
  holdId: string;
  seatIds: string[];
  status: OrderStatus;
  idempotencyKey: string;
  createdAt: string;
  amount?: number;
  executionArn?: string;
  failReason?: string;
  /** Placeholder ticket ids until Phase 9 KMS/S3 issuance. */
  ticketIds?: string[];
}

export interface IdempotencyItem {
  key: string;
  status: IdempotencyStatus;
  responseStatus?: number;
  /** JSON string of the stored HTTP response body when status is ACCEPTED. */
  responseBody?: string;
  orderId?: string;
  /** Epoch seconds — DynamoDB TTL. */
  ttl?: number;
}

/**
 * Phase 4+ order queue payload.
 * Phase 6: same shape is the Step Functions execution input (starter passes body through).
 */
export interface OrderQueueMessage {
  orderId: string;
  eventId: string;
  holdId: string;
  seatIds: string[];
  userId: string;
}

/** Alias — saga starts with the SQS message body. */
export type SagaInput = OrderQueueMessage;

/**
 * Saga state after AuthorizePayment — passed to ConfirmSeat / Capture / etc.
 */
export interface AuthorizedSagaState extends SagaInput {
  amount: number;
  currency: string;
  authorizationId: string;
  providerPaymentId?: string;
}

/**
 * Saga state after IssueTicket stub — placeholder ids until Phase 9.
 */
export interface TicketedSagaState extends AuthorizedSagaState {
  ticketIds: string[];
}

/** Append-only payment ledger kinds — keep in sync with docs/contracts.md. */
export type LedgerKind = "AUTH" | "CAPTURE" | "VOID" | "REFUND";

/**
 * One money event in `gatehold-{stage}-ledger`.
 * `pk` is the provider idempotency key (e.g. `pay:auth:{orderId}`).
 */
export interface LedgerItem {
  pk: string;
  kind: LedgerKind;
  orderId: string;
  amount: number;
  currency: string;
  providerPaymentId?: string;
  authorizationId?: string;
  createdAt: string;
}

/** Default authorize/capture amount (cents) until pricing exists. */
export const DEFAULT_ORDER_AMOUNT_CENTS = 5000;

export const LEDGER_CURRENCY_USD = "USD";

/** Payment idempotency key helpers — same formats as mock-payment contracts. */
export function paymentAuthKey(orderId: string): string {
  return `pay:auth:${orderId}`;
}

export function paymentCaptureKey(orderId: string): string {
  return `pay:capture:${orderId}`;
}

export function paymentVoidKey(orderId: string): string {
  return `pay:void:${orderId}`;
}

export function paymentRefundKey(orderId: string): string {
  return `pay:refund:${orderId}`;
}

/** Deterministic placeholder ticket id (Phase 6 stub; Phase 9 replaces with signed artifacts). */
export function placeholderTicketId(orderId: string, seatId: string): string {
  return `tkt:${orderId}:${seatId}`;
}

export function placeholderTicketIds(
  orderId: string,
  seatIds: string[],
): string[] {
  return seatIds.map((seatId) => placeholderTicketId(orderId, seatId));
}
