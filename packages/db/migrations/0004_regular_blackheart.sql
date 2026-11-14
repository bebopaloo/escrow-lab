CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_try_at" timestamp with time zone,
	"approved_by" uuid NOT NULL,
	"chain_tx_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_milestone_unique" UNIQUE("milestone_id"),
	CONSTRAINT "payouts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payouts_state_check" CHECK ("payouts"."state" in ('pending', 'confirmed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payouts_approved_by_idx" ON "payouts" USING btree ("approved_by");--> statement-breakpoint
CREATE INDEX "payouts_state_idx" ON "payouts" USING btree ("state");