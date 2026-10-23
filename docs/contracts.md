# Contracts

Shared contracts between TypeScript services and Go tooling.
Seat states, conditions, event shapes, and message payloads live here.

Keep TypeScript types in `services/shared/src` aligned with this file.

## Seat status

`AVAILABLE` → `HELD` → `PAYING` → `SOLD`

## Event status

`ON_SALE` → `CANCELLING` → `CANCELLED`

## Order status

`PENDING` → `CONFIRMED` | `FAILED` | `REFUND_PENDING` → `REFUNDED`

## Events table (Phase 0)

| Attribute | Type | Notes |
|---|---|---|
| `eventId` (PK) | string | e.g. `evt_001` |
| `status` | string | `ON_SALE` \| `CANCELLING` \| `CANCELLED` |
| `name` | string | Display name |
| `createdAt` | string | ISO-8601 |
| `cancelledAt` | string | Optional; set on cancel |
| `refundBatchId` | string | Optional; set when refund batch starts |

## Seats table (Phase 0)

| Attribute | Type | Notes |
|---|---|---|
| `eventId` (PK) | string | Event identifier |
| `seatId` (SK) | string | `{section}-{row}-{nn}` zero-padded, e.g. `A-12-07` |
| `status` | string | `AVAILABLE` \| `HELD` \| `PAYING` \| `SOLD` |
| `section` | string | e.g. `A` |
| `row` | string | e.g. `12` |
| `version` | number | Optimistic locking (starts at `1`) |
| `holdId`, `holdOwner`, `expiresAt` | string | Set from Phase 1 |
| `payUntil`, `orderId` | string | Set from Phase 4 accept (`PAYING`); confirm in saga |

## Seed defaults (local)

- Event: `evt_001` / `ON_SALE`
- Seats: `A-12-01` … `A-12-50`, all `AVAILABLE`
- Tables: `gatehold-{stage}-events`, `gatehold-{stage}-seats`
- Phase 4+: `gatehold-{stage}-orders`, `gatehold-{stage}-idempotency`

## Phase 1 / 3 — Hold seats (`POST /events/{eventId}/holds`)

**Auth stub (until Phase 8 Cognito):** read `X-User-Id` header; if missing, use `test-user`. Never trust a `userId` from the body.

**Request body:**

```json
{ "seatIds": ["A-12-07"] }
```

or a group (same shape):

```json
{ "seatIds": ["A-12-10", "A-12-11", "A-12-12", "A-12-13"] }
```

- `seatIds` length **1..8** (`MAX_HOLD_SEATS`). Cap → `400`.
- Path `eventId` is the event partition key.
- This slice is **explicit `seatIds` only** (no `groupSize` / server block search yet).

**Success — `201 Created`:**

```json
{
  "holdId": "h_…",
  "seatIds": ["A-12-10", "A-12-11", "A-12-12", "A-12-13"],
  "expiresAt": "2026-11-01T20:05:00.000Z"
}
```

All listed seats share one `holdId` and one `expiresAt`.

**Conflict — `409`:** any seat is not claimable (`HELD` with `expiresAt >= now`, or `PAYING` / `SOLD`). DynamoDB cancels the whole `TransactWriteItems` → **zero seats held** (no half-holds). Response includes `eventId` and the requested `seatIds`.

**Bad request — `400`:** missing/invalid body, empty `seatIds`, length `> 8`, or a non-empty-string entry.

**Hold duration:** `expiresAt = now + 5 minutes` (`HOLD_DURATION_MS` in `services/shared`).

### Per-seat condition (same as Phase 1)

```
Update (each seat in the transaction)
  SET status = HELD,
      holdId = :holdId,
      holdOwner = :holdOwner,
      expiresAt = :expiresAt
  CONDITION status = AVAILABLE
         OR (status = HELD AND expiresAt < :now)
```

### Group write (Phase 3)

```
TransactWriteItems [
  Update seat …   (same SET + CONDITION)
  …
]
```

Any condition failure → `TransactionCanceledException` → API `409`. Always use a transaction (even for length 1).

`version` stays on the seat item but is **optional** — not in CONDITION, not in SET.

Shared builders: `buildHoldSeatUpdateInput`, `buildHoldSeatsTransactWriteInput` in `services/shared/src/hold.ts`.

## Phase 2 — Hold sweeper (release expired holds)

**Role:** Background cleaner (Go `hold-sweeper`). Not the concurrency gate — Phase 1 hold condition still allows reclaim on the next `POST /holds`. Sweeper keeps the table/UI honest (`AVAILABLE` instead of stale `HELD`).

**Do not use DynamoDB TTL** to free seats. Seat items stay; only status/hold fields change.

### Transition

```
HELD + expiresAt < now  →  AVAILABLE
  REMOVE holdId, holdOwner, expiresAt
```

### Conditional write (idempotent)

```
UpdateItem
  SET #status = AVAILABLE
  REMOVE holdId, holdOwner, expiresAt
  CONDITION #status = HELD AND expiresAt < :now
```

- If the seat was already released, moved to `PAYING`/`SOLD`, or a new hold extended `expiresAt`, the condition fails → skip (safe to run twice).
- Phase 2 discovery: **Scan** seats (filter `status = HELD`, then check `expiresAt`). No seats GSI yet.

Implementation: `go/hold-sweeper` under module `github.com/iikareem/Gatehold/go` (manual `go run ./hold-sweeper` from `go/` in Phase 2; EventBridge Scheduler → Lambda in Phase 2b — done).

## Phase 4 — Orders, idempotency, SQS (`POST /orders`)

**Goal:** Accept a purchase for an existing hold: claim idempotency key → verify hold/event → lock seats `HELD→PAYING` + create order `PENDING` (one `TransactWriteItems`) → enqueue SQS → return `202`. No queue consumer in this phase.

**Auth stub:** same as holds — `X-User-Id` header, else `test-user`. Never trust `userId` from the body.

### Request

Headers:

- `Idempotency-Key` — **required**. Missing → `400`.
- `X-User-Id` — optional stub until Cognito.

Body (`seatIds` required so updates target seat items without a `holdId` GSI; client reuses the list from the hold response):

```json
{
  "eventId": "evt_001",
  "holdId": "h_…",
  "seatIds": ["A-12-10", "A-12-11"]
}
```

- `seatIds` length **1..8** (same cap as holds). Cap / empty / invalid → `400`.
- `eventId` and `holdId` must be non-empty strings.

### Success — `202 Accepted`

```json
{
  "orderId": "ord_…",
  "status": "PENDING"
}
```

Same `Idempotency-Key` retry returns this **stored** response (no second order, no second enqueue after accept is recorded).

### Errors

| Status | When |
|---|---|
| `400` | Missing `Idempotency-Key`, missing/invalid body, bad `seatIds` |
| `409` | Foreign/expired hold, seat not still `HELD` under that `holdId`, event not `ON_SALE`, or idempotency key still `IN_PROGRESS` |
| `500` | Accept txn succeeded but SQS send failed (key may stay `IN_PROGRESS`; client may retry same key) |

### Orders table

Table name: `gatehold-{stage}-orders`

| Attribute | Type | Notes |
|---|---|---|
| `orderId` (PK) | string | e.g. `ord_…` |
| `userId` | string | Hold owner / `X-User-Id` |
| `eventId` | string | Event partition |
| `holdId` | string | Hold being purchased |
| `seatIds` | string[] | Seats in this order |
| `status` | string | `PENDING` on create; later `CONFIRMED` \| `FAILED` \| `REFUND_PENDING` \| `REFUNDED` |
| `idempotencyKey` | string | Same client `Idempotency-Key` |
| `createdAt` | string | ISO-8601 |
| `amount` | number | Optional until payment |
| `executionArn` | string | Optional until saga |
| `failReason` | string | Optional debugging |

**GSIs**

| GSI | Keys | Why |
|---|---|---|
| `userId` | PK `userId` | List orders for a user |
| `eventId-status` | PK `eventId`, SK `status` | Cancel / refund fan-out |

### Idempotency table

Table name: `gatehold-{stage}-idempotency`

| Attribute | Type | Notes |
|---|---|---|
| `key` (PK) | string | Value of `Idempotency-Key` header |
| `status` | string | `IN_PROGRESS` \| `ACCEPTED` |
| `responseStatus` | number | Stored HTTP status (e.g. `202`) when `ACCEPTED` |
| `responseBody` | string | JSON string of stored response body |
| `orderId` | string | Optional link to the order |
| `ttl` | number | Epoch seconds; DynamoDB TTL cleanup |

**Status meaning**

- `IN_PROGRESS` — this request owns the key; accept path not finished (or SQS not confirmed yet).
- `ACCEPTED` — accept API done: order created, SQS sent, response stored. **Not** order `CONFIRMED`.

### Create-order transaction

`payUntil = now + PAY_WINDOW_MS` (shared constant; seats stay protected while the order is `PENDING`).

```
TransactWriteItems [
  Put idempotency
    key = :key, status = IN_PROGRESS, orderId = :o, ttl = …
    CONDITION attribute_not_exists(key)

  ConditionCheck event
    eventId = :e
    CONDITION #status = ON_SALE

  Update (each seat)
    SET #status = PAYING,
        orderId = :o,
        payUntil = :payUntil
    CONDITION holdId = :h
          AND holdOwner = :u
          AND #status = HELD
          AND expiresAt > :now

  Put order
    orderId, userId, eventId, holdId, seatIds,
    status = PENDING, idempotencyKey, createdAt
]
```

Any condition failure → whole txn cancels. Duplicate key → Get idempotency item and return stored / in-progress response.

After txn success: `SendMessage` to order SQS, then update idempotency to `ACCEPTED` with stored `202` body.

Shared builders: `buildLockSeatForPaymentUpdateInput`, `buildCreateOrderTransactWriteInput`, `payUntilAt`, `idempotencyTtlEpoch` in `services/shared/src/order.ts` (`PAY_WINDOW_MS` = 15 minutes).

### Order SQS message (Phase 4)

Queue: order queue (+ DLQ configured; **no consumer** in Phase 4 — messages remain until a later phase).

Payload (JSON body):

```json
{
  "orderId": "ord_…",
  "eventId": "evt_001",
  "holdId": "h_…",
  "seatIds": ["A-12-10", "A-12-11"],
  "userId": "test-user"
}
```

## Phase 5 — Mock payment provider (`go/mock-payment`)

**Goal:** Controllable HTTP payment API before the Phase 6 saga depends on it. Standalone process (not API Gateway). In-memory only; no DynamoDB ledger writes in this phase.

**Local base URL:** `http://127.0.0.1:8090` (override with `PORT` env).

**Implementation:** `go run ./mock-payment` from `go/`.

### Idempotency key formats

The saga (Phase 6) will send these keys. The mock treats the key as opaque but clients must use this shape:

| Operation | Key format |
|---|---|
| Authorize | `pay:auth:{orderId}` |
| Capture | `pay:capture:{orderId}` |
| Void | `pay:void:{orderId}` |
| Refund | `pay:refund:{orderId}` |

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Smoke test |
| `POST` | `/v1/payments/authorize` | Reserve funds (does not capture) |
| `POST` | `/v1/payments/capture` | Capture a prior authorization |
| `POST` | `/v1/payments/void` | Cancel an authorization (no money moved) |
| `POST` | `/v1/payments/refund` | Return captured funds |
| `GET` | `/v1/payments/status?idempotencyKey=` | Resolve unknown / timeout outcomes |

### Provider payment status

`AUTHORIZED` → `CAPTURED` \| `VOIDED`

`CAPTURED` → `REFUNDED`

Also: `FAILED` (terminal failure for that operation attempt).

Illegal transitions (e.g. capture after void, refund without capture) → `409`.

### Authorize — `POST /v1/payments/authorize`

**Request:**

```json
{
  "idempotencyKey": "pay:auth:ord_…",
  "orderId": "ord_…",
  "amount": 5000,
  "currency": "USD"
}
```

- `amount` is integer cents.
- `currency` is `USD` for local runs.

**Success — `200`:**

```json
{
  "idempotencyKey": "pay:auth:ord_…",
  "orderId": "ord_…",
  "authorizationId": "auth_…",
  "paymentId": "pay_…",
  "status": "AUTHORIZED",
  "amount": 5000,
  "currency": "USD"
}
```

### Capture — `POST /v1/payments/capture`

**Request:**

```json
{
  "idempotencyKey": "pay:capture:ord_…",
  "orderId": "ord_…",
  "authorizationId": "auth_…",
  "amount": 5000,
  "currency": "USD"
}
```

Requires an existing authorization in `AUTHORIZED`. Success → `status: CAPTURED` (same response shape; `authorizationId` echoed).

### Void — `POST /v1/payments/void`

**Request:** same fields as capture (`idempotencyKey` = `pay:void:{orderId}`).

Requires `AUTHORIZED`. Success → `status: VOIDED`. Prefer void over refund when seats cannot be confirmed (no money moved).

### Refund — `POST /v1/payments/refund`

**Request:** same fields as capture (`idempotencyKey` = `pay:refund:{orderId}`).

Requires `CAPTURED`. Success → `status: REFUNDED`.

### Status — `GET /v1/payments/status?idempotencyKey=…`

Returns the **stored** outcome for that key (authorize, capture, void, or refund). Used after client timeout / unknown result.

- Known key → `200` with the same body shape as the original success (or `FAILED` if that op failed).
- Unknown key → `404`.

### Idempotency rule

- Same `idempotencyKey` + same operation + same body → return the **stored** success (`200`); never a second charge / second auth.
- Same key with a **different** body → `409`.
- Each operation (auth / capture / void / refund) has its own key.

### Errors

| Status | When |
|---|---|
| `400` | Missing/invalid JSON or required fields |
| `404` | Status query for unknown key; capture/void/refund for unknown `authorizationId` |
| `409` | Idempotency key reuse with different body; illegal status transition |
| `429` | Chaos rate limit (see below) |
| `500` / `502` | Chaos hard errors |

Error body:

```json
{ "error": "human-readable message", "code": "MACHINE_CODE" }
```

### Ledger kinds (Phase 6 writes; document now)

The DynamoDB ledger (not built in Phase 5) will use append-only kinds mapped from provider outcomes:

| Ledger kind | After provider status |
|---|---|
| `AUTH` | `AUTHORIZED` |
| `CAPTURE` | `CAPTURED` |
| `VOID` | `VOIDED` |
| `REFUND` | `REFUNDED` |

Phase 6 conditional-writes these with the same idempotency keys so duplicates are rejected. The mock only returns statuses; it does not write the ledger.

### Chaos knobs

Env defaults (process-wide) plus optional per-request override header `X-Chaos-Force` (`429`, `500`, `502`, `timeout`, `latency`).

| Knob | Env example | Behavior |
|---|---|---|
| Latency | `CHAOS_LATENCY_MS=200` | Sleep after success, before writing the body |
| Timeout feel | `CHAOS_TIMEOUT_RATE=0.1` + `CHAOS_TIMEOUT_MS=30000` | After store success: sleep, then **drop** the body; **outcome is stored** — client must `GET /status` |
| Rate limit | `CHAOS_429_RATE=0.2` | `429` + `Retry-After`; **before** store — no mutation |
| Hard errors | `CHAOS_ERROR_RATE=0.1` | `500` / `502` **before** store — no mutation |
| Duplicate success | (store idempotency) | Retry same key returns the same body |

**Timeout vs status:** for “timeout after success”, store the outcome **before** applying the delay/drop so `GET /status` is deterministic for that key. For “fail before accept” (`429` / hard error), do not write the store.

Implementation: `Chaos.Before` (fail before accept) and `Chaos.After` (latency / timeout after success) in `go/mock-payment`.

### Out of scope (later phases)

- Step Functions saga client, DynamoDB ledger table, Secrets Manager URL (Phases 6 / 8)
- Curls for live smoke → [`api.md`](./api.md) once the server exists

## TODO (later phases)

- Conditional write expressions for confirm / payment release (`PAYING→SOLD`, compensation release)
- SQS message shapes for refund jobs
- EventBridge detail types (email, audit, analytics)
- Outbox or DynamoDB Streams → SQS (harden enqueue after Phase 4)
