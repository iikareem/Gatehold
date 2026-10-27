#!/usr/bin/env bash
# Recreate compose → deploy → seed → print Postman gatewayBase.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> docker compose down / up"
docker compose down
docker compose up -d --build --force-recreate

echo "==> wait for MiniStack + mock-payment"
until curl -sf http://127.0.0.1:4566/_ministack/health >/dev/null; do sleep 2; done
until curl -sf http://127.0.0.1:8090/health >/dev/null; do sleep 2; done

set -a
# shellcheck disable=SC1091
source .env.example
set +a
export AWS_ENDPOINT_URL=http://127.0.0.1:4566
export AWS_ENDPOINT_URL_S3=http://127.0.0.1:4566

echo "==> deploy"
npm run deploy:local

echo "==> seed"
npm run seed

node -e "
const o = require('./.cdk-outputs.json')['Gatehold-dev'];
const id = new URL(o.ApiUrl).hostname.split('.')[0];
console.log('');
console.log('=== ADD THIS TO POSTMAN gatewayBase ===');
console.log('http://localhost:4566/_aws/execute-api/' + id + '/dev');
console.log('StackPort  http://localhost:8080');
console.log('mock-pay   http://127.0.0.1:8090');
console.log('======================================');
console.log('');
"
