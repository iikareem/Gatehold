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

/** Phase 4 order queue payload (no consumer yet). */
export interface OrderQueueMessage {
  orderId: string;
  eventId: string;
  holdId: string;
  seatIds: string[];
  userId: string;
}
