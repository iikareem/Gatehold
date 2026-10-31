/**
 * Events table builders — cancel / terminal status (Phase 11).
 */

export interface CancelEventUpdateParams {
  tableName: string;
  eventId: string;
  /** ISO-8601; defaults to now when omitted. */
  cancelledAt?: string;
}

/**
 * ON_SALE → CANCELLING. Sets cancelledAt.
 * Condition fails if missing or not ON_SALE → API 409.
 */
export function buildCancelEventUpdateInput(params: CancelEventUpdateParams) {
  const cancelledAt = params.cancelledAt ?? new Date().toISOString();

  return {
    TableName: params.tableName,
    Key: { eventId: params.eventId },
    UpdateExpression: "SET #status = :cancelling, cancelledAt = :cancelledAt",
    ConditionExpression: "attribute_exists(eventId) AND #status = :onSale",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":cancelling": "CANCELLING",
      ":onSale": "ON_SALE",
      ":cancelledAt": cancelledAt,
    },
  };
}

export interface AttachRefundBatchUpdateParams {
  tableName: string;
  eventId: string;
  refundBatchId: string;
}

/**
 * Set refundBatchId while event is CANCELLING and batch id is unset.
 * Orchestrator claims after create; ConditionalCheckFailed → another writer won.
 */
export function buildAttachRefundBatchUpdateInput(
  params: AttachRefundBatchUpdateParams,
) {
  return {
    TableName: params.tableName,
    Key: { eventId: params.eventId },
    UpdateExpression: "SET refundBatchId = :batchId",
    ConditionExpression:
      "attribute_exists(eventId) AND #status = :cancelling AND attribute_not_exists(refundBatchId)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":batchId": params.refundBatchId,
      ":cancelling": "CANCELLING",
    },
  };
}

export interface MarkEventCancelledUpdateParams {
  tableName: string;
  eventId: string;
}

/**
 * CANCELLING → CANCELLED when the refund batch is drained.
 */
export function buildMarkEventCancelledUpdateInput(
  params: MarkEventCancelledUpdateParams,
) {
  return {
    TableName: params.tableName,
    Key: { eventId: params.eventId },
    UpdateExpression: "SET #status = :cancelled",
    ConditionExpression:
      "attribute_exists(eventId) AND (#status = :cancelling OR #status = :cancelled)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":cancelled": "CANCELLED",
      ":cancelling": "CANCELLING",
    },
  };
}
