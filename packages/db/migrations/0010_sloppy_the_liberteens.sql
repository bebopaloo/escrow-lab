ALTER TABLE "ledger_entries" DROP CONSTRAINT "ledger_entries_kind_check";--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "refund_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "refund_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "next_refund_try_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_refund_idx" ON "ledger_entries" USING btree ("deal_id") WHERE "ledger_entries"."kind" = 'refund';--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_kind_check" CHECK ("ledger_entries"."kind" in ('deposit', 'payout', 'refund'));