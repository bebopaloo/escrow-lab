CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"chain_tx_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_kind_check" CHECK ("ledger_entries"."kind" in ('deposit', 'payout')),
	CONSTRAINT "ledger_entries_amount_check" CHECK ("ledger_entries"."amount_minor" >= 1)
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_deal_id_idx" ON "ledger_entries" USING btree ("deal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_one_deposit_idx" ON "ledger_entries" USING btree ("deal_id") WHERE "ledger_entries"."kind" = 'deposit';--> statement-breakpoint
CREATE FUNCTION "ledger_entries_append_only"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "ledger_entries_no_update_delete" BEFORE UPDATE OR DELETE ON "ledger_entries" FOR EACH ROW EXECUTE FUNCTION "ledger_entries_append_only"();
