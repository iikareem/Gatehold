# Postman

## Import

1. Import:
   - `Gatehold.postman_collection.json`
   - `Gatehold.postman_environment.json`
2. Select environment **Gatehold MiniStack**
3. Use **Desktop Agent**
4. Run requests **1 → 9**

## After redeploy

API id changes. Update `gatewayBase`:

```bash
node -e "const id=new URL(require('./.cdk-outputs.json')['Gatehold-dev'].ApiUrl).hostname.split('.')[0]; console.log('http://localhost:4566/_aws/execute-api/'+id+'/dev')"
```
