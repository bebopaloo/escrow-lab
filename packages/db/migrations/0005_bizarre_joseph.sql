CREATE TABLE "mismatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"deal_id" uuid NOT NULL,
	"payout_id" uuid,
	"idempotency_key" text NOT NULL,
	"chain_tx_id" text NOT NULL,
	"ledger_amount_minor" integer,
	"chain_amount_minor" integer,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"fixed_by" uuid,
	CONSTRAINT "mismatches_kind_check" CHECK ("mismatches"."kind" in ('missing_in_ledger', 'missing_on_chain', 'amount_differs'))
);
--> statement-breakpoint
ALTER TABLE "mismatches" ADD CONSTRAINT "mismatches_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mismatches" ADD CONSTRAINT "mismatches_payout_id_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mismatches" ADD CONSTRAINT "mismatches_fixed_by_users_id_fk" FOREIGN KEY ("fixed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mismatches_one_open_key_idx" ON "mismatches" USING btree ("idempotency_key") WHERE "mismatches"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "mismatches_deal_id_idx" ON "mismatches" USING btree ("deal_id");