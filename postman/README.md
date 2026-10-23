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
| **Health** | Liveness, Get seat | Smoke / inspect seat status |
| **Holds** | Hold seats | `POST .../holds` → `HELD` |
| **Orders** | Accept order | `POST /orders` → `PAYING` + `PENDING` |
| **Mock payment** | Authorize, Capture, Void | Local `go/mock-payment` on `paymentBase` |

Variants (409, 400, group, idempotent retry) are under **Examples** on those requests — not separate top-level calls.

### Happy path (API Gateway)

1. **Holds → Hold seats** (saves `holdId` + `seatIdsJson`)  
2. **Orders → Accept order** (uses that hold; sets `orderId`)  
3. **Health → Get seat** (expect `PAYING`)

### Happy path (mock payment)

Start the mock first (`cd go && go run ./mock-payment`). Uses `paymentBase` (default `http://127.0.0.1:8090`), not `gatewayBase`.

1. **Mock payment → Health** (`ok: true`)  
2. **Mock payment → Authorize** (saves `paymentAuthId`; mints `paymentOrderId` if empty)  
3. Either **Capture** (`CAPTURED`) or **Void** (`VOIDED`)

## After redeploy

Update `gatewayBase`:

```bash
node -e "const id=new URL(require('./.cdk-outputs.json')['Gatehold-dev'].ApiUrl).hostname.split('.')[0]; console.log('http://localhost:4566/_aws/execute-api/'+id+'/dev')"
```

Use a free `seatId` (or reset + seed) before Hold seats. Clear `idempotencyKey` in the environment if you want a new key on the next Accept order.
