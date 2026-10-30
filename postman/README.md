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
| **Auth** | Login as alice / admin | Phase 9a Cognito `InitiateAuth` → saves `idToken` |
| **Health** | Liveness, Get seat | Smoke / inspect seat (`AVAILABLE` → `HELD` → `PAYING` → `SOLD`) |
| **Holds** | Hold seats | `POST .../holds` → `HELD` |
| **Orders** | Accept / Get order | `POST /orders` → `PENDING`; `GET /orders/{orderId}` → status + ticket URLs when `CONFIRMED` |
| **Tickets** | Verify ticket | `POST /tickets/verify` with `{ payload, signature }` (no JWT) |
| **Admin** | Cancel / List refunds | Fan JWT → 403; admin JWT → 501 stubs (Phase 9c) |
| **Saga logs** | Filter verify-hold logs | MiniStack CloudWatch for VerifyHold |
| **Domain events** | stream-relay + logger + SES messages, Get order | Phase 8 observe after confirm |
| **Mock payment** | Authorize → Capture/Void/Refund + Status | Compose `:8090` (or host `go run`) |

Variants (409, 400, chaos, idempotent retry) are under **Examples** on those requests — not separate top-level calls (except **Authorize (chaos)**).

### Cognito login (Phase 9a)

Prereq: deploy + `npm run seed:auth` (creates `alice` / `admin`, password `Gatehold1!`).

1. Set env `userPoolClientId` from `.cdk-outputs.json` → `UserPoolClientId` (re-import or paste after redeploy).
2. **Auth → Login as alice** — Tests pass; env gets `idToken`, `aliceIdToken`, `cognitoSub`, `cognitoUsername`.
3. **Auth → Login as admin** — same; `cognitoGroups` should be `["admin"]`.

Holds/orders require `Authorization: Bearer {{idToken}}` (run Auth → Login as alice first).

Admin routes use a TOKEN authorizer (JWT + `admin` group): **Admin → Cancel/List as alice** → 403; **as admin** → 501 until Phase 11.

### Happy path (API Gateway + saga + Phase 8)

Prereq: `npm run ministack:up` (MiniStack + StackPort + mock-payment) then deploy + seed.

1. **Holds → Hold seats** (saves `holdId` + `seatIdsJson`)  
2. **Orders → Accept order** (uses that hold; sets `orderId`; saga runs)  
3. **Health → Get seat** — expect `PAYING`, then shortly `SOLD`  
4. **Orders → Get order** — poll until `CONFIRMED`; then `tickets[].downloadUrl`  
5. **Tickets → Verify ticket** — paste artifact JSON → `valid: true`  
6. Optional: **Domain events → Get order (DynamoDB)** — raw table inspect  
7. **Domain events → Filter stream-relay logs** — `OrderConfirmed published`  
8. **Domain events → Filter OrderConfirmed logger logs** — bus → logger Lambda artifact  
9. **Domain events → List SES messages** — notify-email → MiniStack SES artifact  
10. Optional: **Filter notify-email logs** — `OrderConfirmed email sent`  

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

Update `gatewayBase` and `userPoolClientId`:

```bash
node -e "const o=require('./.cdk-outputs.json')['Gatehold-dev']; const id=new URL(o.ApiUrl).hostname.split('.')[0]; console.log('gatewayBase=http://localhost:4566/_aws/execute-api/'+id+'/dev'); console.log('userPoolClientId='+o.UserPoolClientId)"
```

Paste into the **Gatehold MiniStack** environment. Re-run `npm run seed:auth` after Cognito pool recreate. Log groups / bus names stay:

- `streamRelayLogGroup` = `/aws/lambda/gatehold-dev-stream-relay`
- `orderConfirmedLoggerLogGroup` = `/aws/lambda/gatehold-dev-order-confirmed-logger`
- `domainEventBusName` = `gatehold-dev`
- `orderNotificationsQueueName` / topic = `gatehold-dev-order-notifications`
- `notifyEmailLogGroup` = `/aws/lambda/gatehold-dev-notify-email`

Use a free `seatId` (or reset + seed) before Hold seats. Clear `idempotencyKey` in the environment if you want a new key on the next Accept order.
