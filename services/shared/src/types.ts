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
  /** Ticket ids pointing at S3 artifacts (`tickets/{ticketId}.json`). */
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
 * Saga state after IssueTicket — ticketIds for signed S3 artifacts (Phase 10b).
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

/** Refund batch lifecycle — keep in sync with docs/contracts.md Phase 11. */
export type RefundBatchStatus =
  | "RUNNING"
  | "COMPLETE"
  | "COMPLETE_WITH_FAILURES";

/**
 * One cancel/mass-refund run in `gatehold-{stage}-refund-batches`.
 * Counters use atomic ADD from orchestrator / workers.
 */
export interface RefundBatchItem {
  batchId: string;
  eventId: string;
  status: RefundBatchStatus;
  enqueued: number;
  succeeded: number;
  failed: number;
  startedAt: string;
  finishedAt?: string;
  /** Opaque DynamoDB Query ExclusiveStartKey for orders GSI resume. */
  lastEvaluatedKey?: Record<string, unknown>;
  fanOutComplete?: boolean;
  reportKey?: string;
}

/**
 * Phase 11 refund queue payload — one paid order per message.
 * Worker loads authorizationId / amount from ledger CAPTURE.
 */
export interface RefundQueueMessage {
  orderId: string;
  eventId: string;
  batchId: string;
}

/** Default authorize/capture amount (cents) until pricing exists. */
export const DEFAULT_ORDER_AMOUNT_CENTS = 5000;

export const LEDGER_CURRENCY_USD = "USD";

/** Orders GSI used by cancel fan-out (PK eventId, SK status). */
export const ORDERS_EVENT_STATUS_INDEX = "eventId-status";

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

/**
 * Deterministic ticket id `tkt:{orderId}:{seatId}`.
 * Phase 6 wrote ids only; Phase 10 signs a payload and stores the artifact in S3 under this id.
 */
export function placeholderTicketId(orderId: string, seatId: string): string {
  return `tkt:${orderId}:${seatId}`;
}

export function placeholderTicketIds(
  orderId: string,
  seatIds: string[],
): string[] {
  return seatIds.map((seatId) => placeholderTicketId(orderId, seatId));
}
