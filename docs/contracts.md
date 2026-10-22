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
| `payUntil`, `orderId` | string | Set from saga phases |

## Seed defaults (local)

- Event: `evt_001` / `ON_SALE`
- Seats: `A-12-01` … `A-12-50`, all `AVAILABLE`
- Tables: `gatehold-{stage}-events`, `gatehold-{stage}-seats`

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

Implementation: `go/hold-sweeper` under module `github.com/iikareem/Gatehold/go` (manual `go run ./hold-sweeper` from `go/` in Phase 2; EventBridge Scheduler in Phase 2b).

## TODO (later phases)

- Conditional write expressions for confirm / payment release
- Idempotency key formats (order, payment, refund)
- SQS message shapes (order enqueue, refund job)
- EventBridge detail types (email, audit, analytics)
- Ledger entry kinds (`AUTH`, `CAPTURE`, `VOID`, `REFUND`)
