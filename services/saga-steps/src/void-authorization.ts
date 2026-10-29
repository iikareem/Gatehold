import {
  appendLedgerItem,
  buildLedgerItem,
  getDocClient,
  mockPaymentBaseUrl,
  paymentVoidKey,
  requireEnv,
} from "../../shared/src";
import {
  isRetryablePaymentStatus,
  PaymentProviderError,
  voidWithProvider,
} from "../../shared/src/payment";
import type { CompensatingSagaState } from "./release-seat";

/** ConfirmSeat Catch input — auth succeeded, so authorizationId is present. */
export interface VoidAuthorizationInput extends CompensatingSagaState {
  authorizationId: string;
  amount: number;
  currency: string;
  providerPaymentId?: string;
}

/**
 * Business / non-retryable void failure.
 */
export class VoidAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoidAuthorizationError";
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
 * Phase 6 compensation — VoidAuthorization.
 * After auth succeeded but ConfirmSeat failed: void the hold on funds
 * (pay:void:{orderId} + ledger VOID), then ReleaseSeat → MarkFailed.
 */
export async function handler(
  event: VoidAuthorizationInput,
): Promise<VoidAuthorizationInput> {
  const ledgerTable = requireEnv("LEDGER_TABLE_NAME");
  const mockBase = await mockPaymentBaseUrl();

  if (!event.authorizationId) {
    throw new VoidAuthorizationError(
      "authorizationId required (run AuthorizePayment first)",
    );
  }
  if (!Number.isInteger(event.amount) || event.amount <= 0) {
    throw new VoidAuthorizationError(
      `amount required (got ${String(event.amount)})`,
    );
  }

  const pk = paymentVoidKey(event.orderId);
  const currency = event.currency || "USD";
  const createdAt = new Date().toISOString();

  let provider;
  try {
    provider = await voidWithProvider(mockBase, {
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
      throw new VoidAuthorizationError(err.message);
    }
    throw err;
  }

  if (provider.status !== "VOIDED") {
    throw new VoidAuthorizationError(
      `void returned unexpected status=${provider.status}`,
    );
  }

  const ledgerResult = await appendLedgerItem(
    (cmd) => getDocClient().send(cmd),
    {
      tableName: ledgerTable,
      item: buildLedgerItem({
        pk,
        kind: "VOID",
        orderId: event.orderId,
        amount: provider.amount,
        currency: provider.currency,
        createdAt,
        providerPaymentId: provider.paymentId || event.providerPaymentId,
        authorizationId: provider.authorizationId || event.authorizationId,
      }),
    },
  );

  console.info("void-authorization ok", {
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
