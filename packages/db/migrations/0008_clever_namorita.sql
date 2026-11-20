CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "deals_title_trgm_idx" ON "deals" USING gin ("title" gin_trgm_ops);
