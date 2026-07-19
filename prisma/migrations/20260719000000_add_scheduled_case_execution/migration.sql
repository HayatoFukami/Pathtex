ALTER TYPE "CaseSource" ADD VALUE IF NOT EXISTS 'SCHEDULED';
ALTER TABLE "scheduled_actions" ADD COLUMN "executed_case_id" UUID;
CREATE UNIQUE INDEX "scheduled_actions_executed_case_id_key" ON "scheduled_actions"("executed_case_id");
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_executed_case_id_fkey" FOREIGN KEY ("executed_case_id") REFERENCES "moderation_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
