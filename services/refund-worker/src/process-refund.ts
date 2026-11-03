import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  appendLedgerItem,
  buildClaimCancelRefundUpdateInput,
  buildCompleteCancelRefundUpdateInput,
  buildLedgerItem,
  buildRefundBatchCounterUpdateInput,
  getDocClient,
  isConditionalCheckFailed,
  mockPaymentBaseUrl,
  paymentCaptureKey,
  paymentRefundKey,
  requireEnv,
  type LedgerItem,
  type RefundBatchItem,
  type RefundQueueMessage,
} from "../../shared/src";
import {
  isRetryablePaymentStatus,
  PaymentProviderError,
  refundWithProvider,
} from "../../shared/src/payment";
import { PermanentRefundError, TransientRefundError } from "./errors";
import { tryCompleteRefundBatch } from "./try-complete-batch";

export interface RefundJobTables {
  ordersTable: string;
  ledgerTable: string;
  refundBatchesTable: string;
  eventsTable: string;
}

/**
 * Cancel-path refund for one SQS message.
 * Idempotent on duplicate delivery once the order is REFUNDED.
 */
export async function processRefundJob(
  message: RefundQueueMessage,
  tables: RefundJobTables = tablesFromEnv(),
): Promise<void> {
  const { orderId, batchId } = message;
  if (!orderId || !batchId) {
    throw new PermanentRefundError("message missing orderId or batchId");
  }

  const alreadyDone = await claimOrSkipIfRefunded(tables.ordersTable, orderId);
  if (alreadyDone) {
    return;
  }

  const capture = await loadCapture(tables.ledgerTable, orderId);
  const refundKey = paymentRefundKey(orderId);
  const mockBase = await mockPaymentBaseUrl();

  let provider;
  try {
    provider = await refundWithProvider(mockBase, {
      idempotencyKey: refundKey,
      orderId,
      authorizationId: capture.authorizationId,
      amount: capture.amount,
      currency: capture.currency,
    });
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      if (isRetryablePaymentStatus(err.statusCode)) {
        throw new TransientRefundError(err.message);
      }
      throw new PermanentRefundError(err.message);
    }
    throw err;
  }

  if (provider.status !== "REFUNDED") {
    throw new PermanentRefundError(
      `refund returned unexpected status=${provider.status}`,
    );
  }

  await appendLedgerItem((cmd) => getDocClient().send(cmd), {
    tableName: tables.ledgerTable,
    item: buildLedgerItem({
      pk: refundKey,
      kind: "REFUND",
      orderId,
      amount: provider.amount,
      currency: provider.currency,
      createdAt: new Date().toISOString(),
      providerPaymentId: provider.paymentId || capture.providerPaymentId,
      authorizationId: provider.authorizationId || capture.authorizationId,
    }),
  });

  await completeOrder(tables.ordersTable, orderId);
  await bumpCounterAndMaybeComplete(tables, batchId, "succeeded");
}

export async function recordPermanentFailure(
  batchId: string,
  tables: Pick<RefundJobTables, "refundBatchesTable" | "eventsTable"> = {
    refundBatchesTable: requireEnv("REFUND_BATCHES_TABLE_NAME"),
    eventsTable: requireEnv("EVENTS_TABLE_NAME"),
  },
): Promise<void> {
  if (!batchId) return;
  await bumpCounterAndMaybeComplete(tables, batchId, "failed");
}

function tablesFromEnv(): RefundJobTables {
  return {
    ordersTable: requireEnv("ORDERS_TABLE_NAME"),
    ledgerTable: requireEnv("LEDGER_TABLE_NAME"),
    refundBatchesTable: requireEnv("REFUND_BATCHES_TABLE_NAME"),
    eventsTable: requireEnv("EVENTS_TABLE_NAME"),
  };
}

/**
 * Try CONFIRMED|REFUND_PENDING → REFUND_PENDING.
 * @returns true if already REFUNDED (duplicate SQS — skip refund).
 * @returns false if claim succeeded (continue refund).
 */
async function claimOrSkipIfRefunded(
  ordersTable: string,
  orderId: string,
): Promise<boolean> {
  const claimed = await tryClaimCancelRefund(ordersTable, orderId);
  if (claimed) {
    return false;
  }

  const order = await getOrder(ordersTable, orderId);
  if (order?.status === "REFUNDED") {
    return true;
  }
  throw new PermanentRefundError(
    `order ${orderId} not claimable (status=${order?.status ?? "missing"})`,
  );
}

/** @returns true when the conditional claim update succeeded. */
async function tryClaimCancelRefund(
  ordersTable: string,
  orderId: string,
): Promise<boolean> {
  try {
    await getDocClient().send(
      new UpdateCommand(
        buildClaimCancelRefundUpdateInput({ tableName: ordersTable, orderId }),
      ),
    );
    return true;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return false;
    }
    throw err;
  }
}

async function loadCapture(
  ledgerTable: string,
  orderId: string,
): Promise<LedgerItem & { authorizationId: string; amount: number }> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: ledgerTable,
      Key: { pk: paymentCaptureKey(orderId) },
    }),
  );
  const item = out.Item as LedgerItem | undefined;
  if (!item) {
    throw new PermanentRefundError(`missing CAPTURE ledger for ${orderId}`);
  }
  if (!item.authorizationId) {
    throw new PermanentRefundError(
      `CAPTURE ledger missing authorizationId for ${orderId}`,
    );
  }
  if (!Number.isInteger(item.amount) || item.amount <= 0) {
    throw new PermanentRefundError(
      `CAPTURE ledger invalid amount for ${orderId}`,
    );
  }
  return {
    ...item,
    authorizationId: item.authorizationId,
    amount: item.amount,
    currency: item.currency || "USD",
  };
}

async function completeOrder(ordersTable: string, orderId: string): Promise<void> {
  try {
    await getDocClient().send(
      new UpdateCommand(
        buildCompleteCancelRefundUpdateInput({
          tableName: ordersTable,
          orderId,
        }),
      ),
    );
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new PermanentRefundError(
        `order ${orderId} could not move to REFUNDED`,
      );
    }
    throw err;
  }
}

async function bumpCounterAndMaybeComplete(
  tables: Pick<RefundJobTables, "refundBatchesTable" | "eventsTable">,
  batchId: string,
  kind: "succeeded" | "failed",
): Promise<void> {
  const batch = await bumpBatchCounter(tables.refundBatchesTable, batchId, kind);
  await tryCompleteRefundBatch(batch, tables);
}

async function bumpBatchCounter(
  refundBatchesTable: string,
  batchId: string,
  kind: "succeeded" | "failed",
): Promise<RefundBatchItem> {
  try {
    const out = await getDocClient().send(
      new UpdateCommand({
        ...buildRefundBatchCounterUpdateInput({
          tableName: refundBatchesTable,
          batchId,
          kind,
        }),
        ReturnValues: "ALL_NEW",
      }),
    );
    const attrs = out.Attributes as RefundBatchItem | undefined;
    if (!attrs?.batchId || !attrs.eventId) {
      throw new PermanentRefundError(
        `refund batch missing attributes after counter bump: ${batchId}`,
      );
    }
    return attrs;
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new PermanentRefundError(`refund batch not found: ${batchId}`);
    }
    throw err;
  }
}

async function getOrder(
  ordersTable: string,
  orderId: string,
): Promise<{ status?: string } | undefined> {
  const out = await getDocClient().send(
    new GetCommand({
      TableName: ordersTable,
      Key: { orderId },
      ProjectionExpression: "#status",
      ExpressionAttributeNames: { "#status": "status" },
    }),
  );
  return out.Item as { status?: string } | undefined;
}
