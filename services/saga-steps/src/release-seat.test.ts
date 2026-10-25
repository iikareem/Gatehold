import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import {
  ReleaseSeatError,
  handler,
  type CompensatingSagaState,
} from "./release-seat";

const input: CompensatingSagaState = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07", "A-12-08"],
  userId: "alice",
  error: {
    Error: "AuthorizePaymentError",
    Cause: '{"errorMessage":"declined"}',
  },
};

describe("release-seat handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.SEATS_TABLE_NAME;
  });

  it("transact-writes seats to AVAILABLE and returns saga state", async () => {
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

  it("fails with ReleaseSeatError when transaction is canceled", async () => {
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
        assert.ok(err instanceof ReleaseSeatError);
        return true;
      },
    );
  });

  it("requires seatIds", async () => {
    process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
    const bad = { ...input, seatIds: [] };
    await assert.rejects(() => handler(bad), ReleaseSeatError);
  });
});
