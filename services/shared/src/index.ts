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
  TicketedSagaState,
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
  placeholderTicketId,
  placeholderTicketIds,
} from "./types";

export { requireEnv, optionalEnv } from "./env";
export { callerUserId, hasAdminGroup, ADMIN_GROUP_NAME } from "./auth";
export { createDynamoDBClient, getDocClient } from "./dynamodb";
export { createSqsClient, getSqsClient } from "./sqs";
export { createSfnClient, getSfnClient } from "./sfn";
export { createCognitoIdpClient } from "./cognito";
export {
  createSecretsManagerClient,
  getSecretString,
  mockPaymentBaseUrl,
} from "./secrets";
export {
  createSsmClient,
  getParameterString,
  holdDurationMs,
  maxHoldSeats,
  DEFAULT_MAX_HOLD_SEATS,
} from "./ssm";
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
  buildIssueTicketsUpdateInput,
  buildMarkConfirmedUpdateInput,
  buildReleaseSeatUpdateInput,
  buildReleaseSeatsTransactWriteInput,
  buildMarkFailedUpdateInput,
  buildMarkRefundedUpdateInput,
  payUntilAt,
  idempotencyTtlEpoch,
  type LockSeatForPaymentParams,
  type CreateOrderTransactParams,
  type ConfirmSeatUpdateParams,
  type ConfirmSeatsTransactParams,
  type IssueTicketsUpdateParams,
  type MarkConfirmedUpdateParams,
  type ReleaseSeatUpdateParams,
  type ReleaseSeatsTransactParams,
  type MarkFailedUpdateParams,
  type MarkRefundedUpdateParams,
} from "./order";
export {
  buildAppendLedgerPutInput,
  appendLedgerItem,
  buildLedgerItem,
  isConditionalCheckFailed,
  type AppendLedgerParams,
} from "./ledger";
export {
  TICKET_SIGNING_ALGORITHM,
  buildTicketPayload,
  ticketObjectKey,
  ticketSigningMessage,
  type TicketPayload,
  type TicketArtifact,
  type BuildTicketPayloadParams,
} from "./ticket";
export {
  authorizeWithProvider,
  captureWithProvider,
  voidWithProvider,
  refundWithProvider,
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
