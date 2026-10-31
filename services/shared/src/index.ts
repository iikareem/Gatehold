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
  RefundBatchStatus,
  RefundBatchItem,
  RefundQueueMessage,
} from "./types";

export {
  DEFAULT_ORDER_AMOUNT_CENTS,
  LEDGER_CURRENCY_USD,
  ORDERS_EVENT_STATUS_INDEX,
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
export {
  createKmsClient,
  getKmsClient,
  signTicketMessage,
  verifyTicketMessage,
} from "./kms";
export {
  createS3Client,
  getS3Client,
  putTicketArtifact,
  presignTicketGetUrl,
  DEFAULT_TICKET_DOWNLOAD_TTL_SECONDS,
} from "./s3";
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
  buildClaimCancelRefundUpdateInput,
  buildCompleteCancelRefundUpdateInput,
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
  type ClaimCancelRefundUpdateParams,
  type CompleteCancelRefundUpdateParams,
} from "./order";
export {
  buildCancelEventUpdateInput,
  buildAttachRefundBatchUpdateInput,
  buildMarkEventCancelledUpdateInput,
  type CancelEventUpdateParams,
  type AttachRefundBatchUpdateParams,
  type MarkEventCancelledUpdateParams,
} from "./event";
export {
  buildCreateRefundBatchPutInput,
  buildRefundBatchCheckpointUpdateInput,
  buildRefundBatchCounterUpdateInput,
  buildCompleteRefundBatchUpdateInput,
  type CreateRefundBatchPutParams,
  type RefundBatchCheckpointUpdateParams,
  type RefundBatchCounterUpdateParams,
  type RefundBatchCounterKind,
  type CompleteRefundBatchUpdateParams,
} from "./refund-batch";
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
  verifyTicketArtifact,
  isTicketPayload,
  type TicketVerifyRejectReason,
  type TicketVerifyResult,
} from "./ticket-verify";
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
