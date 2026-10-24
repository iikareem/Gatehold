import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import type { AuthorizedSagaState } from "../../shared/src/types";
import { ConfirmSeatError, handler } from "./confirm-seat";

const input: AuthorizedSagaState = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07", "A-12-08"],
  userId: "alice",
  amount: 5000,
  currency: "USD",
  authorizationId: "auth_1",
  providerPaymentId: "pay_1",
};

describe("confirm-seat handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.SEATS_TABLE_NAME;
  });

  it("transact-writes seats to SOLD and returns saga state", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    let transactInput: unknown;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: { input: unknown }) => {
        transactInput = cmd.input;
        return {};
      },
    }));

    const result = await handler(input);
    assert.deepEqual(result, input);
    const items = (transactInput as { TransactItems: unknown[] }).TransactItems;
    assert.equal(items.length, 2);
  });

  it("fails with ConfirmSeatError when transaction is canceled", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("canceled");
        err.name = "TransactionCanceledException";
        throw err;
      },
    }));

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof ConfirmSeatError);
        return true;
      },
    );
  });

  it("requires authorizationId", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    const bad = { ...input, authorizationId: "" };
    await assert.rejects(() => handler(bad), ConfirmSeatError);
  });
});
