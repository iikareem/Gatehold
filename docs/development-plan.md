# Development Plan

A learn-while-building order for Gatehold. Follow phases in sequence. Each phase has a small vertical slice you can run and verify before moving on.

The README describes the finished system. This document is the path to get there without building dependencies in the wrong order.

Related docs:

- [`contracts.md`](./contracts.md) — seat/order/event shapes and shared payloads
- [`api.md`](./api.md) — local curl cheat sheet for live endpoints
- [`runbook.md`](./runbook.md) — local MiniStack and ops procedures
- [`adr/`](./adr/) — why decisions were made

---

## How to use this plan

1. Finish one phase before starting the next. Partial scaffolding for later phases is fine; behavior is not.
2. After each phase, write down what broke and what you learned (seed for README “What I Learned”).
3. Prefer MiniStack for day-to-day work. Use real AWS only when you need load numbers or a service the emulator does not cover well.
4. When a design choice is unclear, write a short ADR before coding a second approach.
5. Fill `contracts.md` as you introduce each message or condition — do not invent Go/TS payloads independently.

### Definition of done (every phase)

- [ ] Code runs locally against MiniStack (or documented AWS exception)
- [ ] At least one automated test or script proves the phase invariant
- [ ] Contracts / types updated if a new payload or state transition was added
- [ ] You can explain the failure mode this phase prevents in one paragraph

### Do not skip ahead

| Temptation | Why it breaks learning order |
|---|---|
| Full saga before a solid hold | Saga compensation assumes seats can be locked and released correctly |
| Refunds before auth + capture | Refund idempotency is meaningless without a working ledger and payment keys |
| Loadgen before single-seat correctness | You will measure noise, not invariants |
| Cognito + every AWS service on day one | Infra sprawl hides the concurrency problem you are here to learn |
| Tickets / email before purchase confirm | Notifications decorate a path that must already be correct |

---

## Current baseline

Phases 0–7 are implemented: holds, sweeper, group holds, orders + SQS, mock payment wiring, purchase saga (happy path + compensation) + ledger, and CDK composite constructs under `infra/lib/constructs/` with a thin `GateholdStack` composer.

**Next:** Phase 9b — JWT authorizer + identity from claims (Phase 9a Cognito pool done).

---

## Phase 0 — Local loop and shared foundations

**Goal:** Deploy empty infra to MiniStack and share types/helpers between services.

**Build**

- Wire `npm` / TypeScript build so `services/*` and `infra` compile
- Minimal CDK: one stack, one DynamoDB table (or Seats + Events), one “hello” Lambda behind API Gateway (or invoke Lambda directly at first)
- `services/shared`: seat/order/event status types, DynamoDB client factory that respects `AWS_ENDPOINT_URL`
- Seed script or CDK custom resource to create one event and a small seat map (e.g. one section, ~50 seats, all `AVAILABLE`)
- Confirm MiniStack up / deploy / reset from [`runbook.md`](./runbook.md)

**Learn**

- CDK deploy cycle against an emulator
- Env-based endpoint override for local AWS
- Why shared types live in one place

**Done when**

- `cdklocal deploy` (or equivalent) succeeds
- You can put/get a seat item in DynamoDB from a Lambda or a small script
- Reset clears state and you can reseed

**Out of scope:** Cognito, Step Functions, SQS, real auth.

---

## Phase 1 — Single-seat hold (the concurrency gate)

**Goal:** `POST /events/{eventId}/holds` for one seat via conditional write.

**Build**

- `hold-seat` Lambda: body `{ "seatIds": ["A-12-07"] }` (length 1)
- Conditional update: `AVAILABLE → HELD` (or expired `HELD` reclaim) with `holdId`, `holdOwner`, `expiresAt`
- Conflict → `409`; success → `201` with `holdId`, `seatIds`, `expiresAt`
- Auth stub: accept a header or fixed test user for now; document that Cognito replaces this in Phase 9
- Unit tests for the condition expression (available, already held, expired held)
- Document the condition in `contracts.md`

**Learn**

- DynamoDB conditional writes as the concurrency gate
- Why losers must leave no partial state

**Done when**

- Two concurrent holds on the same seat: exactly one succeeds
- Holding an expired seat succeeds; holding a live hold fails

**Do not build yet:** group transactions, orders, payment.

---

## Phase 2 — Hold expiry correctness (sweeper logic)

**Goal:** Holds are time-bounded without trusting DynamoDB TTL for correctness. Prove the Go sweeper by hand before wiring a schedule.

**Build**

- Every read/decision path that cares about a hold checks `expiresAt < now`
- Do **not** use DynamoDB TTL to free seats (reminder only — seats stay as items; flip `HELD` → `AVAILABLE`)
- `hold-sweeper` (Go): Scan expired `HELD` seats and return them to `AVAILABLE` if still expired and not `PAYING` (conditional update; idempotent)
- Run with `go run` against MiniStack (no EventBridge yet)
- Test: hold expires → next buyer can take the seat; sweeper run twice does not break seats

**Learn**

- Why decision-time `expiresAt` checks beat TTL for correctness
- Why a sweeper alone is not the source of truth (belt-and-suspenders)

**Done when**

- Manual sweeper run clears expired holds on MiniStack
- Sweeper is idempotent

**Status:** Done (manual `go run ./hold-sweeper` against MiniStack). Sweeper keeps table/UI honest; Phase 1 hold condition remains the concurrency gate. Unit tests deferred. Scheduling is Phase 2b (done).

---

## Phase 2b — Schedule the sweeper (EventBridge Scheduler)

**Goal:** Run the proven sweeper on a timer so expired holds get cleaned without a manual `go run`.

**Prerequisite:** Phase 2 sweeper logic works by hand.

**Build**

- Package `hold-sweeper` as a Go Lambda (CDK)
- EventBridge Scheduler rule → invoke sweeper on an interval (e.g. every 1–5 minutes locally)
- Same env as other Lambdas (`SEATS_TABLE_NAME`, MiniStack `AWS_ENDPOINT_URL` when local)
- Confirm: create a hold, wait past `expiresAt`, wait for schedule (or force invoke) → seat becomes `AVAILABLE`

**Learn**

- EventBridge Scheduler vs EventBridge bus (Phase 8 is the bus for notifications)
- Scheduled Lambda packaging for Go

**Done when**

- Scheduler (or forced invoke of the deployed Lambda) releases an expired hold without `go run`

**Note:** Phase 8 EventBridge is still for **domain events** (streams → email/audit). Scheduler here is only the **timer** for the sweeper.

**Status:** Done — CDK packages `hold-sweeper` as a Go Lambda; EventBridge Scheduler invokes it on a 1-minute rate.

---

## Phase 3 — Group holds (all or nothing)

**Goal:** Multiple seats held completely or not at all.

**Built (this slice — explicit `seatIds` only)**

- Body `{ "seatIds": [...] }` with length **1..8** (`MAX_HOLD_SEATS`)
- `TransactWriteItems` over the list; same SET/CONDITION per seat as Phase 1
- `TransactionCanceledException` → `409`; zero half-holds
- Update `contracts.md` / Postman / `docs/api.md`

**Deferred (optional later)**

- `groupSize` + `section` (+ `adjacent`) and server-side block search
- Jittered retry across candidate blocks

**Learn**

- DynamoDB transactions, cancellation → HTTP conflict, ~2× write cost
- Client sends the seats; server guarantees atomicity

**Done when**

- Multi-seat hold succeeds with one `holdId`
- Overlapping groups never leave a partial hold
- Cap / empty rejected with a clear `400`

**Prerequisite:** Phase 1 conditions are solid; group path reuses the same SET/CONDITION per seat.

**Status:** Done (seatIds path).

---

## Phase 4 — Orders, idempotency, and SQS buffer

**Goal:** Fast `POST /orders` that enqueues work; no saga yet.

**Build**

- Idempotency table: key → stored response; duplicate key returns the first result
- `create-order`: verify hold ownership + not expired + event `ON_SALE` → seats `HELD→PAYING` + create `PENDING` order → SQS → `202`
- Order GSI planning early: `eventId` + `status` (you will need it for refunds)
- Order SQS (+ DLQ from day one for when a consumer is added later)
- **No consumer in this phase** — messages stay on the queue; inspect them in MiniStack

**Learn**

- Idempotency keys vs at-least-once delivery
- Why the API stays thin and the queue absorbs bursts

**Done when**

- Retry with the same `Idempotency-Key` does not create two orders
- Expired or foreign hold is rejected
- Message appears on SQS and remains there (inspect via MiniStack; no worker drains it yet)

**Do not build yet:** queue consumer, payment, tickets, full Step Functions.

---

## Phase 5 — Mock payment provider (Go)

**Goal:** A controllable payment API before the saga depends on it.

**Build**

- `go/mock-payment`: authorize, capture, void, refund, status-by-idempotency-key
- Chaos knobs: latency, timeout, `429`, duplicate-looking successes, error rates
- Ledger-facing contract: what keys the saga will send (document in `contracts.md`)
- Health endpoint for local smoke tests

**Learn**

- Why “unknown” outcomes need a status query
- Designing provider APIs for idempotent clients

**Done when**

- You can authorize → capture and authorize → void against the mock
- Timeout + status query returns a deterministic outcome for a given key

**Why before the saga:** the saga’s hardest bugs are payment ambiguity; build the fake first.

---

## Phase 6 — Purchase saga (happy path + compensation)

**Goal:** Step Functions owns the purchase; seats and money stay consistent.

**Build**

- Replace the temporary SQS consumer with a saga starter (execution name = `orderId`)
- Implement saga steps in TypeScript (shared package or `saga-steps`):
  1. VerifyHold  
  2. LockSeatForPayment — **assert** still `PAYING` / matching `holdId`+`orderId` / `payUntil` valid (Phase 4 already did `HELD → PAYING`)  
  3. AuthorizePayment  
  4. ~~CheckPaymentStatus (on timeout / unknown)~~ — **skipped** (retries + TransientError only; no status Choice)
  5. ConfirmSeat (`PAYING → SOLD`)  
  6. CapturePayment  
  7. IssueTicket (Phase 10 can stub S3/KMS; for now write a placeholder ticket record)  
  8. MarkConfirmed  
- Compensation: VoidAuthorization, RefundPayment, ReleaseSeat, MarkFailed, MarkRefunded
- Ledger conditional writes for `AUTH` / `CAPTURE` / `VOID` / `REFUND` (schema in `contracts.md` Slice 0)
- Failure tests: payment timeout, hold expires during payment, confirm fails after auth *(optional; can skip)*
- Build incrementally: contracts → skeleton ASL → one step at a time (see learning slices)

**Learn**

- `PAYING` / `payUntil` vs hold expiry race
- Authorize-then-capture to avoid unnecessary refunds
- Idempotent steps under Step Functions retries

**Done when**

- Happy path: hold → order → `CONFIRMED`, seats `SOLD`, ledger has AUTH+CAPTURE
- Auth succeeds but confirm fails → void + seats available + order `FAILED` (or refunded if you already captured — prefer void path)
- Duplicate saga start for same `orderId` is rejected / harmless

**Prerequisite:** Phases 1–5. Stub ticket issuance is OK; do not block the saga on KMS polish.

---

## Phase 7 — CDK composite constructs (infra refactor)

**Goal:** Split the monolithic `GateholdStack` (~800 lines of tables, Lambdas, Step Functions tasks, grants, API, and outputs) into nested CDK constructs so new domains (streams, auth, cancel/refund) do not keep pasting the same boilerplate.

This phase changes **infra layout only**. No new product behavior. Deploy + hold → order → saga must still work on MiniStack after the split.

**Why now (not earlier)**

- Phases 0–6 needed one flat file so the purchase path stayed visible while learning.
- After Phase 6 the domains are stable enough to name: data, holds, orders, purchase saga, HTTP API.
- Phase 8+ would dump streams / EventBridge / notifications into the same file and make wiring (grants, env, Catch chains) hard to review.

**What “composite” means here**

In CDK, nested `Construct`s are the Composite pattern: small pieces (`NodejsFunction`, table, route) compose into bigger units (`PurchaseSaga`, `DataPlane`), which compose into the stack. The stack becomes a thin assembler; each construct owns a cohesive slice and exposes only what others need.

```text
GateholdStack
├── DataPlane          (events, seats, orders, idempotency, ledger)
├── HoldCapability     (hold-seat, sweeper, schedule)
├── OrderAccept        (create-order, order queue / DLQ)
├── PurchaseSaga       (state machine + step Lambdas + saga-starter)
└── HttpApi            (API Gateway routes)
```

**Build**

- Add `infra/lib/constructs/` (or equivalent) and move resources out of the flat stack into the constructs above
- Shared helpers where paste repeats: e.g. `createNodeFn(...)` for runtime / timeout / bundling / `lambdaEnv`, and a small helper for saga `LambdaInvoke` + `TransientError` retry
- Each construct creates its resources, grants IAM at its edges, and exports props others need (`ordersTable`, `purchaseSaga`, queue URLs, etc.)
- Keep a single CloudFormation stack / MiniStack deploy path — compose constructs, do **not** introduce nested stacks or multi-account layout
- Update CfnOutputs so runbook / scripts still find the same names
- `cdk synth` + MiniStack redeploy; smoke hold → create-order → saga happy path (and one compensation path if easy)

**Do not**

- Change saga ASL semantics, Lambda handlers, or table schemas
- Add Streams / EventBridge bus / Cognito / tickets in this phase
- Over-abstract: prefer clear domain constructs over a deep hierarchy

**Learn**

- Composite / construct composition: stop copying Lambda + env + grant + retry setup
- Props at construct boundaries vs chasing identifiers across an 800-line file
- Why refactor after the domain is nameable, not mid-saga slices

**Done when**

- `gatehold-stack.ts` is a short composer (constructs + wiring), not the place every resource is declared
- Repeated `NodejsFunction` / saga-task boilerplate lives in helpers or construct internals
- MiniStack deploy still serves health, holds, orders, and purchase saga end-to-end
- README / runbook paths still match exported outputs

**Prerequisite:** Phase 6 complete (happy path + compensation exist so `PurchaseSaga` is a real boundary).

---

## Phase 8 — Streams, EventBridge, notifications (sliced)

**Goal:** Domain events follow data changes; fans can be notified without coupling.

**Pipeline:** Orders stream → `stream-relay` → EventBridge → SNS → SQS → SES

**Prerequisite:** Phase 7 composites — land this as `DomainEvents`, not paste into the stack.

First event only: `OrderConfirmed` from MarkConfirmed (`PENDING` → `CONFIRMED`). No Seats stream, no refund detail types yet.

### Slice 8a — Orders stream + relay that logs

**Goal:** Prove Streams fire on confirm; relay receives and filters records. No bus yet.

**Build**

- Enable Orders stream (`NEW_AND_OLD_IMAGES`) in `DataPlane`
- `go/stream-relay` Lambda (same zip packaging as hold-sweeper)
- `DomainEvents` construct: stream event source → relay
- Relay logs structured `OrderConfirmed candidate` for `MODIFY` + `PENDING`→`CONFIRMED` only

**Verify**

- Hold → create-order → saga succeeds
- Stream-relay logs show one candidate per confirm (`orderId`, `eventId`, `userId`, `seatIds`)

**Status:** Done — stream + `DomainEvents` + log-only relay.

### Slice 8b — EventBridge bus

**Goal:** Stream change becomes a domain event on a bus you can inspect without email.

**Build**

- Custom EventBridge bus in `DomainEvents`
- Contracts: detail-type `OrderConfirmed`, source `gatehold.orders`
- Relay `PutEvents`; temporary rule → **log Lambda** (`order-confirmed-logger`)
  - Prefer Lambda over CloudWatch Logs target: MiniStack accepts the CW Logs target in the API but does not deliver events into the log group

**Verify**

- Confirm order → relay logs `OrderConfirmed published`
- Logger Lambda logs `OrderConfirmed received` with the contract detail

**Status:** Done — custom bus `gatehold-{stage}`, PutEvents, logger Lambda rule.

### Slice 8c — SNS → SQS

**Goal:** Fan-out from the bus; SQS is the MiniStack inspect surface.

**Build**

- EventBridge rule → SNS topic → SQS (+ DLQ)
- Outputs: topic ARN, queue URL

**Done when:** Confirm → message on notify queue via `/_ministack/sqs/messages`.

**Status:** Done — topic `gatehold-{stage}-order-notifications`, queue + DLQ, rule `order-confirmed-sns`.

### Slice 8d — SES email consumer

**Goal:** End-to-end notification without SES in the saga.

**Build**

- SQS → Go `notify-email` Lambda → SES `SendEmail`
- Runbook: `/_ministack/ses/messages` after confirm
- Document: duplicate stream deliveries may enqueue twice (ok for Phase 8)

**Done when:** Confirm produces a visible SES artifact; saga still has no SES calls.

**Status:** Done — `gatehold-{stage}-notify-email` drains notify SQS; MiniStack SES inspect.

**Learn (whole Phase 8)**

- Why stream relay beats a separate outbox for this design
- Decoupling producers from email/analytics
- Stream record ≠ domain event (8a vs 8b)

---

## Phase 9 — Auth, IAM, and secrets (sliced)

**Goal:** Real identity and least privilege without changing business rules.

**Invariant:** Hold / order / saga business rules stay the same — only *who is trusted* and *how config/IAM are scoped* change.

**Identity (from 9b):** `userId` / `holdOwner` = Cognito JWT `sub`. Login usernames stay readable (`alice`, `admin`).

**Prerequisite:** Phase 7 composites — land Cognito as an `Auth` construct, not paste into the stack.

### Slice 9a — Cognito pool + local users

**Goal:** Identity exists outside the API. Prove you can mint a JWT. No authorizer yet; `X-User-Id` stub stays.

**Build**

- `Auth` construct: UserPool + UserPoolClient (`USER_PASSWORD_AUTH` / `ADMIN_USER_PASSWORD_AUTH`) + group `admin`
- Outputs: `UserPoolId`, `UserPoolClientId`, `UserPoolIssuer`
- `npm run seed:auth` — confirmed users `alice` (fan) and `admin` (in `admin` group); prints `sub` + claims
- Runbook / api.md: InitiateAuth against MiniStack
- StackPort: include `cognito` in `STACKPORT_SERVICES`

**Verify**

- Deploy → `seed:auth` → IdToken decodes with `sub`, `cognito:username`, and for admin `cognito:groups` includes `admin`
- Hold/order with `X-User-Id` still works unchanged

**Status:** Done — `Auth` construct, outputs, `seed:auth` (`alice` + `admin` / group `admin`), JWT claims verified on MiniStack; `X-User-Id` stub unchanged.

### Slice 9b — JWT authorizer + identity from claims

**Goal:** Unauthenticated writes fail at the edge; Lambdas take identity only from the authorizer.

**Build**

- Cognito authorizer on `POST .../holds` and `POST /orders`; `GET /health` stays open
- Shared `callerUserId(event)` → `requestContext.authorizer.claims.sub`; drop `X-User-Id` stub
- Update contracts, api.md, Postman for `Authorization: Bearer`

**Verify:** no token → 401; fan JWT → hold/order owned by that `sub`; hold → order → saga still confirms

**Status:** Not started.

### Slice 9c — Admin group + reserved admin routes

**Goal:** Admin surface exists without Phase 11 behavior.

**Build**

- `POST /admin/events/{eventId}/cancel`, `GET /admin/events/{eventId}/refunds`
- Require `cognito:groups` contains `admin` → else 403; admin → `501` until Phase 11

**Verify:** fan JWT → 403; admin JWT → 501

**Status:** Not started.

### Slice 9d — Secrets + least-privilege IAM

**Goal:** Config out of plain hardcoding where it matters; roles match the known call graph.

#### 9d.1 — Emulator + Config construct (no behavior change)

**Build:** StackPort `secretsmanager` + `ssm`; `Config` construct (mock-payment secret + SSM hold TTL / max seats / refund rate); outputs only — Lambdas unchanged.

**Verify:** deploy; secret + params exist; hold → order → saga still via existing env.

**Status:** Done — `Config` construct, StackPort `secretsmanager`+`ssm`, outputs; Lambdas still on env/constants.

#### 9d.2 — Secrets Manager → payment Lambdas

**Build:** Payment steps resolve URL via `GetSecretValue` (secret ARN in env); `grantRead` only those four; drop plain `MOCK_PAYMENT_URL` env.

**Verify:** happy-path purchase hits mock via secret.

**Status:** Not started.

#### 9d.3 — SSM → hold TTL + seat cap (+ refund-rate stub)

**Build:** Hold duration + max seats from Parameter Store; refund-rate param unused until Phase 11.

**Verify:** `expiresAt` / over-cap 400; purchase path green.

**Status:** Not started.

#### 9d.4 — Least-privilege IAM + permission map

**Build:** Narrow over-broad grants; document Lambda → actions → resources.

**Verify:** full purchase + notify path after narrowing.

**Status:** Not started.

**Learn (whole Phase 9)**

- Never trusting `userId` from the body
- Scoping IAM after the call graph is known (why this phase is late)

**Done when (whole Phase 9)**

- Unauthenticated writes fail
- Fan cannot call admin routes
- Hold/order still work end-to-end with JWTs

---

## Phase 10 — Signed tickets

**Goal:** Confirmed orders produce verifiable tickets.

**Build**

- KMS sign (or emulator-appropriate approach); S3 object per ticket
- Presigned download URL on confirm / get-order
- Verification helper: signature valid **and** event not `CANCELLED`
- Wire real IssueTicket into the saga (replace Phase 6 stub)

**Learn**

- Tamper-evident artifacts vs authorization (cancelled event still rejects)

**Done when**

- Confirmed order → ticket bytes in S3
- Tampered payload fails verification
- Cancelled event fails verification even with a valid signature (can fully prove after Phase 11)

---

## Phase 11 — Event cancellation and mass refunds

**Goal:** Cancel stops selling and refunds every paid order once, under rate limits.

**Build**

- `cancel-event`: `ON_SALE → CANCELLING` conditional write; reject new holds/orders; VerifyHold fails when not on sale
- `refund-orchestrator`: page orders by `eventId`+`status`, create `RefundBatch`, enqueue jobs
- `refund-worker`: capped concurrency, idempotent refund key per order, conditional ledger `REFUND`, handle `429` with longer visibility delay
- Unknown refund → status query before retry
- Batch counters (`ADD`), S3 report, DLQ + alarm hooks
- Re-run / sweep until no non-terminal paid orders remain
- Failure tests: throttle, duplicate refund message, orchestrator crash mid-batch

**Learn**

- Backpressure with SQS instead of blasting the provider
- Exactly-once *effect* with at-least-once delivery
- Cancellation races with in-flight sagas

**Done when**

- After cancel, no new holds/orders succeed
- Every `CONFIRMED` order becomes `REFUNDED` exactly once (ledger + order status)
- Batch reaches `COMPLETE` or `COMPLETE_WITH_FAILURES` with DLQ for poison messages

**Prerequisite:** Saga capture + ledger + mock refund APIs. Do not start this phase on a happy-path-only payment stub.

---

## Phase 12 — Reconciler and auditor

**Goal:** Independent repair and verification.

**Build**

- `reconciler` (Go): find contradictions (e.g. `CONFIRMED` without `SOLD` seats, cancelled event with unrefunded paid order) and repair or flag
- `auditor` (Go): read-only invariant checks after a run (oversell, double charge, double refund, partial groups)
- Schedule reconciler; run auditor manually after load/failure tests
- Document invariants in `contracts.md` or a short `docs/invariants.md` if the list grows

**Learn**

- Why the system should not grade its own homework
- Reconciliation as a product feature, not a one-off script

**Done when**

- Injected inconsistency is fixed or alarmed by reconciler
- Auditor exits non-zero on oversell / double refund

---

## Phase 13 — Observability

**Goal:** See contention, saga health, and refund backpressure.

**Build**

- Structured JSON logs with `orderId` / `batchId` / `holdId`
- Custom metrics: conditional check failures, transaction conflicts, saga failures, refund rate, DLQ depth
- Alarms: DLQ non-empty, saga failure rate, refund batch stuck, API 5xx
- X-Ray (or emulator-safe tracing notes) across API → SQS → saga

**Learn**

- Which metrics prove the guarantees (zeros that matter)
- Alerting on symptoms (DLQ, stuck batch) not only on crashes

**Done when**

- One dashboard (CloudWatch or exported screenshots) covers purchase + refund paths
- You can point to the metric that would catch oversell pressure (conflict rate) and refund stall (queue age)

---

## Phase 14 — Failure suite, load test, results

**Goal:** Evidence for the README results table.

**Build**

- Expand `tests/failure` for the scenarios in the README failure table (pick a prioritized subset first)
- `loadgen` (Go): burst holds/orders including `group-share`
- Run load on **real AWS** for published numbers; keep MiniStack for functional failure tests
- Fill README results + cost per 1,000 purchases
- Billing alarm before any sustained AWS run; destroy stacks after

**Learn**

- What actually breaks under contention
- Difference between emulator correctness and cloud performance

**Done when**

- Auditor passes after a load run (or failures are explained and fixed)
- Results table has measured values, not estimates

---

## Phase 15 — CI/CD and environments (optional polish)

**Goal:** Repeatable deploys for portfolio credibility.

**Build**

- CI: lint, unit tests, `go test -race`, cdk synth
- `dev` / `prod` stages via CDK context
- Optional canary or alias for critical Lambdas
- Protect prod account with spend limits

**Done when**

- Main branch runs tests on every push
- Deploy to `dev` is one documented command

---

## Suggested learning milestones (demo checkpoints)

Use these as “I can show this” moments while learning:

| Milestone | After phase | Demo |
|---|---|---|
| A | 1–2 | Two terminals race one seat; winner/loser; expiry reclaim |
| B | 3 | Family of four holds a block; overlapping group gets `409` |
| C | 4–6 | Full purchase with mock payment chaos; show compensation |
| D | 7 | Stack is composed constructs; same purchase path still works |
| E | 11 | Cancel mid-sale; refund batch completes; no double refunds |
| F | 12–14 | Load run + auditor green; README results filled |

---

## Phase dependency graph

```text
0 Foundations
 └── 1 Single-seat hold
      └── 2 Expiry + sweeper logic (manual go run)
           └── 2b EventBridge Scheduler → sweeper Lambda
                └── 3 Group holds
                     └── 4 Orders + idempotency + SQS
                          └── 5 Mock payment
                               └── 6 Saga + ledger + PAYING
                                    └── 7 CDK composites (infra refactor)
                                         ├── 8a Orders stream + stream-relay (log)
                                         │    └── 8b EventBridge bus
                                         │         └── 8c SNS → SQS
                                         │              └── 8d SES consumer
                                         ├── 9a Cognito pool + users
                                         │    └── 9b JWT authorizer + claims
                                         │         └── 9c Admin routes (501)
                                         │              └── 9d.1 Config → 9d.2 Secret → 9d.3 SSM → 9d.4 IAM
                                         ├── 10 Signed tickets
                                         └── 11 Cancel + refunds
                                              └── 12 Reconciler + auditor
                                                   └── 13 Observability
                                                        └── 14 Load / failure / results
                                                             └── 15 CI/CD (optional)
```

**Phase 7 is required before Phase 8+** so new domains become constructs, not more paste. Phases 8–10 can overlap slightly after Phase 7, but **Phase 11 must not start** until capture + ledger + mock refunds work.

---

## Tracking progress

Copy into a notebook or tick in place:

- [x] Phase 0 — Local loop and shared foundations
- [x] Phase 1 — Single-seat hold
- [x] Phase 2 — Hold expiry correctness (sweeper logic)
- [x] Phase 2b — EventBridge Scheduler → sweeper Lambda
- [x] Phase 3 — Group holds (explicit `seatIds` + `TransactWriteItems`)
- [x] Phase 4 — Orders, idempotency, SQS
- [ ] Phase 5 — Mock payment provider
- [x] Phase 6 — Purchase saga
- [x] Phase 7 — CDK composite constructs (infra refactor)
- [x] Phase 8a — Orders stream + stream-relay (log)
- [x] Phase 8b — EventBridge bus + OrderConfirmed
- [x] Phase 8c — SNS → SQS
- [x] Phase 8d — SES email consumer
- [x] Phase 9a — Cognito pool + local users
- [ ] Phase 9b — JWT authorizer + identity from claims
- [ ] Phase 9c — Admin group + reserved admin routes
- [x] Phase 9d.1 — Config construct + StackPort secrets/ssm
- [ ] Phase 9d.2 — Secrets Manager → payment Lambdas
- [ ] Phase 9d.3 — SSM hold TTL + seat cap
- [ ] Phase 9d.4 — Least-privilege IAM + permission map
- [ ] Phase 10 — Signed tickets
- [ ] Phase 11 — Cancellation and mass refunds
- [ ] Phase 12 — Reconciler and auditor
- [ ] Phase 13 — Observability
- [ ] Phase 14 — Failure suite, load, results
- [ ] Phase 15 — CI/CD (optional)

When you complete a phase, add a short note under README “What I Learned” the same day — future you will forget the bug that taught the lesson.
