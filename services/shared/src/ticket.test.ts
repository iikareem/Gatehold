import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TICKET_SIGNING_ALGORITHM,
  buildTicketPayload,
  ticketObjectKey,
  ticketSigningMessage,
} from "./ticket";

describe("ticketObjectKey", () => {
  it("uses tickets/{ticketId}.json", () => {
    assert.equal(
      ticketObjectKey("tkt:ord_1:A-12-07"),
      "tickets/tkt:ord_1:A-12-07.json",
    );
  });
});

describe("buildTicketPayload", () => {
  it("fills deterministic ticketId by default", () => {
    assert.deepEqual(
      buildTicketPayload({
        orderId: "ord_1",
        eventId: "evt_001",
        seatId: "A-12-07",
        userId: "alice",
      }),
      {
        ticketId: "tkt:ord_1:A-12-07",
        orderId: "ord_1",
        eventId: "evt_001",
        seatId: "A-12-07",
        userId: "alice",
      },
    );
  });

  it("allows explicit ticketId", () => {
    assert.equal(
      buildTicketPayload({
        orderId: "ord_1",
        eventId: "evt_001",
        seatId: "A-12-07",
        userId: "alice",
        ticketId: "tkt:custom",
      }).ticketId,
      "tkt:custom",
    );
  });
});

describe("ticketSigningMessage", () => {
  it("is stable JSON with fixed key order", () => {
    const msg = ticketSigningMessage({
      ticketId: "tkt:ord_1:A-12-07",
      orderId: "ord_1",
      eventId: "evt_001",
      seatId: "A-12-07",
      userId: "alice",
    });
    assert.equal(
      msg,
      '{"ticketId":"tkt:ord_1:A-12-07","orderId":"ord_1","eventId":"evt_001","seatId":"A-12-07","userId":"alice"}',
    );
  });
});

describe("TICKET_SIGNING_ALGORITHM", () => {
  it("matches contracts (RSA PSS SHA-256)", () => {
    assert.equal(TICKET_SIGNING_ALGORITHM, "RSASSA_PSS_SHA_256");
  });
});
