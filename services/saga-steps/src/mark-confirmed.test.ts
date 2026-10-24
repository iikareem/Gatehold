import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import type { TicketedSagaState } from "../../shared/src/types";
import { MarkConfirmedError, handler } from "./mark-confirmed";

const input: TicketedSagaState = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07"],
  userId: "alice",
  amount: 5000,
  currency: "USD",
  authorizationId: "auth_1",
  ticketIds: ["tkt:ord_1:A-12-07"],
};

describe("mark-confirmed handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.ORDERS_TABLE_NAME;
  });

  it("updates order to CONFIRMED and passes state through", async () => {
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
    const typed = updateInput as {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, string>;
    };
    assert.match(typed.UpdateExpression, /SET #status = :confirmed/);
    assert.match(
      typed.ConditionExpression,
      /#status = :pending OR #status = :confirmed/,
    );
    assert.equal(typed.ExpressionAttributeValues[":confirmed"], "CONFIRMED");
  });

  it("fails with MarkConfirmedError when condition fails", async () => {
    process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("bad status");
        err.name = "ConditionalCheckFailedException";
        throw err;
      },
    }));

    await assert.rejects(() => handler(input), MarkConfirmedError);
  });

  it("requires ticketIds", async () => {
    process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
    const bad = { ...input, ticketIds: [] };
    await assert.rejects(() => handler(bad), MarkConfirmedError);
  });
});
