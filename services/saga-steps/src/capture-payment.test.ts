import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import * as payment from "../../shared/src/payment";
import type { AuthorizedSagaState } from "../../shared/src/types";
import { CapturePaymentError, handler } from "./capture-payment";

const input: AuthorizedSagaState = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07"],
  userId: "alice",
  amount: 5000,
  currency: "USD",
  authorizationId: "auth_abc",
  providerPaymentId: "pay_xyz",
};

function setEnv() {
  process.env.LEDGER_TABLE_NAME = "gatehold-dev-ledger";
  process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";
}

describe("capture-payment handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.LEDGER_TABLE_NAME;
    delete process.env.MOCK_PAYMENT_URL;
  });

  it("calls mock capture, appends CAPTURE ledger, passes state through", async () => {
    setEnv();
    mock.method(payment, "captureWithProvider", async () => ({
      idempotencyKey: "pay:capture:ord_1",
      orderId: "ord_1",
      authorizationId: "auth_abc",
      paymentId: "pay_xyz",
      status: "CAPTURED",
      amount: 5000,
      currency: "USD",
    }));
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({}),
    }));

    const result = await handler(input);
    assert.equal(result.authorizationId, "auth_abc");
    assert.equal(result.amount, 5000);
    assert.equal(result.orderId, "ord_1");
  });

  it("treats ConditionalCheckFailed ledger Put as success", async () => {
    setEnv();
    mock.method(payment, "captureWithProvider", async () => ({
      idempotencyKey: "pay:capture:ord_1",
      orderId: "ord_1",
      authorizationId: "auth_abc",
      paymentId: "pay_xyz",
      status: "CAPTURED",
      amount: 5000,
      currency: "USD",
    }));
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("exists");
        err.name = "ConditionalCheckFailedException";
        throw err;
      },
    }));

    const result = await handler(input);
    assert.equal(result.authorizationId, "auth_abc");
  });

  it("fails hard on provider 409", async () => {
    setEnv();
    mock.method(payment, "captureWithProvider", async () => {
      throw new payment.PaymentProviderError("conflict", 409, "CONFLICT");
    });
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        throw new Error("should not write ledger");
      },
    }));

    await assert.rejects(() => handler(input), CapturePaymentError);
  });
});
