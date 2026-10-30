import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "./dynamodb";
import * as kms from "./kms";
import {
  isTicketPayload,
  verifyTicketArtifact,
} from "./ticket-verify";

const payload = {
  ticketId: "tkt:ord_1:A-12-07",
  orderId: "ord_1",
  eventId: "evt_001",
  seatId: "A-12-07",
  userId: "alice",
};

describe("isTicketPayload", () => {
  it("accepts a full payload", () => {
    assert.equal(isTicketPayload(payload), true);
  });

  it("rejects missing fields", () => {
    assert.equal(isTicketPayload({ ...payload, seatId: "" }), false);
    assert.equal(isTicketPayload({ ticketId: "x" }), false);
  });
});

describe("verifyTicketArtifact", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("accepts a valid signature when event is not CANCELLED", async () => {
    mock.method(kms, "verifyTicketMessage", async () => true);
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: { eventId: "evt_001", status: "ON_SALE", name: "Show" },
      }),
    }));

    const result = await verifyTicketArtifact({
      artifact: { payload, signature: "sig" },
      keyId: "key-1",
      eventsTableName: "events",
    });
    assert.deepEqual(result, { valid: true, payload });
  });

  it("rejects an invalid signature without reading the event", async () => {
    mock.method(kms, "verifyTicketMessage", async () => false);
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => {
        throw new Error("should not load event");
      },
    }));

    const result = await verifyTicketArtifact({
      artifact: { payload, signature: "bad" },
      keyId: "key-1",
      eventsTableName: "events",
    });
    assert.deepEqual(result, { valid: false, reason: "invalid_signature" });
  });

  it("rejects when the event is CANCELLED even if signature is valid", async () => {
    mock.method(kms, "verifyTicketMessage", async () => true);
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: {
          eventId: "evt_001",
          status: "CANCELLED",
          name: "Show",
          cancelledAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    }));

    const result = await verifyTicketArtifact({
      artifact: { payload, signature: "sig" },
      keyId: "key-1",
      eventsTableName: "events",
    });
    assert.deepEqual(result, { valid: false, reason: "event_cancelled" });
  });

  it("rejects when the event row is missing", async () => {
    mock.method(kms, "verifyTicketMessage", async () => true);
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({ Item: undefined }),
    }));

    const result = await verifyTicketArtifact({
      artifact: { payload, signature: "sig" },
      keyId: "key-1",
      eventsTableName: "events",
    });
    assert.deepEqual(result, { valid: false, reason: "event_not_found" });
  });

  it("accepts when event is CANCELLING (only CANCELLED rejects)", async () => {
    mock.method(kms, "verifyTicketMessage", async () => true);
    mock.method(dynamodb, "getDocClient", () => ({
      send: async () => ({
        Item: { eventId: "evt_001", status: "CANCELLING", name: "Show" },
      }),
    }));

    const result = await verifyTicketArtifact({
      artifact: { payload, signature: "sig" },
      keyId: "key-1",
      eventsTableName: "events",
    });
    assert.equal(result.valid, true);
  });
});
