ALTER TABLE "deals" ADD COLUMN "express" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "express" SET DEFAULT true;
