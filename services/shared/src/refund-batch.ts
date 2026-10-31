import type { RefundBatchItem, RefundBatchStatus } from "./types";

export interface CreateRefundBatchPutParams {
  tableName: string;
  batchId: string;
  eventId: string;
  /** ISO-8601; defaults to now when omitted. */
  startedAt?: string;
}

/**
 * Create a RUNNING batch. Condition: batchId must not already exist.
 */
export function buildCreateRefundBatchPutInput(
  params: CreateRefundBatchPutParams,
) {
  const startedAt = params.startedAt ?? new Date().toISOString();
  const item: RefundBatchItem = {
    batchId: params.batchId,
    eventId: params.eventId,
    status: "RUNNING",
    enqueued: 0,
    succeeded: 0,
    failed: 0,
    startedAt,
  };

  return {
    TableName: params.tableName,
    Item: item,
    ConditionExpression: "attribute_not_exists(batchId)",
  };
}

export interface RefundBatchCheckpointUpdateParams {
  tableName: string;
  batchId: string;
  /** Number of orders enqueued in this page (`ADD`). */
  enqueuedDelta: number;
  /**
   * Opaque Query LastEvaluatedKey. Omit or pass null when the page was final
   * (also sets fanOutComplete = true and removes lastEvaluatedKey).
   */
  lastEvaluatedKey?: Record<string, unknown> | null;
}

/**
 * After a fan-out page: ADD enqueued; save or clear lastEvaluatedKey.
 */
export function buildRefundBatchCheckpointUpdateInput(
  params: RefundBatchCheckpointUpdateParams,
) {
  const { tableName, batchId, enqueuedDelta, lastEvaluatedKey } = params;

  if (enqueuedDelta < 0 || !Number.isInteger(enqueuedDelta)) {
    throw new Error(`enqueuedDelta must be a non-negative integer (got ${enqueuedDelta})`);
  }

  const expressionValues: Record<string, unknown> = {
    ":enqueuedDelta": enqueuedDelta,
    ":running": "RUNNING",
  };

  let updateExpression = "ADD enqueued :enqueuedDelta";
  if (lastEvaluatedKey === undefined) {
    // Counter-only bump (e.g. re-enqueue without cursor change).
  } else if (lastEvaluatedKey === null) {
    updateExpression +=
      " SET fanOutComplete = :fanOutComplete REMOVE lastEvaluatedKey";
    expressionValues[":fanOutComplete"] = true;
  } else {
    updateExpression +=
      " SET lastEvaluatedKey = :lek, fanOutComplete = :fanOutComplete";
    expressionValues[":lek"] = lastEvaluatedKey;
    expressionValues[":fanOutComplete"] = false;
  }

  return {
    TableName: tableName,
    Key: { batchId },
    UpdateExpression: updateExpression,
    ConditionExpression: "attribute_exists(batchId) AND #status = :running",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: expressionValues,
  };
}

export type RefundBatchCounterKind = "succeeded" | "failed";

export interface RefundBatchCounterUpdateParams {
  tableName: string;
  batchId: string;
  kind: RefundBatchCounterKind;
  /** Defaults to 1. */
  delta?: number;
}

/**
 * Worker progress: ADD succeeded or failed.
 */
export function buildRefundBatchCounterUpdateInput(
  params: RefundBatchCounterUpdateParams,
) {
  const delta = params.delta ?? 1;
  if (delta < 1 || !Number.isInteger(delta)) {
    throw new Error(`delta must be a positive integer (got ${delta})`);
  }

  const name = params.kind;
  return {
    TableName: params.tableName,
    Key: { batchId: params.batchId },
    UpdateExpression: `ADD ${name} :delta`,
    ConditionExpression: "attribute_exists(batchId)",
    ExpressionAttributeValues: { ":delta": delta },
  };
}

export interface CompleteRefundBatchUpdateParams {
  tableName: string;
  batchId: string;
  status: Extract<RefundBatchStatus, "COMPLETE" | "COMPLETE_WITH_FAILURES">;
  /** ISO-8601; defaults to now when omitted. */
  finishedAt?: string;
  reportKey?: string;
}

/**
 * RUNNING → COMPLETE | COMPLETE_WITH_FAILURES. Idempotent if already that status.
 */
export function buildCompleteRefundBatchUpdateInput(
  params: CompleteRefundBatchUpdateParams,
) {
  const finishedAt = params.finishedAt ?? new Date().toISOString();
  const expressionValues: Record<string, string> = {
    ":done": params.status,
    ":running": "RUNNING",
    ":finishedAt": finishedAt,
  };

  let updateExpression = "SET #status = :done, finishedAt = :finishedAt";
  if (params.reportKey) {
    updateExpression += ", reportKey = :reportKey";
    expressionValues[":reportKey"] = params.reportKey;
  }

  return {
    TableName: params.tableName,
    Key: { batchId: params.batchId },
    UpdateExpression: updateExpression,
    ConditionExpression:
      "attribute_exists(batchId) AND (#status = :running OR #status = :done)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: expressionValues,
  };
}
