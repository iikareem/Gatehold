# Postman

## Import

1. Import:
   - `Gatehold.postman_collection.json`
   - `Gatehold.postman_environment.json`
2. Select environment **Gatehold MiniStack**
3. Use **Desktop Agent**

## Structure

| Folder | Main request | Purpose |
|---|---|---|
| **Health** | Liveness, Get seat | Smoke / inspect seat (`AVAILABLE` → `HELD` → `PAYING` → `SOLD`) |
| **Holds** | Hold seats | `POST .../holds` → `HELD` |
| **Orders** | Accept order | `POST /orders` → `PAYING` + `PENDING` (saga starts) |
| **Saga logs** | Filter verify-hold logs | MiniStack CloudWatch for VerifyHold |
| **Domain events** | stream-relay + logger logs, notify SQS, Get order | Phase 8 observe after confirm |
| **Mock payment** | Authorize → Capture/Void/Refund + Status | Compose `:8090` (or host `go run`) |

Variants (409, 400, chaos, idempotent retry) are under **Examples** on those requests — not separate top-level calls (except **Authorize (chaos)**).

### Happy path (API Gateway + saga + Phase 8)

Prereq: `npm run ministack:up` (MiniStack + StackPort + mock-payment) then deploy + seed.

1. **Holds → Hold seats** (saves `holdId` + `seatIdsJson`)  
2. **Orders → Accept order** (uses that hold; sets `orderId`; saga runs)  
3. **Health → Get seat** — expect `PAYING`, then shortly `SOLD`  
4. **Domain events → Get order** — expect `CONFIRMED`  
5. **Domain events → Filter stream-relay logs** — `OrderConfirmed published`  
6. **Domain events → Filter OrderConfirmed logger logs** — bus → logger Lambda artifact  
7. **Domain events → List notify SQS messages** — SNS → `gatehold-dev-order-notifications`  

Optional: **Saga logs → Filter verify-hold logs** for the saga step itself.

### Happy path (mock payment direct)

Uses `paymentBase` (default `http://127.0.0.1:8090`). Compose already exposes this; no separate terminal required.

1. **Mock payment → Health** (`ok: true`)  
2. **Mock payment → Authorize** (saves `paymentAuthId` + `paymentStatusKey`)  
3. Either **Capture** (`CAPTURED`) or **Void** (`VOIDED`)  
4. After Capture: **Refund** (`REFUNDED`)  
5. **Status** (uses `paymentStatusKey`)

### Chaos (unknown outcomes)

1. Set env `chaosForce` to `429`, `500`, `502`, `timeout`, or `latency`  
2. Run **Authorize (chaos)** (sends `X-Chaos-Force`)  
3. For `timeout`: response body may be empty; run **Status** with `paymentStatusKey`  
4. For fast local timeout: start mock with `CHAOS_TIMEOUT_MS=1` (override compose env if needed)

Also see Examples on **Authorize** for `429` / timeout / missing Content-Type.

## After redeploy

Update `gatewayBase`:

```bash
node -e "const id=new URL(require('./.cdk-outputs.json')['Gatehold-dev'].ApiUrl).hostname.split('.')[0]; console.log('http://localhost:4566/_aws/execute-api/'+id+'/dev')"
```

Paste into the **Gatehold MiniStack** environment. Log groups / bus names stay:

- `streamRelayLogGroup` = `/aws/lambda/gatehold-dev-stream-relay`
- `orderConfirmedLoggerLogGroup` = `/aws/lambda/gatehold-dev-order-confirmed-logger`
- `domainEventBusName` = `gatehold-dev`
- `orderNotificationsQueueName` / topic = `gatehold-dev-order-notifications`

Use a free `seatId` (or reset + seed) before Hold seats. Clear `idempotencyKey` in the environment if you want a new key on the next Accept order.
