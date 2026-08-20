#!/usr/bin/env bash
# One-command dev setup: infra + deps + db + seeds.
# Usage: pnpm setup            (uses docker compose for infra)
#        SUNU_NO_DOCKER=1 pnpm setup   (assumes local Postgres+PostGIS and Redis already running)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${SUNU_NO_DOCKER:-}" ]; then
  docker compose up -d --wait postgres redis minio
fi

pnpm install
pnpm db:migrate
pnpm db:seed

echo ""
echo "SunuMarket dev environment ready."
echo "  API:   pnpm --filter @sunumarket/api dev   (http://localhost:3001)"
echo "  Web:   pnpm --filter @sunumarket/web dev   (http://localhost:3000)"
echo "  Admin: pnpm --filter @sunumarket/admin dev (http://localhost:3002)"
