# API — local testing cheat sheet

Endpoints implemented so far (Phase 0–4: holds + orders). Use this to hit MiniStack **one call at a time**.

**Postman:** import both JSON files under [`../postman/`](../postman/) — folders Health / Holds / Orders; variants live under **Examples**. Steps in [`../postman/README.md`](../postman/README.md).

Contracts / shapes: [`contracts.md`](./contracts.md). Ops / deploy: [`runbook.md`](./runbook.md).

---

## Before you call anything

```bash
# 1) Docker: MiniStack :4566 + StackPort :8080 + mock-payment :8090
npm run ministack:up
npm run ministack:health

# 2) Env + deploy + seed  (or: npm run local:ready)
set -a && source .env.example && set +a
npm run deploy:local
npm run seed
```

Observability while testing: StackPort [http://localhost:8080](http://localhost:8080); Phase 8 via runbook (`stream-relay` → logger → SNS/SQS → notify-email → `/_ministack/ses/messages`).

Seed defaults: event `evt_001`, seats `A-12-01` … `A-12-50`, all `AVAILABLE`.

### Base URL (MiniStack)

CDK prints an `execute-api` URL; against MiniStack use the emulator edge (same shape as Postman `gatewayBase`):

```bash
set -a && source .env.example && set +a

API_ID=$(node -e "const o=require('./.cdk-outputs.json'); const u=o['Gatehold-dev'].ApiUrl; console.log(new URL(u).hostname.split('.')[0])")
BASE="http://localhost:4566/_aws/execute-api/${API_ID}/dev"

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
  "seatIds": ["A-12-07"]
}
```

---

## 5. Hold — group (multi-seat)

```bash
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -H "X-User-Id: alice" \
  -d '{"seatIds":["A-12-30","A-12-31"]}' | jq .
```

**Expect `201`** with both `seatIds` and one `holdId`.

Overlap (second client shares a seat):

```bash
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -H "X-User-Id: bob" \
  -d '{"seatIds":["A-12-31","A-12-32"]}' | jq .
```

**Expect `409`** — nothing new held (no half-hold on `A-12-32`).

---

## 6. Hold — bad request

```bash
# empty seatIds
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -d '{"seatIds":[]}' | jq .

# over cap (max 8)
curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -d '{"seatIds":["A-12-01","A-12-02","A-12-03","A-12-04","A-12-05","A-12-06","A-12-07","A-12-08","A-12-09"]}' | jq .
```

**Expect `400`.**

---

## 7. Hold — reclaim expired seat (optional)

If you manually set a seat’s `expiresAt` to the past in StackPort / SDK while keeping `status=HELD`, a new hold should succeed (`201`). Live holds still return `409`.

Hold length: **5 minutes**. Waiting that long also works; no sweeper required for reclaim (condition uses `expiresAt < now`).

---

## 8. Order — accept hold (`202`)

Use a **fresh** hold (new seat or after reset). Capture `holdId` / `seatIds` from the hold response.

```http
POST /orders
Content-Type: application/json
Idempotency-Key: <uuid>   # required
X-User-Id: alice          # must match holdOwner
```

```bash
# 1) Hold
HOLD=$(curl -sS -X POST "$BASE/events/evt_001/holds" \
  -H "content-type: application/json" \
  -H "X-User-Id: alice" \
  -d '{"seatIds":["A-12-40"]}')
echo "$HOLD" | jq .
HOLD_ID=$(echo "$HOLD" | jq -r .holdId)

# 2) Accept order
IDEM="idem-$(uuidgen | tr '[:upper:]' '[:lower:]')"
ORDER=$(curl -sS -X POST "$BASE/orders" \
  -H "content-type: application/json" \
  -H "X-User-Id: alice" \
  -H "Idempotency-Key: $IDEM" \
  -d "{\"eventId\":\"evt_001\",\"holdId\":\"$HOLD_ID\",\"seatIds\":[\"A-12-40\"]}")
echo "$ORDER" | jq .
```

**Expect `202`:**

```json
{
  "orderId": "ord_…",
  "status": "PENDING"
}
```

Seat should be `PAYING`:

```bash
curl -sS "$BASE/health?eventId=evt_001&seatId=A-12-40" | jq .
```

Message stays on the order queue (**no consumer** in Phase 4):

```bash
curl -sS http://localhost:4566/_ministack/sqs/messages | jq .
```

---

## 9. Order — same Idempotency-Key (no second order)

```bash
curl -sS -X POST "$BASE/orders" \
  -H "content-type: application/json" \
  -H "X-User-Id: alice" \
  -H "Idempotency-Key: $IDEM" \
  -d "{\"eventId\":\"evt_001\",\"holdId\":\"$HOLD_ID\",\"seatIds\":[\"A-12-40\"]}" | jq .
```

**Expect `202`** with the **same** `orderId` as step 8 (stored response). SQS should not gain a duplicate accept from this retry once the key is `ACCEPTED`.

---

## 10. Order — missing key / foreign hold

```bash
# missing Idempotency-Key → 400
curl -sS -X POST "$BASE/orders" \
  -H "content-type: application/json" \
  -H "X-User-Id: alice" \
  -d '{"eventId":"evt_001","holdId":"h_x","seatIds":["A-12-41"]}' | jq .

# bob tries alice's hold → 409
curl -sS -X POST "$BASE/orders" \
  -H "content-type: application/json" \
  -H "X-User-Id: bob" \
  -H "Idempotency-Key: idem-bob-1" \
  -d "{\"eventId\":\"evt_001\",\"holdId\":\"$HOLD_ID\",\"seatIds\":[\"A-12-40\"]}" | jq .
```

---

## Suggested one-by-one order

| # | Call | Passes when |
|---|---|---|
| 1 | `GET /health` | `ok: true` |
| 2 | `GET /health?eventId&seatId` | seat JSON |
| 3 | `POST .../holds` (alice, free seat) | `201` |
| 4 | Same seat again (bob) | `409` |
| 5 | Group hold (2 seats) | `201` |
| 6 | Overlapping group | `409` |
| 7 | Bad body (empty / >8) | `400` |
| 8 | Re-check seat via health | `HELD` |
| 9 | `POST /orders` (alice + Idempotency-Key) | `202`, seat `PAYING` |
| 10 | Same `Idempotency-Key` again | same `orderId` |
| 11 | Inspect SQS (`/_ministack/sqs/messages`) | order message present |

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

## Phase 9a — Cognito login (get an IdToken)

Pool + client exist after deploy. Login returns a JWT for learning; **write routes do not require it until 9b** (still use `X-User-Id`).

| | |
|---|---|
| Pool name | `gatehold-dev` |
| Pool id | `.cdk-outputs.json` → `UserPoolId` (admin Cognito APIs) |
| Client id | `.cdk-outputs.json` → `UserPoolClientId` (**login** uses this) |
| Seeded users | `alice` (fan), `admin` (group `admin`) |
| Password | `Gatehold1!` |

### Seed users (once per MiniStack reset / redeploy)

```bash
# from repo root (Gatehold/), not go/
npm run seed:auth
```

Prints each user’s `sub` and JWT claims (including `cognito:groups` for `admin`).

**Postman:** after seed, **Auth → Login as alice** (or **Login as admin**) against MiniStack. Set env `userPoolClientId` from outputs; password env `cognitoPassword` defaults to `Gatehold1!`. Test script saves `idToken`.

### Login — get IdToken (AWS CLI)

```bash
set -a && source .env.example && set +a

POOL_CLIENT=$(node -e "console.log(require('./.cdk-outputs.json')['Gatehold-dev'].UserPoolClientId)")

# Fan
aws --endpoint-url "$AWS_ENDPOINT_URL" cognito-idp initiate-auth \
  --client-id "$POOL_CLIENT" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=alice,PASSWORD=Gatehold1! \
  --query 'AuthenticationResult.IdToken' --output text

# Admin (same password; token includes cognito:groups = ["admin"])
aws --endpoint-url "$AWS_ENDPOINT_URL" cognito-idp initiate-auth \
  --client-id "$POOL_CLIENT" \
  --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=admin,PASSWORD=Gatehold1! \
  --query 'AuthenticationResult.IdToken' --output text
```

Save the printed string — that is the **IdToken** (JWT). In Phase 9b you will send it as:

```http
Authorization: Bearer <IdToken>
```

### Decode claims (optional)

```bash
TOKEN='paste-IdToken-here'
python3 -c "import sys,base64,json; p=sys.argv[1].split('.')[1]; p+='='*((-len(p))%4); print(json.dumps(json.loads(base64.urlsafe_b64decode(p)),indent=2))" "$TOKEN"
```

Expect at least: `sub`, `cognito:username`, `iss` (matches `UserPoolIssuer`). For `admin`, also `cognito:groups: ["admin"]`.

### Until Phase 9b

Hold/order curls still use `-H "X-User-Id: alice"`. A Bearer token is ignored by the API today.

## Not implemented yet

Do not expect these to work:

- `groupSize` / server block search (optional; Phase 3 ships explicit `seatIds` only)
- API Gateway JWT authorizer / identity from `sub` — Phase 9b
- Admin cancel/refund routes — Phase 9c (`501` stubs) / Phase 11
- Cognito-required writes — Phase 9b (`X-User-Id` stub still active)
