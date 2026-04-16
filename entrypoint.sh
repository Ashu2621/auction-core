#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
npx tsx db/migrate.ts

echo "[entrypoint] Starting AuctionCore service..."
exec node dist/server.js
