export type {
  SeatStatus,
  OrderStatus,
  EventStatus,
  IdempotencyStatus,
  EventItem,
  SeatItem,
  OrderItem,
  IdempotencyItem,
  OrderQueueMessage,
} from "./types";

export { requireEnv, optionalEnv } from "./env";
export { createDynamoDBClient, getDocClient } from "./dynamodb";
export { createSqsClient, getSqsClient } from "./sqs";
export {
  HOLD_DURATION_MS,
  buildHoldSeatUpdateInput,
  buildHoldSeatsTransactWriteInput,
  holdExpiresAt,
  type HoldSeatUpdateParams,
  type HoldSeatsTransactParams,
} from "./hold";
export {
  PAY_WINDOW_MS,
  IDEMPOTENCY_TTL_SECONDS,
  buildLockSeatForPaymentUpdateInput,
  buildCreateOrderTransactWriteInput,
  payUntilAt,
  idempotencyTtlEpoch,
  type LockSeatForPaymentParams,
  type CreateOrderTransactParams,
} from "./order";

/** Zero-pad a seat number so row range queries sort correctly (e.g. 7 → "07"). */
export function formatSeatId(
  section: string,
  row: string | number,
  seatNum: number,
  width = 2,
): string {
  return `${section}-${row}-${String(seatNum).padStart(width, "0")}`;
}
