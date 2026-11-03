import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import * as dynamodb from "../../shared/src/dynamodb";
import {
  isBatchDrained,
  tryCompleteRefundBatch,
} from "./try-complete-batch";

const tables = {
  refundBatchesTable: "refund-batches",
  eventsTable: "events",
};

describe("isBatchDrained", () => {
  it("requires fanOutComplete and matching counters", () => {
    assert.equal(
      isBatchDrained({
        status: "RUNNING",
        enqueued: 2,
        succeeded: 1,
        failed: 0,
        fanOutComplete: true,
      }),
      false,
    );
    assert.equal(
      isBatchDrained({
        status: "RUNNING",
        enqueued: 2,
        succeeded: 1,
        failed: 1,
        fanOutComplete: true,
      }),
      true,
    );
    assert.equal(
      isBatchDrained({
        status: "RUNNING",
        enqueued: 2,
        succeeded: 2,
        failed: 0,
        fanOutComplete: false,
      }),
      false,
    );
  });
});

describe("tryCompleteRefundBatch", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("no-ops when batch is not drained", async () => {
    let touched = false;
    mock.method(dynamodb, "getDocClient", () => {
      touched = true;
      return {
        send: async () => {
          throw new Error("should not write");
        },
      };
    });

    const closed = await tryCompleteRefundBatch(
      {
        batchId: "rb_1",
        eventId: "evt_001",
        status: "RUNNING",
        enqueued: 2,
        succeeded: 1,
        failed: 0,
        fanOutComplete: true,
      },
      tables,
    );
    assert.equal(closed, false);
    assert.equal(touched, false);
  });

  it("closes COMPLETE batch and marks event CANCELLED", async () => {
    const sends: unknown[] = [];
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: unknown) => {
        sends.push(cmd);
        return {};
      },
    }));

    const closed = await tryCompleteRefundBatch(
      {
        batchId: "rb_1",
        eventId: "evt_001",
        status: "RUNNING",
        enqueued: 1,
        succeeded: 1,
        failed: 0,
        fanOutComplete: true,
      },
      tables,
    );

    assert.equal(closed, true);
    assert.equal(sends.length, 2);
    assert.ok(sends[0] instanceof UpdateCommand);
    assert.ok(sends[1] instanceof UpdateCommand);
    const batchUpdate = (sends[0] as UpdateCommand).input;
    assert.equal(
      batchUpdate.ExpressionAttributeValues?.[":done"],
      "COMPLETE",
    );
    const eventUpdate = (sends[1] as UpdateCommand).input;
    assert.equal(
      eventUpdate.ExpressionAttributeValues?.[":cancelled"],
      "CANCELLED",
    );
  });

  it("uses COMPLETE_WITH_FAILURES when failed > 0", async () => {
    const sends: unknown[] = [];
    mock.method(dynamodb, "getDocClient", () => ({
      send: async (cmd: unknown) => {
        sends.push(cmd);
        return {};
      },
    }));

    await tryCompleteRefundBatch(
      {
        batchId: "rb_1",
        eventId: "evt_001",
        status: "RUNNING",
        enqueued: 2,
        succeeded: 1,
        failed: 1,
        fanOutComplete: true,
      },
      tables,
    );

    const batchUpdate = (sends[0] as UpdateCommand).input;
    assert.equal(
      batchUpdate.ExpressionAttributeValues?.[":done"],
      "COMPLETE_WITH_FAILURES",
    );
  });
});
