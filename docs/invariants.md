# Invariants

Cross-table rules Gatehold must keep true. The Phase 12 reconciler **detects** violations and reports them to CloudWatch (logs + metrics + alarm). It does **not** auto-repair.

Keep this list short. Add a row when a new detector ships.

## Active (Phase 12)

| ID | Rule | How to check | On violation |
|---|---|---|---|
| `confirmed-seats-sold` | If an order is `CONFIRMED`, every `seatId` on that order must exist on the Seats table with `status = SOLD` and `orderId` equal to the order’s `orderId`. | Page Events → Query Orders GSI `eventId-status` for `CONFIRMED` → GetItem each seat | Structured log (`action=alarmed`) + metric `ReconcilerInconsistencies`; no write |

### Failure examples (`confirmed-seats-sold`)

- Seat row missing
- Seat `AVAILABLE`, `HELD`, or `PAYING`
- Seat `SOLD` but `orderId` is missing or belongs to a different order

## Deferred (not Phase 12)

| Idea | Notes |
|---|---|
| Cancelled event with paid order not refunded | Possible later detector; out of scope for 12a–12e |
| `SOLD` seat with no matching `CONFIRMED`/`REFUNDED` order | Seat-driven scan; optional second pass later |

## Related

- Shapes and statuses: [`contracts.md`](./contracts.md)
- Phase slices: [`development-plan.md`](./development-plan.md) Phase 12
