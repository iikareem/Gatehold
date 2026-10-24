import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IDEMPOTENCY_TTL_SECONDS,
  PAY_WINDOW_MS,
  buildConfirmSeatUpdateInput,
  buildConfirmSeatsTransactWriteInput,
  buildCreateOrderTransactWriteInput,
  buildLockSeatForPaymentUpdateInput,
  idempotencyTtlEpoch,
  payUntilAt,
} from "./order";

describe("buildLockSeatForPaymentUpdateInput", () => {
  const input = buildLockSeatForPaymentUpdateInput({
    tableName: "gatehold-dev-seats",
    eventId: "evt_001",
    seatId: "A-12-07",
    holdId: "h_test",
    holdOwner: "alice",
    orderId: "ord_1",
    payUntil: "2026-11-01T20:15:00.000Z",
    now: "2026-11-01T20:00:00.000Z",
  });

  it("targets the seat key", () => {
    assert.equal(input.TableName, "gatehold-dev-seats");
    assert.deepEqual(input.Key, { eventId: "evt_001", seatId: "A-12-07" });
  });

  it("sets PAYING fields", () => {
    assert.match(input.UpdateExpression, /SET #status = :paying/);
    assert.match(input.UpdateExpression, /orderId = :orderId/);
    assert.match(input.UpdateExpression, /payUntil = :payUntil/);
    assert.equal(input.ExpressionAttributeValues[":paying"], "PAYING");
    assert.equal(input.ExpressionAttributeValues[":orderId"], "ord_1");
  });

  it("requires matching hold, owner, HELD, and not expired", () => {
    assert.equal(
      input.ConditionExpression,
      "holdId = :holdId AND holdOwner = :holdOwner AND #status = :held AND expiresAt > :now",
    );
    assert.equal(input.ExpressionAttributeValues[":held"], "HELD");
    assert.equal(input.ExpressionAttributeValues[":holdId"], "h_test");
    assert.equal(input.ExpressionAttributeValues[":holdOwner"], "alice");
    assert.equal(
      input.ExpressionAttributeValues[":now"],
      "2026-11-01T20:00:00.000Z",
    );
  });
});

describe("buildCreateOrderTransactWriteInput", () => {
  const input = buildCreateOrderTransactWriteInput({
    seatsTableName: "gatehold-dev-seats",
    eventsTableName: "gatehold-dev-events",
    ordersTableName: "gatehold-dev-orders",
    idempotencyTableName: "gatehold-dev-idempotency",
    idempotencyKey: "idem-1",
    orderId: "ord_1",
    userId: "alice",
    eventId: "evt_001",
    holdId: "h_test",
    seatIds: ["A-12-10", "A-12-11"],
    now: "2026-11-01T20:00:00.000Z",
    payUntil: "2026-11-01T20:15:00.000Z",
    ttl: 1_000_000,
  });

  it("claims idempotency first with attribute_not_exists", () => {
    const put = input.TransactItems[0].Put;
    assert.equal(put?.TableName, "gatehold-dev-idempotency");
    assert.deepEqual(put?.Item, {
      key: "idem-1",
      status: "IN_PROGRESS",
      orderId: "ord_1",
      ttl: 1_000_000,
    });
    assert.equal(put?.ConditionExpression, "attribute_not_exists(#k)");
    assert.equal(put?.ExpressionAttributeNames?.["#k"], "key");
  });

  it("checks event is ON_SALE", () => {
    const check = input.TransactItems[1].ConditionCheck;
    assert.equal(check?.TableName, "gatehold-dev-events");
    assert.deepEqual(check?.Key, { eventId: "evt_001" });
    assert.equal(check?.ConditionExpression, "#status = :onSale");
    assert.equal(check?.ExpressionAttributeValues?.[":onSale"], "ON_SALE");
  });

  it("locks each seat then puts PENDING order", () => {
    assert.equal(input.TransactItems.length, 5); // idem + event + 2 seats + order
    assert.deepEqual(input.TransactItems[2].Update?.Key, {
      eventId: "evt_001",
      seatId: "A-12-10",
    });
    assert.deepEqual(input.TransactItems[3].Update?.Key, {
      eventId: "evt_001",
      seatId: "A-12-11",
    });
    assert.equal(
      input.TransactItems[2].Update?.ExpressionAttributeValues?.[":holdOwner"],
      "alice",
    );

    const orderPut = input.TransactItems[4].Put;
    assert.equal(orderPut?.TableName, "gatehold-dev-orders");
    assert.equal(orderPut?.Item?.status, "PENDING");
    assert.deepEqual(orderPut?.Item?.seatIds, ["A-12-10", "A-12-11"]);
    assert.equal(orderPut?.Item?.idempotencyKey, "idem-1");
    assert.equal(orderPut?.ConditionExpression, "attribute_not_exists(orderId)");
  });
});

describe("buildConfirmSeatUpdateInput", () => {
  const input = buildConfirmSeatUpdateInput({
    tableName: "gatehold-dev-seats",
    eventId: "evt_001",
    seatId: "A-12-07",
    holdId: "h_1",
    orderId: "ord_1",
  });

  it("sets SOLD with PAYING-or-already-SOLD condition", () => {
    assert.equal(input.ExpressionAttributeValues[":sold"], "SOLD");
    assert.equal(input.ExpressionAttributeValues[":paying"], "PAYING");
    assert.match(
      input.ConditionExpression,
      /holdId = :holdId AND orderId = :orderId/,
    );
    assert.match(
      input.ConditionExpression,
      /#status = :paying OR #status = :sold/,
    );
  });
});

describe("buildConfirmSeatsTransactWriteInput", () => {
  it("one Update per seat", () => {
    const input = buildConfirmSeatsTransactWriteInput({
      seatsTableName: "gatehold-dev-seats",
      eventId: "evt_001",
      holdId: "h_1",
      orderId: "ord_1",
      seatIds: ["A-12-07", "A-12-08"],
    });
    assert.equal(input.TransactItems.length, 2);
    assert.equal(
      input.TransactItems[0]?.Update?.Key?.seatId,
      "A-12-07",
    );
  });
});

describe("payUntilAt", () => {
  it("adds PAY_WINDOW_MS to the reference time", () => {
    const nowMs = Date.parse("2026-11-01T20:00:00.000Z");
    assert.equal(PAY_WINDOW_MS, 15 * 60 * 1000);
    assert.equal(
      payUntilAt(nowMs),
      new Date(nowMs + PAY_WINDOW_MS).toISOString(),
    );
  });
});

describe("idempotencyTtlEpoch", () => {
  it("adds IDEMPOTENCY_TTL_SECONDS to now as epoch seconds", () => {
    const nowMs = Date.parse("2026-11-01T20:00:00.000Z");
    assert.equal(IDEMPOTENCY_TTL_SECONDS, 7 * 24 * 60 * 60);
    assert.equal(
      idempotencyTtlEpoch(nowMs),
      Math.floor(nowMs / 1000) + IDEMPOTENCY_TTL_SECONDS,
    );
  });
});
