# API — local testing cheat sheet

Endpoints implemented so far (Phase 0–1). Use this to hit MiniStack **one call at a time**.

**Postman:** delete old Gatehold items, then import both files under [`../postman/`](../postman/) — steps in [`../postman/README.md`](../postman/README.md).

Contracts / shapes: [`contracts.md`](./contracts.md). Ops / deploy: [`runbook.md`](./runbook.md).

---

## Before you call anything

```bash
# 1) MiniStack up (port 4566)
npm run ministack:up
npm run ministack:health

# 2) Env + deploy + seed
set -a && source .env.example && set +a
npm run deploy:local
npm run seed
```

Seed defaults: event `evt_001`, seats `A-12-01` … `A-12-50`, all `AVAILABLE`.

### Base URL (MiniStack)

CDK prints an `execute-api` URL; against MiniStack call via the emulator edge:

```bash
set -a && source .env.example && set +a

API_ID=$(node -e "const o=require('./.cdk-outputs.json'); const u=o['Gatehold-dev'].ApiUrl; console.log(new URL(u).hostname.split('.')[0])")
BASE="http://localhost.localstack.cloud:4566/restapis/${API_ID}/dev/_user_request_"

echo "$BASE"
```

Every curl below assumes `$BASE` is set in that shell.

Optional UI: StackPort at [http://localhost:8080](http://localhost:8080) (must be **gatehold-stackport**, not another project).

---

## 1. Health — liveness

```http
GET /health
```

```bash
curl -sS "$BASE/health" | jq .
```

**Expect `200`:**

```json
{
  "ok": true,
  "stage": "dev",
  "tables": {
    "events": "gatehold-dev-events",
    "seats": "gatehold-dev-seats"
  },
  "hint": "Pass ?eventId=evt_001&seatId=A-12-01 after seeding to verify DynamoDB"
}
```

---

## 2. Health — read one seat

```http
GET /health?eventId={eventId}&seatId={seatId}
```

```bash
curl -sS "$BASE/health?eventId=evt_001&seatId=A-12-01" | jq .
```

**Expect `200`** with the seat item (`status: AVAILABLE` after a fresh seed).

**Expect `404`** if the seat does not exist.

```bash
# missing seat
curl -sS "$BASE/health?eventId=evt_001&seatId=Z-99-99" | jq .
```

---

## 3. Hold — single seat (happy path)

```http
POST /events/{eventId}/holds
Content-Type: application/json
X-User-Id: alice   # optional; defaults to test-user
```

```bash
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -H "X-User-Id: alice" \
  -d '{"seatIds":["A-12-07"]}' | jq .
```

**Expect `201`:**

```json
{
  "holdId": "h_…",
  "seatIds": ["A-12-07"],
  "expiresAt": "…ISO…   // now + 5 minutes"
}
```

Confirm in DynamoDB / UI or:

```bash
curl -sS "$BASE/health?eventId=evt_001&seatId=A-12-07" | jq .
# status should be HELD; holdOwner alice
```

---

## 4. Hold — conflict (already held)

Same seat, different user (hold still live):

```bash
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -H "X-User-Id: bob" \
  -d '{"seatIds":["A-12-07"]}' | jq .
```

**Expect `409`:**

```json
{
  "message": "seat not available",
  "eventId": "evt_001",
  "seatId": "A-12-07"
}
```

---

## 5. Hold — bad request

```bash
# empty seatIds
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -d '{"seatIds":[]}' | jq .

# two seats (Phase 3 only)
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -d '{"seatIds":["A-12-01","A-12-02"]}' | jq .
```

**Expect `400`.**

---

## 6. Hold — reclaim expired seat (optional)

If you manually set a seat’s `expiresAt` to the past in StackPort / SDK while keeping `status=HELD`, a new hold should succeed (`201`). Live holds still return `409`.

Hold length: **5 minutes**. Waiting that long also works; no sweeper required for reclaim (condition uses `expiresAt < now`).

---

## Suggested one-by-one order

| # | Call | Passes when |
|---|---|---|
| 1 | `GET /health` | `ok: true` |
| 2 | `GET /health?eventId&seatId` | seat JSON |
| 3 | `POST .../holds` (alice, free seat) | `201` |
| 4 | Same seat again (bob) | `409` |
| 5 | Bad body | `400` |
| 6 | Re-check seat via health | `HELD` |

---

## Reset and retry

```bash
npm run ministack:reset
set -a && source .env.example && set +a
npm run deploy:local
npm run seed
# re-export API_ID / BASE (outputs may change after reset)
```

---

## Not implemented yet

Do not expect these to work:

- Group holds (`groupSize` / multi-seat) — Phase 3
- `POST /orders`, payment, saga — later phases
- Cognito JWT — Phase 8 (`X-User-Id` stub only)
