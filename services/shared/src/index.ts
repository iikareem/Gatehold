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
  SagaInput,
  AuthorizedSagaState,
  LedgerKind,
  LedgerItem,
} from "./types";

export {
  DEFAULT_ORDER_AMOUNT_CENTS,
  LEDGER_CURRENCY_USD,
  paymentAuthKey,
  paymentCaptureKey,
  paymentVoidKey,
  paymentRefundKey,
} from "./types";

export { requireEnv, optionalEnv } from "./env";
export { createDynamoDBClient, getDocClient } from "./dynamodb";
export { createSqsClient, getSqsClient } from "./sqs";
export { createSfnClient, getSfnClient } from "./sfn";
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
  buildConfirmSeatUpdateInput,
  buildConfirmSeatsTransactWriteInput,
  payUntilAt,
  idempotencyTtlEpoch,
  type LockSeatForPaymentParams,
  type CreateOrderTransactParams,
  type ConfirmSeatUpdateParams,
  type ConfirmSeatsTransactParams,
} from "./order";
export {
  buildAppendLedgerPutInput,
  appendLedgerItem,
  buildLedgerItem,
  isConditionalCheckFailed,
  type AppendLedgerParams,
} from "./ledger";
export {
  authorizeWithProvider,
  captureWithProvider,
  isRetryablePaymentStatus,
  PaymentProviderError,
  type AuthorizePaymentRequest,
  type FollowUpPaymentRequest,
  type PaymentProviderResponse,
} from "./payment";

/** Zero-pad a seat number so row range queries sort correctly (e.g. 7 → "07"). */
export function formatSeatId(
  section: string,
  row: string | number,
  seatNum: number,
  width = 2,
): string {
  return `${section}-${row}-${String(seatNum).padStart(width, "0")}`;
}
