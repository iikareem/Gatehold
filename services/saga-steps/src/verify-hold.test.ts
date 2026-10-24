import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import * as dynamodb from "../../shared/src/dynamodb";
import type { SagaInput } from "../../shared/src/types";
import { handler, VerifyHoldError } from "./verify-hold";

const input: SagaInput = {
  orderId: "ord_1",
  eventId: "evt_001",
  holdId: "h_1",
  seatIds: ["A-12-07", "A-12-08"],
  userId: "alice",
};

const futurePayUntil = "2099-01-01T00:00:00.000Z";

function setEnv() {
  process.env.ORDERS_TABLE_NAME = "gatehold-dev-orders";
  process.env.EVENTS_TABLE_NAME = "gatehold-dev-events";
  process.env.SEATS_TABLE_NAME = "gatehold-dev-seats";
}

function goodOrder() {
  return {
    orderId: "ord_1",
    userId: "alice",
    eventId: "evt_001",
    holdId: "h_1",
    seatIds: ["A-12-07", "A-12-08"],
    status: "PENDING",
    idempotencyKey: "k1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function goodEvent() {
  return {
    eventId: "evt_001",
    status: "ON_SALE",
    name: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function goodSeat(seatId: string) {
  return {
    eventId: "evt_001",
    seatId,
    status: "PAYING",
    section: "A",
    row: "12",
    holdId: "h_1",
    orderId: "ord_1",
    payUntil: futurePayUntil,
    version: 2,
  };
}

/** Resolve Gets by table + key so tests stay order-independent. */
function mockGets(items: {
  order?: unknown;
  event?: unknown;
  seats?: Record<string, unknown>;
}) {
  mock.method(dynamodb, "getDocClient", () => ({
    send: async (cmd: {
      input: {
        TableName?: string;
        Key?: Record<string, string>;
      };
    }) => {
      const table = cmd.input.TableName ?? "";
      const key = cmd.input.Key ?? {};
      if (table.includes("orders")) {
        return { Item: items.order };
      }
      if (table.includes("events")) {
        return { Item: items.event };
      }
      if (table.includes("seats")) {
        const seatId = key.seatId;
        return { Item: items.seats?.[seatId] };
      }
      return {};
    },
  }));
}

describe("verify-hold handler", () => {
  afterEach(() => {
    mock.restoreAll();
    delete process.env.ORDERS_TABLE_NAME;
    delete process.env.EVENTS_TABLE_NAME;
    delete process.env.SEATS_TABLE_NAME;
  });

  it("returns saga input when order, event, and seats are valid", async () => {
    setEnv();
    mockGets({
      order: goodOrder(),
      event: goodEvent(),
      seats: {
        "A-12-07": goodSeat("A-12-07"),
        "A-12-08": goodSeat("A-12-08"),
      },
    });

    const result = await handler(input);
    assert.deepEqual(result, input);
  });

  it("fails when order is not PENDING", async () => {
    setEnv();
    mockGets({
      order: { ...goodOrder(), status: "CONFIRMED" },
      event: goodEvent(),
      seats: {},
    });

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof VerifyHoldError);
        assert.match((err as Error).message, /CONFIRMED/);
        return true;
      },
    );
  });

  it("fails when event is CANCELLING", async () => {
    setEnv();
    mockGets({
      order: goodOrder(),
      event: { ...goodEvent(), status: "CANCELLING" },
      seats: {},
    });

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof VerifyHoldError);
        assert.match((err as Error).message, /CANCELLING/);
        return true;
      },
    );
  });

  it("fails when a seat payUntil has expired", async () => {
    setEnv();
    mockGets({
      order: goodOrder(),
      event: goodEvent(),
      seats: {
        "A-12-07": {
          ...goodSeat("A-12-07"),
          payUntil: "2000-01-01T00:00:00.000Z",
        },
        "A-12-08": goodSeat("A-12-08"),
      },
    });

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof VerifyHoldError);
        assert.match((err as Error).message, /payUntil expired/);
        return true;
      },
    );
  });

  it("fails when seat is not PAYING", async () => {
    setEnv();
    mockGets({
      order: goodOrder(),
      event: goodEvent(),
      seats: {
        "A-12-07": { ...goodSeat("A-12-07"), status: "HELD" },
        "A-12-08": goodSeat("A-12-08"),
      },
    });

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof VerifyHoldError);
        assert.match((err as Error).message, /expected PAYING/);
        return true;
      },
    );
  });

  it("fails when seat orderId does not match", async () => {
    setEnv();
    mockGets({
      order: goodOrder(),
      event: goodEvent(),
      seats: {
        "A-12-07": { ...goodSeat("A-12-07"), orderId: "ord_other" },
        "A-12-08": goodSeat("A-12-08"),
      },
    });

    await assert.rejects(
      () => handler(input),
      (err: unknown) => {
        assert.ok(err instanceof VerifyHoldError);
        assert.match((err as Error).message, /orderId mismatch/);
        return true;
      },
    );
  });
});
