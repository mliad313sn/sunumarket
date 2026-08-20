-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'fr',
    "country" CHAR(2) NOT NULL,
    "kyc_tier" INTEGER NOT NULL DEFAULT 0,
    "payout_pin_hash" TEXT,
    "roles" TEXT[] DEFAULT ARRAY['buyer']::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_bindings" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_hash" TEXT NOT NULL,
    "trusted" BOOLEAN NOT NULL DEFAULT false,
    "first_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_verified" TIMESTAMP(3),

    CONSTRAINT "device_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "rotated_to" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_records" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documents" JSONB NOT NULL DEFAULT '{}',
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kyc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fraud_events" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "device_hash" TEXT,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "review_status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fraud_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "education_card_state" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "card" TEXT NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "education_card_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" UUID NOT NULL,
    "country" CHAR(2) NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "country" CHAR(2) NOT NULL,
    "city_id" UUID NOT NULL,
    "whatsapp_phone" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "completed_orders" INTEGER NOT NULL DEFAULT 0,
    "enabled_methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "stock" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "images" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zones" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "band" INTEGER NOT NULL,
    "fee_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "polygon" geometry(Polygon, 4326) NOT NULL,

    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_points" (
    "id" UUID NOT NULL,
    "owner_id" UUID,
    "label" TEXT,
    "landmark" TEXT NOT NULL,
    "point" geometry(Point, 4326) NOT NULL,
    "consent" BOOLEAN NOT NULL DEFAULT false,
    "truncate_after" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_points_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "shop_id" UUID NOT NULL,
    "buyer_id" UUID,
    "guest_phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "subtotal_minor" BIGINT NOT NULL,
    "delivery_fee_minor" BIGINT NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "delivery_point_snapshot" JSONB NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "tracking_token" TEXT NOT NULL,
    "payment_expires_at" TIMESTAMP(3),
    "stock_restored" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "title_snapshot" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_providers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "payment_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "provider_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'initiated',
    "provider_ref" TEXT,
    "failure_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "attempt_id" UUID,
    "source_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "leg" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "rail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "pin_verified" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_batches" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "settlement_date" DATE NOT NULL,
    "source_file" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ingested',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_lines" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "fee_minor" BIGINT NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL,
    "matched_transaction_id" UUID,
    "match_kind" TEXT NOT NULL DEFAULT 'unmatched',

    CONSTRAINT "settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_flags" (
    "id" UUID NOT NULL,
    "settlement_line_id" UUID,
    "order_id" UUID,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "reconciliation_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "riders" (
    "user_id" UUID NOT NULL,
    "vehicle" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "cod_outstanding_minor" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "riders_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "partners" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "adapter" TEXT NOT NULL DEFAULT 'MOCK',
    "webhook_secret_ref" TEXT NOT NULL,

    CONSTRAINT "partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_jobs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "rider_id" UUID,
    "partner_id" UUID,
    "fee_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "cod" BOOLEAN NOT NULL DEFAULT false,
    "cod_amount_minor" BIGINT,
    "proof" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_offers" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "rider_id" UUID NOT NULL,
    "offered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "dispatch_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "gps" geometry(Point, 4326),
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rider_cash_ledger" (
    "id" UUID NOT NULL,
    "rider_id" UUID NOT NULL,
    "order_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rider_cash_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ratings" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "target" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reason" TEXT NOT NULL,
    "payout_frozen" BOOLEAN NOT NULL DEFAULT true,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "country_packs" (
    "id" UUID NOT NULL,
    "country" CHAR(2) NOT NULL,
    "version" INTEGER NOT NULL,
    "pack" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "country_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_outbox" (
    "id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sender_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "sms_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "device_bindings_user_id_device_hash_key" ON "device_bindings"("user_id", "device_hash");

-- CreateIndex
CREATE INDEX "otp_codes_phone_expires_at_idx" ON "otp_codes"("phone", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "fraud_events_kind_review_status_idx" ON "fraud_events"("kind", "review_status");

-- CreateIndex
CREATE UNIQUE INDEX "education_card_state_user_id_card_key" ON "education_card_state"("user_id", "card");

-- CreateIndex
CREATE UNIQUE INDEX "cities_country_name_key" ON "cities"("country", "name");

-- CreateIndex
CREATE UNIQUE INDEX "shops_slug_key" ON "shops"("slug");

-- CreateIndex
CREATE INDEX "products_shop_id_status_idx" ON "products"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tracking_token_key" ON "orders"("tracking_token");

-- CreateIndex
CREATE INDEX "orders_shop_id_status_idx" ON "orders"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_providers_code_key" ON "payment_providers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_provider_ref_key" ON "payment_attempts"("provider_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_idempotency_key_key" ON "payment_attempts"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_attempts_order_id_status_idx" ON "payment_attempts"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_provider_id_event_id_key" ON "webhook_events"("provider_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_owner_type_owner_id_currency_key" ON "ledger_accounts"("owner_type", "owner_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_attempt_id_key" ON "ledger_transactions"("attempt_id");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_idempotency_key_key" ON "payouts"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_batches_provider_id_settlement_date_source_file_key" ON "settlement_batches"("provider_id", "settlement_date", "source_file");

-- CreateIndex
CREATE INDEX "reconciliation_flags_status_opened_at_idx" ON "reconciliation_flags"("status", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_jobs_order_id_key" ON "delivery_jobs"("order_id");

-- CreateIndex
CREATE INDEX "delivery_jobs_status_idx" ON "delivery_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_offers_job_id_rider_id_key" ON "dispatch_offers"("job_id", "rider_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_events_job_id_event_id_key" ON "job_events"("job_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "ratings_order_id_target_key" ON "ratings"("order_id", "target");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_order_id_key" ON "disputes"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "country_packs_country_key" ON "country_packs"("country");

-- AddForeignKey
ALTER TABLE "device_bindings" ADD CONSTRAINT "device_bindings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kyc_records" ADD CONSTRAINT "kyc_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fraud_events" ADD CONSTRAINT "fraud_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "education_card_state" ADD CONSTRAINT "education_card_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zones" ADD CONSTRAINT "zones_city_id_fkey" FOREIGN KEY ("city_id") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_points" ADD CONSTRAINT "delivery_points_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "payment_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_batches" ADD CONSTRAINT "settlement_batches_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "payment_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "settlement_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_matched_transaction_id_fkey" FOREIGN KEY ("matched_transaction_id") REFERENCES "ledger_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_flags" ADD CONSTRAINT "reconciliation_flags_settlement_line_id_fkey" FOREIGN KEY ("settlement_line_id") REFERENCES "settlement_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "riders" ADD CONSTRAINT "riders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_rider_id_fkey" FOREIGN KEY ("rider_id") REFERENCES "riders"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_jobs" ADD CONSTRAINT "delivery_jobs_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "delivery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_offers" ADD CONSTRAINT "dispatch_offers_rider_id_fkey" FOREIGN KEY ("rider_id") REFERENCES "riders"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "delivery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rider_cash_ledger" ADD CONSTRAINT "rider_cash_ledger_rider_id_fkey" FOREIGN KEY ("rider_id") REFERENCES "riders"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ratings" ADD CONSTRAINT "ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
