/** Shared domain types — keep in sync with docs/contracts.md */

export type SeatStatus = "AVAILABLE" | "HELD" | "PAYING" | "SOLD";

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "FAILED"
  | "REFUND_PENDING"
  | "REFUNDED";

export type EventStatus = "ON_SALE" | "CANCELLING" | "CANCELLED";

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
