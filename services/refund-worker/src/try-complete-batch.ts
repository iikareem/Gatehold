import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  buildCompleteRefundBatchUpdateInput,
  buildMarkEventCancelledUpdateInput,
  getDocClient,
  isConditionalCheckFailed,
  type RefundBatchItem,
} from "../../shared/src";

export interface TryCompleteTables {
  refundBatchesTable: string;
  eventsTable: string;
}

/**
 * After a succeeded/failed counter bump: if fan-out is done and every
 * enqueued job is accounted for, close the batch and mark the event CANCELLED.
 * Safe under concurrent workers (conditional updates are idempotent).
 */
export async function tryCompleteRefundBatch(
  batch: Pick<
    RefundBatchItem,
    | "batchId"
    | "eventId"
    | "status"
    | "enqueued"
    | "succeeded"
    | "failed"
    | "fanOutComplete"
  >,
  tables: TryCompleteTables,
): Promise<boolean> {
  if (!isBatchDrained(batch)) {
    return false;
  }

  const terminalStatus =
    (batch.failed ?? 0) > 0 ? "COMPLETE_WITH_FAILURES" : "COMPLETE";

  try {
    await getDocClient().send(
      new UpdateCommand(
        buildCompleteRefundBatchUpdateInput({
          tableName: tables.refundBatchesTable,
          batchId: batch.batchId,
          status: terminalStatus,
        }),
      ),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) {
      throw err;
    }
    // Already terminal / missing — still try event mark below if needed.
  }

  try {
    await getDocClient().send(
      new UpdateCommand(
        buildMarkEventCancelledUpdateInput({
          tableName: tables.eventsTable,
          eventId: batch.eventId,
        }),
      ),
    );
  } catch (err) {
    if (!isConditionalCheckFailed(err)) {
      throw err;
    }
  }

  return true;
}

export function isBatchDrained(
  batch: Pick<
    RefundBatchItem,
    "status" | "enqueued" | "succeeded" | "failed" | "fanOutComplete"
  >,
): boolean {
  if (
    batch.status !== "RUNNING" &&
    batch.status !== "COMPLETE" &&
    batch.status !== "COMPLETE_WITH_FAILURES"
  ) {
    return false;
  }
  if (batch.fanOutComplete !== true) {
    return false;
  }
  const enqueued = batch.enqueued ?? 0;
  const succeeded = batch.succeeded ?? 0;
  const failed = batch.failed ?? 0;
  return enqueued === succeeded + failed;
}
