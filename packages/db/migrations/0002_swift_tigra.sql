CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"buyer_id" uuid NOT NULL,
	"seller_id" uuid NOT NULL,
	"total_minor" integer NOT NULL,
	"currency" text DEFAULT 'GBP' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"funding_idempotency_key" text,
	"funding_attempts" integer DEFAULT 0 NOT NULL,
	"next_funding_try_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_total_check" CHECK ("deals"."total_minor" between 1 and 100000000),
	CONSTRAINT "deals_currency_check" CHECK ("deals"."currency" = 'GBP'),
	CONSTRAINT "deals_state_check" CHECK ("deals"."state" in ('draft', 'funding', 'funding_failed', 'funded', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deal_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"evidence_text" text,
	"rejection_reason" text,
	CONSTRAINT "milestones_deal_position_unique" UNIQUE("deal_id","position"),
	CONSTRAINT "milestones_amount_check" CHECK ("milestones"."amount_minor" >= 1),
	CONSTRAINT "milestones_state_check" CHECK ("milestones"."state" in ('pending', 'awaiting_evidence', 'evidence_sent', 'accepted', 'paid'))
);
--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deals_buyer_id_idx" ON "deals" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "deals_seller_id_idx" ON "deals" USING btree ("seller_id");