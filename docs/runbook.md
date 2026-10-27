# Runbook

Operational procedures for Gatehold.

---

## Mental model: one app, two targets

You write **one** CDK stack (`infra/`) and **one** style of AWS SDK code (`services/`, `scripts/`).  
CDK turns that infra into **CloudFormation**. Where CloudFormation runs depends on the command:

```text
                    infra/ + services/  (same code)
                              │
                              │  CDK → CloudFormation
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      npm run deploy:local            npm run deploy:aws
              │                               │
              ▼                               ▼
           cdklocal                          cdk
     (read AWS_ENDPOINT_URL           (unset endpoints;
      from shell / .env)               use real AWS login)
              │                               │
              ▼                               ▼
        MiniStack :4566                  Real AWS account
         local / free                    real CFN + bill
              │                               │
              ▼                               ▼
     Call APIs on localhost           Call real ApiUrl
     (emulator edge port)             (execute-api…)
```

| | Local (learning default) | Real AWS |
|---|---|---|
| Deploy command | `npm run deploy:local` | `npm run deploy:aws` |
| Tool | `cdklocal` | `cdk` |
| Auth | Fake keys (`test` / `test` in `.env.example`) | IAM user / SSO profile (`aws configure`) |
| Endpoint | `AWS_ENDPOINT_URL` → MiniStack | **No** `AWS_ENDPOINT_URL` |
| CloudFormation | Emulated inside MiniStack | Real CloudFormation in your account |
| SDK calls | Same code; pointed at MiniStack | Same code; pointed at AWS |
| After deploy | Resources live until reset/restart | AWS keeps the stack until you destroy/update |

**Important details**

- `deploy:local` does **not** set `AWS_ENDPOINT_URL` itself. You load it first (`source .env.example`), then `cdklocal` reads it and talks to MiniStack.
- `deploy:aws` **unsets** those endpoints so CDK cannot accidentally hit MiniStack; it uses credentials already on your machine (not stored in git).
- Changing infra → deploy again. CloudFormation updates what changed; it does not “auto-maintain” until the next deploy.
- App SDK code (seed, Lambda handlers) works on both targets: with endpoint = local, without = real AWS.

---

## Local AWS with MiniStack

Gatehold uses [MiniStack](https://github.com/ministackorg/ministack) as the local AWS emulator (DynamoDB, Lambda, SQS, Step Functions, EventBridge, etc. on port `4566`).

### Start (emulator + UI + mock payment)

`docker compose` brings up three services:

| Service | Port | Role |
|---|---|---|
| **ministack** | `4566` | Local AWS (DynamoDB, Lambda, SQS, Step Functions, EventBridge, Logs, …) |
| **stackport** | `8080` | Browser UI over that emulator |
| **mock-payment** | `8090` | Payment provider for the purchase saga |

```bash
npm run ministack:up      # compose up --build (includes mock-payment image)
npm run ministack:health
curl -sS http://127.0.0.1:8090/health || curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8090/
```

One-shot after Docker is running (up + deploy + seed):

```bash
npm run local:ready
```

You no longer need a separate `go run ./mock-payment` terminal for local saga tests — compose owns `:8090`. Host-side `go run` still works if you stop the compose service.

### DynamoDB UI (StackPort)

Compose also starts **StackPort** on port `8080`. It is a browser UI only — **not** a second DynamoDB. It talks to the MiniStack DynamoDB already on `:4566`.

```bash
npm run ministack:ui
# open http://localhost:8080
# DynamoDB → gatehold-dev-events / seats / orders / idempotency / ledger (after deploy + seed)
# Lambda → gatehold-dev-stream-relay (invoke logs)
# Step Functions → purchase saga executions
# Logs → /aws/lambda/… including stream-relay + order-confirmed-logger (Phase 8b)
```

### Load local env

```bash
set -a && source .env.example && set +a
```

This sets MiniStack endpoints, fake credentials, region, stage, and table names.  
Prefer this over hand-exporting; values stay in sync with `.env.example`.

### Deploy infra to MiniStack (through Phase 4)

```bash
set -a && source .env.example && set +a
npm run ministack:up
npm run deploy:local    # cdklocal bootstrap + deploy → writes .cdk-outputs.json
```

Deploys Events, Seats, **Orders** (with stream), **Idempotency**, **Ledger**, order SQS (+ DLQ), health / hold-seat / hold-sweeper / **create-order**, **saga-starter** + purchase saga, **DomainEvents** (stream-relay + EventBridge bus + OrderConfirmed → logs), and `POST /orders`. Payment steps call mock-payment on `:8090` (compose service, or host `go run`) via `host.docker.internal:8090`.

### Seed event + seats

```bash
set -a && source .env.example && set +a
npm run seed
npm run get-seat
```

### Smoke-test APIs (local)

Copy-paste curls for every live endpoint (health + hold + orders): [`api.md`](./api.md).

Stack outputs print an `execute-api` URL. Against MiniStack, call via the emulator edge port (API id = subdomain of `ApiUrl`):

```bash
API_ID=$(node -e "const o=require('./.cdk-outputs.json'); const u=o['Gatehold-dev'].ApiUrl; console.log(new URL(u).hostname.split('.')[0])")

curl "http://localhost.localstack.cloud:4566/restapis/${API_ID}/dev/_user_request_/health"
curl "http://localhost.localstack.cloud:4566/restapis/${API_ID}/dev/_user_request_/health?eventId=evt_001&seatId=A-12-01"
```

Flow: your curl → MiniStack API Gateway → health Lambda → DynamoDB (same emulator).

### Phase 2 — Hold sweeper (manual)

The sweeper cleans stale `HELD` rows in DynamoDB/UI. Phase 1’s hold condition (`expiresAt < now`) remains the concurrency gate — the sweeper is belt-and-suspenders; EventBridge Scheduler invokes the sweeper Lambda on a timer (Phase 2b).

```bash
# Env (same MiniStack vars as seed)
set -a && source .env.example && set +a

# 1) Hold a seat (Postman or curl — see api.md)
API_ID=$(node -e "const o=require('./.cdk-outputs.json'); console.log(new URL(o['Gatehold-dev'].ApiUrl).hostname.split('.')[0])")
BASE="http://localhost:4566/_aws/execute-api/${API_ID}/dev"
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -H "X-User-Id: alice" \
  -d '{"seatIds":["A-12-20"]}'

# 2) Age expiresAt to the past (or wait 5 minutes)
# StackPort UI, or a one-liner UpdateItem — keep status=HELD

# 3) Run sweeper
cd go && go run ./hold-sweeper
# expect: released >= 1; seat becomes AVAILABLE; holdId/holdOwner/expiresAt cleared

# 4) Idempotent second run
go run ./hold-sweeper
# expect: no error; seat still AVAILABLE

SEAT_ID=A-12-20 npm run get-seat
```

### Reset state between test runs

```bash
npm run ministack:reset
```

Reset clears emulator state — redeploy and reseed:

```bash
set -a && source .env.example && set +a
npm run deploy:local
npm run seed
```

### Stop

```bash
npm run ministack:down
```

### Useful MiniStack inspect endpoints

```bash
curl http://localhost:4566/_ministack/health
curl http://localhost:4566/_ministack/sqs/messages
curl http://localhost:4566/_ministack/ses/messages
```

### Phase 4 — Orders + SQS (no consumer)

After deploy + seed, follow hold → order → idempotent retry in [`api.md`](./api.md) (§8–10).

```bash
# Phase 6+: saga-starter drains the order queue and starts Step Functions
# (execution name = orderId). Inspect leftover messages / DLQ if needed:
curl -sS http://localhost:4566/_ministack/sqs/messages | jq .

# Stack outputs also include OrderQueueUrl / OrdersTableName / IdempotencyTableName
node -e "console.log(require('./.cdk-outputs.json')['Gatehold-dev'])"
```

StackPort: check `gatehold-dev-orders`, `gatehold-dev-idempotency`, and seats in `PAYING` after a successful accept.

---

## Real AWS (later)

Only when you intentionally want a cloud deploy. Set a **billing alarm** first.

```bash
# 1) Real credentials on this machine (not in git)
aws configure
# or: aws sso login --profile your-profile && export AWS_PROFILE=your-profile

# 2) Confirm identity
aws sts get-caller-identity

# 3) Deploy (script unsets MiniStack endpoints)
npm run deploy:aws

# 4) Seed / call API using real outputs — do NOT source MiniStack endpoints
unset AWS_ENDPOINT_URL AWS_ENDPOINT_URL_S3
export EVENTS_TABLE_NAME=gatehold-dev-events
export SEATS_TABLE_NAME=gatehold-dev-seats
npm run seed
curl "$(node -e "console.log(require('./.cdk-outputs.json')['Gatehold-dev'].ApiUrl)")health"
```

Destroy when done experimenting:

```bash
npm run destroy:aws
```

---

## npm script cheat sheet

| Script | Purpose |
|---|---|
| `ministack:up` / `down` / `reset` / `health` / `ui` | Local emulator + StackPort |
| `deploy:local` / `destroy:local` | CDK → MiniStack via `cdklocal` |
| `deploy:aws` / `destroy:aws` | CDK → real AWS via `cdk` |
| `seed` / `get-seat` | AWS SDK helpers (follow `AWS_ENDPOINT_URL` if set) |
| `build` | Typecheck |
| `cd go && go run ./hold-sweeper` | Phase 2: release expired HELD seats (needs env sourced) |

---

## Phase 0 checklist

- [x] MiniStack up (`npm run ministack:up`)
- [x] `npm run deploy:local`
- [x] `npm run seed` + `npm run get-seat`
- [x] `GET .../health?eventId=evt_001&seatId=A-12-01` returns the seat
- [x] StackPort UI available at http://localhost:8080

## Phase 2 checklist

- [x] `go run ./hold-sweeper` clears expired `HELD` → `AVAILABLE` on MiniStack
- [x] Second sweeper run is idempotent (no error; seat stays `AVAILABLE`)
- [x] Phase 2b — EventBridge Scheduler → sweeper Lambda

## Phase 4 checklist

- [x] Orders + Idempotency tables, order SQS + DLQ, `POST /orders` (create-order)
- [x] Same `Idempotency-Key` returns stored `202` (unit-tested; verify on MiniStack via [`api.md`](./api.md))
- [x] Expired / foreign hold → `409`; missing key → `400`
- [x] No queue consumer — inspect messages with `/_ministack/sqs/messages`

## Phase 7 checklist

- [x] `infra/lib/constructs/` — DataPlane, HoldCapability, OrderAccept, PurchaseSaga, HttpApi
- [x] `infra/lib/helpers/` — `createNodeFn`, `createGoFn`, `createSagaTask`, `addGateholdOutputs`
- [x] `gatehold-stack.ts` is a short composer (wire constructs + outputs only)
- [x] Output names unchanged (`ApiUrl`, table names, function names, saga ARN)
- [x] `cdk synth` + MiniStack smoke: health → hold → order → saga

## Phase 8a checklist

- [x] Orders table stream (`NEW_AND_OLD_IMAGES`) in `DataPlane`
- [x] `DomainEvents` construct + `go/stream-relay` (log `PENDING`→`CONFIRMED` only)
- [x] `npm run build:stream-relay` / `build:go-lambdas` wired into deploy
- [ ] After confirm: stream-relay logs show `OrderConfirmed candidate orderId=…`

Inspect relay logs (MiniStack / LocalStack-style):

```bash
aws --endpoint-url "$AWS_ENDPOINT_URL" logs tail /aws/lambda/gatehold-dev-stream-relay --since 10m --format short
```

## Phase 8b checklist

- [x] Custom EventBridge bus `gatehold-{stage}` + `OrderConfirmed` contract
- [x] stream-relay `PutEvents` (source `gatehold.orders`, detail-type `OrderConfirmed`)
- [x] Rule → `order-confirmed-logger` Lambda (MiniStack does **not** deliver EventBridge → CloudWatch Logs targets reliably; StackPort may show the rule without a working arrow)
- [ ] After confirm: logger logs `OrderConfirmed received` (and relay `OrderConfirmed published`)

```bash
# via Postman Domain events → Filter OrderConfirmed logger logs
# or AWS CLI / SDK against:
#   /aws/lambda/gatehold-dev-order-confirmed-logger
```

### Phase 8 local observe (after confirm)

With env sourced (`set -a && source .env.example && set +a`):

```bash
# 1) stream-relay saw the confirm and PutEvents
#    log group: /aws/lambda/gatehold-dev-stream-relay  (filter: OrderConfirmed)

# 2) EventBridge rule invoked order-confirmed-logger
#    log group: /aws/lambda/gatehold-dev-order-confirmed-logger  (filter: OrderConfirmed received)

# 3) Order row CONFIRMED — Postman Domain events → Get order, or StackPort DynamoDB
```

MiniStack inspect helpers (also useful later for 8c/8d):

```bash
curl -sS http://localhost:4566/_ministack/health | jq .
curl -sS http://localhost:4566/_ministack/sqs/messages | jq .
curl -sS http://localhost:4566/_ministack/ses/messages | jq .   # empty until 8d
```

## TODO (later)

- Replay refund DLQ
- Run loadgen and auditor after a sale
- Cancel an event and watch RefundBatch complete
- Billing alarm checklist before real AWS deploy
