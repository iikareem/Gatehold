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

## Phase 1 — Single-seat hold

### `POST /events/{eventId}/holds`

**Auth stub (until Phase 8 Cognito):** read `X-User-Id` header; if missing, use `test-user`. Never trust a `userId` from the body.

**Request body (Phase 1):**

```json
{ "seatIds": ["A-12-07"] }
```

- `seatIds` must be length exactly `1` (group holds are Phase 3).
- Path `eventId` is the event partition key.

**Success — `201 Created`:**

```json
{
  "holdId": "h_…",
  "seatIds": ["A-12-07"],
  "expiresAt": "2026-11-01T20:05:00.000Z"
}
```

**Conflict — `409`:** seat is `HELD` with `expiresAt >= now`, or otherwise not claimable (`PAYING` / `SOLD`). Loser leaves no partial state (single conditional `UpdateItem`).

**Bad request — `400`:** missing/invalid body, empty `seatIds`, or length ≠ 1.

**Hold duration:** `expiresAt = now + 5 minutes` (`HOLD_DURATION_MS` in `services/shared`).

### Conditional write (concurrency gate)

Use a **direct** `UpdateItem` with a condition — not Get-then-Update / check-then-act. The condition is evaluated atomically with the write.

```
UpdateItem
  SET status = HELD,
      holdId = :holdId,
      holdOwner = :holdOwner,
      expiresAt = :expiresAt
  CONDITION status = AVAILABLE
         OR (status = HELD AND expiresAt < :now)
```

`version` stays on the seat item but is **optional for Phase 1** — not in CONDITION, not in SET. Use it later when a path does check-then-act application logic and needs optimistic locking.

Shared TypeScript builder: `buildHoldSeatUpdateInput` in `services/shared/src/hold.ts`.

## TODO (later phases)

- Conditional write expressions for confirm / release
- Idempotency key formats (order, payment, refund)
- SQS message shapes (order enqueue, refund job)
- EventBridge detail types (email, audit, analytics)
- Ledger entry kinds (`AUTH`, `CAPTURE`, `VOID`, `REFUND`)
