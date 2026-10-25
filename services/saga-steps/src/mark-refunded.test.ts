import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import { MarkRefundedError, handler } from "./mark-refunded";
import type { CompensatingSagaState } from "./release-seat";

const input: CompensatingSagaState = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07"],
  userId: "alice",
  error: {
    Error: "IssueTicketError",
    Cause: "ticket write failed",
  },
};

describe("mark-refunded handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.ORDERS_TABLE_NAME;
  });

  it("updates order to REFUNDED with failReason from Catch", async () => {
    process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
    let updateInput: unknown;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: { input: unknown }) => {
        updateInput = cmd.input;
        return {};
      },
    }));

    const result = await handler(input);
    assert.deepEqual(result, input);
    const expr = updateInput as {
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, string>;
    };
    assert.match(expr.UpdateExpression, /#status = :refunded/);
    assert.match(expr.UpdateExpression, /failReason = :failReason/);
    assert.equal(
      expr.ExpressionAttributeValues[":failReason"],
      "IssueTicketError: ticket write failed",
    );
  });

  it("fails with MarkRefundedError on ConditionalCheckFailed", async () => {
    process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("ccf");
        err.name = "ConditionalCheckFailedException";
        throw err;
      },
    }));

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof MarkRefundedError);
        return true;
      },
    );
  });

  it("requires orderId", async () => {
    process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
    const bad = { ...input, orderId: "" };
    await assert.rejects(() => handler(bad), MarkRefundedError);
  });
});
