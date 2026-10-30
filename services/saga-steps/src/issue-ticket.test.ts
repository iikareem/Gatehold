import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import * as kms from "../../shared/src/kms";
import * as s3 from "../../shared/src/s3";
import type { AuthorizedSagaState } from "../../shared/src/types";
import { IssueTicketError, TransientError, handler } from "./issue-ticket";

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

function setTicketEnv(): void {
  process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
  process.env.TICKETS_BUCKET = "gatehold-dev-tickets";
  process.env.TICKET_SIGNING_KEY_ID = "key-test-id";
}

describe("issue-ticket handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.ORDERS_TABLE_NAME;
    delete process.env.TICKETS_BUCKET;
    delete process.env.TICKET_SIGNING_KEY_ID;
  });

  it("signs each seat, puts S3 artifacts, then writes ticketIds", async () => {
    setTicketEnv();
    const putKeys: string[] = [];
    let updateInput: unknown;

    mock.method(kms, "signTicketMessage", async () => "sig-base64");
    mock.method(s3, "putTicketArtifact", async (params: { key: string }) => {
      putKeys.push(params.key);
    });
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
    assert.deepEqual(putKeys, [
      "tickets/tkt:ord_1:A-12-07.json",
      "tickets/tkt:ord_1:A-12-08.json",
    ]);
    assert.equal(
      (updateInput as { UpdateExpression: string }).UpdateExpression,
      "SET ticketIds = if_not_exists(ticketIds, :ticketIds)",
    );
  });

  it("fails with IssueTicketError when order is missing", async () => {
    setTicketEnv();
    mock.method(kms, "signTicketMessage", async () => "sig-base64");
    mock.method(s3, "putTicketArtifact", async () => {});
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        const err = new Error("missing");
        err.name = "ConditionalCheckFailedException";
        throw err;
      },
    }));

    await assert.rejects(() => handler(input), IssueTicketError);
  });

  it("maps throttling to TransientError", async () => {
    setTicketEnv();
    mock.method(kms, "signTicketMessage", async () => {
      const err = new Error("slow");
      err.name = "ThrottlingException";
      throw err;
    });

    await assert.rejects(() => handler(input), TransientError);
  });

  it("requires seatIds", async () => {
    setTicketEnv();
    const bad = { ...input, seatIds: [] };
    await assert.rejects(() => handler(bad), IssueTicketError);
  });
});
