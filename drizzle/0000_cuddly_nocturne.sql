CREATE TABLE "agent_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tenant_id" uuid,
	"message_id" uuid,
	"user_input" text NOT NULL,
	"agent_response" text NOT NULL,
	"tool_calls" jsonb,
	"retrieved_context" jsonb,
	"guardrail_checks" jsonb,
	"confidence_score" real,
	"outcome" varchar(50) NOT NULL,
	"total_duration_ms" integer,
	"model_used" varchar(100),
	"prompt_cache_hit" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" varchar(50) NOT NULL,
	"content" text NOT NULL,
	"tool_name" varchar(100),
	"tool_args" text,
	"tool_call_id" varchar(255),
	"sequence" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" varchar(255),
	"tenant_id" uuid,
	"status" varchar(50) DEFAULT 'active' NOT NULL,
	"resolution" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"source_document" varchar(255) NOT NULL,
	"section_title" varchar(255),
	"chunk_index" integer NOT NULL,
	"metadata" jsonb,
	"embedding" text NOT NULL,
	"tenant_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool_name" varchar(100) NOT NULL,
	"args" jsonb NOT NULL,
	"description" text NOT NULL,
	"guardrail_reason" text NOT NULL,
	"tenant_id" uuid,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pending_actions_conversation_id_unique" UNIQUE("conversation_id")
);
--> statement-breakpoint
ALTER TABLE "agent_traces" ADD CONSTRAINT "agent_traces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trace_conv_idx" ON "agent_traces" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "trace_outcome_idx" ON "agent_traces" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "trace_time_idx" ON "agent_traces" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conv_seq_idx" ON "conversation_messages" USING btree ("conversation_id","sequence");--> statement-breakpoint
CREATE INDEX "knowledge_source_idx" ON "knowledge_documents" USING btree ("source_document");--> statement-breakpoint
CREATE INDEX "knowledge_tenant_idx" ON "knowledge_documents" USING btree ("tenant_id");