# Runbook

Operational procedures for SeatLock.

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

SeatLock uses [MiniStack](https://github.com/ministackorg/ministack) as the local AWS emulator (DynamoDB, Lambda, SQS, Step Functions, EventBridge, etc. on port `4566`).

### Start

```bash
npm run ministack:up
npm run ministack:health
```

### DynamoDB UI (StackPort)

Compose also starts **StackPort** on port `8080`. It is a browser UI only — **not** a second DynamoDB. It talks to the MiniStack DynamoDB already on `:4566`.

```bash
npm run ministack:ui
# open http://localhost:8080
# DynamoDB → seatlock-dev-events / seatlock-dev-seats (after deploy + seed)
```

### Load local env

```bash
set -a && source .env.example && set +a
```

This sets MiniStack endpoints, fake credentials, region, stage, and table names.  
Prefer this over hand-exporting; values stay in sync with `.env.example`.

### Deploy Phase 0 infra to MiniStack

```bash
set -a && source .env.example && set +a
npm run ministack:up
npm run deploy:local    # cdklocal bootstrap + deploy → writes .cdk-outputs.json
```

### Seed event + seats

```bash
set -a && source .env.example && set +a
npm run seed
npm run get-seat
```

### Smoke-test the health API (local)

Stack outputs print an `execute-api` URL. Against MiniStack, call via the emulator edge port (API id = subdomain of `ApiUrl`):

```bash
API_ID=$(node -e "const o=require('./.cdk-outputs.json'); const u=o['SeatLock-dev'].ApiUrl; console.log(new URL(u).hostname.split('.')[0])")

curl "http://localhost.localstack.cloud:4566/restapis/${API_ID}/dev/_user_request_/health"
curl "http://localhost.localstack.cloud:4566/restapis/${API_ID}/dev/_user_request_/health?eventId=evt_001&seatId=A-12-01"
```

Flow: your curl → MiniStack API Gateway → health Lambda → DynamoDB (same emulator).

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
export EVENTS_TABLE_NAME=seatlock-dev-events
export SEATS_TABLE_NAME=seatlock-dev-seats
npm run seed
curl "$(node -e "console.log(require('./.cdk-outputs.json')['SeatLock-dev'].ApiUrl)")health"
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

---

## Phase 0 checklist

- [x] MiniStack up (`npm run ministack:up`)
- [x] `npm run deploy:local`
- [x] `npm run seed` + `npm run get-seat`
- [x] `GET .../health?eventId=evt_001&seatId=A-12-01` returns the seat
- [x] StackPort UI available at http://localhost:8080

## TODO (later)

- Replay refund DLQ
- Run loadgen and auditor after a sale
- Cancel an event and watch RefundBatch complete
- Billing alarm checklist before real AWS deploy
