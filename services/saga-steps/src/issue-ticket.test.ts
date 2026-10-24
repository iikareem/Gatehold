import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import type { AuthorizedSagaState } from "../../shared/src/types";
import { IssueTicketError, handler } from "./issue-ticket";

const input: AuthorizedSagaState = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07", "A-12-08"],
  userId: "alice",
  amount: 5000,
  currency: "USD",
  authorizationId: "auth_1",
};

describe("issue-ticket handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.ORDERS_TABLE_NAME;
  });

  it("writes placeholder ticketIds and returns ticketed state", async () => {
    process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
    let updateInput: unknown;
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: { input: unknown }) => {
        updateInput = cmd.input;
        return {};
      },
    }));

    const result = await handler(input);
    assert.deepEqual(result.ticketIds, [
      "tkt:ord_1:A-12-07",
      "tkt:ord_1:A-12-08",
    ]);
    assert.equal(result.orderId, "ord_1");
    assert.equal(
      (updateInput as { UpdateExpression: string }).UpdateExpression,
      "SET ticketIds = if_not_exists(ticketIds, :ticketIds)",
    );
  });

  it("fails with IssueTicketError when order is missing", async () => {
    process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("missing");
        err.name = "ConditionalCheckFailedException";
        throw err;
      },
    }));

    await assert.rejects(() => handler(input), IssueTicketError);
  });

  it("requires seatIds", async () => {
    process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
    const bad = { ...input, seatIds: [] };
    await assert.rejects(() => handler(bad), IssueTicketError);
  });
});
