-- Pass-2 committee remediation:
--  * worker_heartbeats — worker liveness rows for /health (fix 10)
--  * rider_cash_ledger.idempotency_key — remittance replay guard (fix 2);
--    the table is append-only (immutability trigger), so idempotency must stop
--    the second INSERT — a unique key does exactly that.

-- AlterTable
ALTER TABLE "rider_cash_ledger" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "rider_cash_ledger_idempotency_key_key" ON "rider_cash_ledger"("idempotency_key");

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "id" TEXT NOT NULL,
    "beat_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("id")
);
