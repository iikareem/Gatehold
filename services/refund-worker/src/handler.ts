import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";
import type { RefundQueueMessage } from "../../shared/src";
import { PermanentRefundError } from "./errors";
import { processRefundJob, recordPermanentFailure } from "./process-refund";

/**
 * Phase 11d — SQS refunds → provider refund + ledger REFUND + order REFUNDED.
 * Transient / unknown errors → partial batch failure (retry).
 * Permanent errors → ack after batch.failed bump (no retry).
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      await handleRecord(record);
    } catch (err) {
      if (err instanceof PermanentRefundError) {
        console.error("refund-worker permanent", {
          messageId: record.messageId,
          error: err.message,
        });
        continue;
      }
      console.warn("refund-worker retry", {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
}

async function handleRecord(record: SQSRecord): Promise<void> {
  const message = parseMessage(record.body);
  try {
    await processRefundJob(message);
  } catch (err) {
    if (err instanceof PermanentRefundError) {
      await recordPermanentFailure(message.batchId);
      console.error("refund-worker permanent", {
        messageId: record.messageId,
        orderId: message.orderId,
        error: err.message,
      });
      return;
    }
    throw err;
  }
}

function parseMessage(body: string): RefundQueueMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PermanentRefundError("invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PermanentRefundError("message body must be an object");
  }
  const msg = parsed as Partial<RefundQueueMessage>;
  return {
    orderId: typeof msg.orderId === "string" ? msg.orderId : "",
    eventId: typeof msg.eventId === "string" ? msg.eventId : "",
    batchId: typeof msg.batchId === "string" ? msg.batchId : "",
  };
}
