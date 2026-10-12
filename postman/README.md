# Postman (Gatehold local)

Canonical location for the Gatehold API collection. Matches [`docs/api.md`](../docs/api.md).

## Import into Postman Desktop

1. Delete any old **Gatehold** collection / **Gatehold MiniStack** environment.
2. **Import** both files from this folder:
   - [`Gatehold.postman_collection.json`](./Gatehold.postman_collection.json)
   - [`Gatehold.postman_environment.json`](./Gatehold.postman_environment.json)
3. Top-right → select **Gatehold MiniStack**
4. Agent → **Desktop Agent** (not Cloud)
5. Run **1. Health — liveness** → expect `200` with `"ok": true`

## After reset / redeploy

API id changes. Refresh `gatewayBase`:

```bash
node -e "const id=new URL(require('./.cdk-outputs.json')['Gatehold-dev'].ApiUrl).hostname.split('.')[0]; console.log('http://localhost:4566/_aws/execute-api/'+id+'/dev')"
```

Paste into Environments → Gatehold MiniStack → `gatewayBase`.

## Git-native (Cursor Postman plugin / CLI)

```text
postman/
  collections/Gatehold/     # one YAML file per request
  environments/             # Gatehold MiniStack.environment.yaml
```

Do **not** run `postman init` under `docs/` — it creates a nested `postman/postman/` tree. Keep everything under repo-root `postman/`.
