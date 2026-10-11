# Postman (Gatehold local)

## Clean import (do this once)

1. In Postman, **delete** any old “Gatehold” collection and “Gatehold MiniStack” environment.
2. **Import** both files from this folder:
   - `Gatehold.postman_collection.json`
   - `Gatehold.postman_environment.json`
3. Top-right → select **Gatehold MiniStack**
4. Agent → **Desktop Agent** (not Cloud)
5. Open **1. Health — liveness** — URL must show:

   `http://localhost:4566/_aws/execute-api/793b8602/dev/health`

6. Send. Expect `200` with `"ok": true`.

## After reset / redeploy

```bash
node -e "const id=new URL(require('./.cdk-outputs.json')['Gatehold-dev'].ApiUrl).hostname.split('.')[0]; console.log('http://localhost:4566/_aws/execute-api/'+id+'/dev')"
```

Paste into Environments → Gatehold MiniStack → `gatewayBase`.
