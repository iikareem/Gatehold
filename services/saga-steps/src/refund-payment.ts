import {
  appendLedgerItem,
  buildLedgerItem,
  getDocClient,
  mockPaymentBaseUrl,
  paymentRefundKey,
  requireEnv,
} from "../../shared/src";
import {
  isRetryablePaymentStatus,
  PaymentProviderError,
  refundWithProvider,
} from "../../shared/src/payment";
import type { CompensatingSagaState } from "./release-seat";

/** IssueTicket / MarkConfirmed Catch input — capture succeeded. */
export interface RefundPaymentInput extends CompensatingSagaState {
  authorizationId: string;
  amount: number;
  currency: string;
  providerPaymentId?: string;
}

/**
 * Business / non-retryable refund failure.
 */
export class RefundPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundPaymentError";
  }
}

/**
 * Transient provider / network failure — safe for Step Functions retry.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * Phase 6 compensation — RefundPayment.
 * After capture succeeded but IssueTicket / MarkConfirmed failed: refund
 * (pay:refund:{orderId} + ledger REFUND), then ReleaseSeat → MarkRefunded.
 */
export async function handler(
  event: RefundPaymentInput,
): Promise<RefundPaymentInput> {
  const ledgerTable = requireEnv("LEDGER_TABLE_NAME");
  const mockBase = await mockPaymentBaseUrl();

  if (!event.authorizationId) {
    throw new RefundPaymentError(
      "authorizationId required (run AuthorizePayment first)",
    );
  }
  if (!Number.isInteger(event.amount) || event.amount <= 0) {
    throw new RefundPaymentError(
      `amount required (got ${String(event.amount)})`,
    );
  }

  const pk = paymentRefundKey(event.orderId);
  const currency = event.currency || "USD";
  const createdAt = new Date().toISOString();

  let provider;
  try {
    provider = await refundWithProvider(mockBase, {
      idempotencyKey: pk,
      orderId: event.orderId,
      authorizationId: event.authorizationId,
      amount: event.amount,
      currency,
    });
  } catch (err) {
    if (err instanceof PaymentProviderError) {
      if (isRetryablePaymentStatus(err.statusCode)) {
        throw new TransientError(err.message);
      }
      throw new RefundPaymentError(err.message);
    }
    throw err;
  }

  if (provider.status !== "REFUNDED") {
    throw new RefundPaymentError(
      `refund returned unexpected status=${provider.status}`,
    );
  }

  const ledgerResult = await appendLedgerItem(
    (cmd) => getDocClient().send(cmd),
    {
      tableName: ledgerTable,
      item: buildLedgerItem({
        pk,
        kind: "REFUND",
        orderId: event.orderId,
        amount: provider.amount,
        currency: provider.currency,
        createdAt,
        providerPaymentId: provider.paymentId || event.providerPaymentId,
        authorizationId: provider.authorizationId || event.authorizationId,
      }),
    },
  );

  console.info("refund-payment ok", {
    orderId: event.orderId,
    authorizationId: event.authorizationId,
    ledger: ledgerResult,
  });

  return {
    ...event,
    amount: provider.amount,
    currency: provider.currency,
    authorizationId: provider.authorizationId || event.authorizationId,
    ...(provider.paymentId || event.providerPaymentId
      ? {
          providerPaymentId: provider.paymentId || event.providerPaymentId,
        }
      : {}),
  };
}
