ALTER TABLE "payouts" ALTER COLUMN "approved_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "express" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "express" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "express" SET DEFAULT true;
