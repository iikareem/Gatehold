import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import * as payment from "../../shared/src/payment";
import type { SagaInput } from "../../shared/src/types";
import { AuthorizePaymentError, handler } from "./authorize-payment";

const input: SagaInput = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07"],
  userId: "alice",
};

function setEnv() {
  process.env.LEDGER_TABLE_NAME = "gatehold-dev-ledger";
  process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
  process.env.MOCK_PAYMENT_URL = "http://127.0.0.1:8090";
  process.env.ORDER_AMOUNT_CENTS = "5000";
}

describe("authorize-payment handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.LEDGER_TABLE_NAME;
    delete process.env.ORDERS_TABLE_NAME;
    delete process.env.MOCK_PAYMENT_URL;
    delete process.env.ORDER_AMOUNT_CENTS;
  });

  it("calls mock, appends AUTH ledger, returns authorizationId", async () => {
    setEnv();
    const puts: unknown[] = [];
    mock.method(payment, "authorizeWithProvider", async () => ({
      idempotencyKey: "pay:auth:ord_1",
      orderId: "ord_1",
      authorizationId: "auth_abc",
      paymentId: "pay_xyz",
      status: "AUTHORIZED",
      amount: 5000,
      currency: "USD",
    }));
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: { constructor: { name: string }; input: unknown }) => {
        puts.push(cmd.constructor.name);
        return {};
      },
    }));

    const result = await handler(input);
    assert.equal(result.authorizationId, "auth_abc");
    assert.equal(result.providerPaymentId, "pay_xyz");
    assert.equal(result.amount, 5000);
    assert.equal(result.orderId, "ord_1");
    assert.ok(puts.includes("PutCommand") || puts.length >= 1);
  });

  it("treats ConditionalCheckFailed ledger Put as success (already_exists)", async () => {
    setEnv();
    mock.method(payment, "authorizeWithProvider", async () => ({
      idempotencyKey: "pay:auth:ord_1",
      orderId: "ord_1",
      authorizationId: "auth_abc",
      paymentId: "pay_xyz",
      status: "AUTHORIZED",
      amount: 5000,
      currency: "USD",
    }));
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: { constructor: { name: string } }) => {
        if (cmd.constructor.name === "PutCommand") {
          const err = new Error("exists");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        return {};
      },
    }));

    const result = await handler(input);
    assert.equal(result.authorizationId, "auth_abc");
  });

  it("fails hard on non-retryable provider 409", async () => {
    setEnv();
    mock.method(payment, "authorizeWithProvider", async () => {
      throw new payment.PaymentProviderError("conflict", 409, "CONFLICT");
    });
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        throw new Error("should not write ledger");
      },
    }));

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof AuthorizePaymentError);
        return true;
      },
    );
  });
});
