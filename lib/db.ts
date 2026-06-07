import {neon} from "@neondatabase/serverless";
import {drizzle} from "drizzle-orm/neon-http";
import {uuid, pgTable, text, varchar, integer, jsonb, timestamp, index} from "drizzle-orm/pg-core";

// Database Connection

if (!process.env.DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is not set. Add it to .env.local. " +
        "Get it from: https://console.neon.tech → Project → Connection Details"
    );
}

// Create the Neon HTTP query function
// Returns a function that sends SQL over HTTP, no persistent connection, no connection pooling, no cleanup needed
const sql = neon(process.env.DATABASE_URL)

// Create the Drizzle ORM instance
// wraps around the raw SQL with Drizzle's query builder giving us type-safe queries while still using Neon's serverless
export const db = drizzle(sql)

// Schema: Knowledge Base Documents
// Purpose: Stores embedded document chunks for RAG retrieval.
//
// When we ingest a policy document (e.g., "refund-policy.md"), we:
//   1. Split it into chunks (up to ~1500 chars / ~375 tokens each)
//   2. Embed each chunk using Voyage AI → vector of floats
//   3. Store the chunk text + vector in this table
//
// At query time, the agent:
//   1. Embeds the user's question using the same Voyage AI model
//   2. Finds the most similar chunks using pgvector cosine similarity
//   3. Passes those chunks to Claude as context
//

export const knowledgeDocuments = pgTable(
    "knowledge_documents", (t) => (
    {
        id: t.uuid("id").defaultRandom().primaryKey(),

        // The raw text content of this chunk
        content: t.text("content").notNull(),

        // Which source document this chunk came from
        // (e.g., "refund-policy.md", "pricing.md")
        sourceDocument: t.varchar("source_document", { length: 255 }).notNull(),

        // Section or heading this chunk belongs to, for display purposes
        sectionTitle: t.varchar("section_title", { length: 255 }),

        // Position of this chunk within the source document (0-indexed)
        // Used to reconstruct document order if needed
        chunkIndex: t.integer("chunk_index").notNull(),

        // Metadata as JSON — flexible storage for tags, categories, etc.
        // JSONB is indexed and queryable in Postgres, unlike plain JSON
        metadata: t.jsonb().$type<Record<string, string>>(),

        // The vector embedding — THIS is what makes RAG work.
        // We store it as a text column and cast to vector in queries
        // because Drizzle doesn't have native pgvector type support.
        // The casting happens in our retriever queries (lib/rag/retriever.ts).
        //
        // FORMAT: "[0.123, -0.456, 0.789, ...]" — a JSON array of floats
        // DIMENSIONS: 1024 (must match voyage-3-lite output dimensions)
        embedding: t.text("embedding").notNull(),

        // Which tenant owns this document (Section 15: Multi-tenancy)
        // Nullable so the system works in single-tenant mode before
        // Section 15 is implemented. After adding tenants, set this
        // on all documents to enable tenant-scoped retrieval.
        tenantId: t.uuid("tenant_id"),

        // Timestamps for auditing
        createdAt: t.timestamp("created_at").defaultNow().notNull(),
        updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
    }),
    (table) => ({
        sourceIndex: index("knowledge_documents_idx").on(table.sourceDocument),
        tenantIdx: index("knowledge_documents_idx").on(table.tenantId)
    })
)

// Schema: Conversations
//
// PURPOSE: Tracks conversation sessions for multi-turn memory.
//
// Each conversation is a session between a customer and the agent.
// The agent needs to know what was said earlier in the conversation
// to maintain context — "I want to upgrade" only makes sense if
// the agent remembers which customer is talking and what plan
// they're on.
//
// DESIGN DECISION: Separate conversations and messages tables
// instead of storing messages as a JSONB array.
//
// WHY NOT JSONB ARRAY?
//   - Can't index individual messages for search
//   - Can't query "find all conversations where the agent escalated"
//     without scanning every row and parsing JSON
//   - Appending to a JSONB array requires rewriting the entire column
//   - Separate tables = standard relational queries, proper indexing,
//     and the ability to join messages with evaluation traces

export const conversations = pgTable("conversations", (t) => ({
    id: t.uuid().defaultRandom().primaryKey(),

    // Links to an external customer ID (from Stripe)
    // Nullable because a conversation might start before
    // the customer is identified
    customerId: t.varchar("customer_id", { length: 255 }),

    // Which tenant this conversation belongs to (Section 15)
    // Nullable for single-tenant mode before Section 15.
    tenantId: t.uuid("tenant_id"),

    // Current status of the conversation
    // "active"    → in progress
    // "resolved"  → agent successfully handled the request
    // "escalated" → agent handed off to a human
    // "abandoned" → customer left without resolution
    status: t.varchar({ length: 50 })
        .notNull()
        .default("active"),

    // Summary of the conversation outcome (filled when resolved/escalated)
    // Used for evaluation — "What did the agent actually do?"
    resolution: t.text(),

    // Timestamps
    createdAt: t.timestamp("created_at").defaultNow().notNull(),
    updatedAt: t.timestamp("updated_at").defaultNow().notNull(),
}));


// SCHEMA: Conversation Messages
//
// PURPOSE: Individual messages within a conversation.
//
// Stores every message — user input, agent responses, tool calls,
// and tool results. This is the agent's "memory" for multi-turn
// conversations. When the agent responds, it receives all previous
// messages as context.
//
// PATTERN: Event Sourcing (lightweight)
// Instead of storing just the current state ("customer wants a
// refund"), we store every event that led to that state. This
// means we can replay the conversation, debug agent decisions,
// and understand WHY the agent did what it did.

export const conversationMessages = pgTable(
    "conversation_messages",
    (t) => ({
        id: t.uuid().defaultRandom().primaryKey(),

        // Which conversation this message belongs to
        conversationId: t.uuid("conversation_id")
            .notNull()
            .references(() => conversations.id),

        // Who sent this message
        // "user"      → the customer
        // "assistant" → the agent (Claude's response)
        // "tool_call" → a tool the agent decided to call
        // "tool_result" → the result of that tool call
        role: t.varchar({ length: 50 }).notNull(),

        // The message content — text for user/assistant, JSON for tool calls
        content: t.text().notNull(),

        // For tool_call messages: which tool was called
        toolName: t.varchar("tool_name", { length: 100 }),

        // For tool_call messages: the arguments passed (as JSON string)
        toolArgs: t.text("tool_args"),

        // For tool_result messages: links back to the tool_call message
        toolCallId: t.varchar("tool_call_id", { length: 255 }),

        // Ordering — messages within a conversation must be ordered
        // Using a sequence number rather than timestamp because multiple
        // messages can happen in the same millisecond (tool calls)
        sequence: t.integer().notNull(),

        // Timestamp
        createdAt: t.timestamp("created_at").defaultNow().notNull(),
    }),
    (table) => ({
        // Index for fetching all messages in a conversation, in order
        // This is the most common query: "give me this conversation's history"
        convSeqIdx: index("conv_seq_idx").on(
            table.conversationId,
            table.sequence
        ),
    })
);

// SCHEMA: Agent Evaluation Traces
//
// PURPOSE: Logs every agent decision for observability.
//
// This table answers: "For this conversation turn, what did the
// agent do, why did it do it, and how confident was it?"
//
// Every time the agent processes a message, we log:
//   - Which tools it called (and in what order)
//   - What knowledge it retrieved
//   - What guardrails it checked
//   - Whether it resolved, escalated, or needed confirmation
//   - Its confidence score (0-1)
//
// PATTERN: Structured Logging / Tracing
// This is the observability layer that Maven AGI's "Agentic
// Evaluation Framework" would provide. In their platform, this
// is built-in. Here, we build it ourselves to show we understand
// the concept. In an interview, this table demonstrates you think
// about AI systems beyond "does it work?" to "can we measure and
// improve it?"
//
// TRADEOFF: We store traces in Postgres for simplicity.
// In production, you'd likely use a dedicated observability
// platform (Datadog, Langfuse, Braintrust) for better querying
// and visualization. But for a demo, Postgres is queryable,
// inspectable, and requires no additional service.

export const agentTraces = pgTable(
    "agent_traces",
    (t) => ({
        id: t.uuid().defaultRandom().primaryKey(),

        // Which conversation this trace belongs to
        conversationId: t.uuid("conversation_id")
            .notNull()
            .references(() => conversations.id),

        // Which tenant this trace belongs to (Section 15)
        // Nullable for single-tenant mode before Section 15.
        tenantId: t.uuid("tenant_id"),

        // Which specific message triggered this trace
        messageId: t.uuid("message_id"),

        // The user's input that triggered this agent turn
        userInput: t.text("user_input").notNull(),

        // The agent's final response
        agentResponse: t.text("agent_response").notNull(),

        // Ordered list of tool calls the agent made
        // Stored as JSON: [{ tool: "lookup_customer", args: {...}, result: {...} }]
        toolCalls: t.jsonb("tool_calls").$type<Array<{
            tool: string;
            args: Record<string, unknown>;
            result: unknown;
            durationMs: number;
        }>>(),

        // Knowledge chunks retrieved via RAG (if any)
        // Stored as JSON: [{ chunkId: "...", score: 0.92, content: "..." }]
        retrievedContext: t.jsonb("retrieved_context").$type<Array<{
            chunkId: string;
            score: number;
            content: string;
        }>>(),

        // Guardrails that were evaluated
        // Stored as JSON: [{ rule: "max_refund", passed: true, details: "..." }]
        guardrailChecks: t.jsonb("guardrail_checks").$type<Array<{
            rule: string;
            passed: boolean;
            details: string;
        }>>(),

        // Agent's self-assessed confidence (0.0 to 1.0)
        // Below the threshold → escalate to human
        confidenceScore: t.real("confidence_score"),

        // Outcome of this turn
        // "resolved"     → agent answered successfully
        // "escalated"    → handed to human (low confidence or guardrail)
        // "needs_confirm"→ waiting for user to confirm a destructive action
        // "error"        → something went wrong
        outcome: t.varchar({ length: 50 }).notNull(),

        // Time taken for the full agent turn (LLM + tool calls)
        totalDurationMs: t.integer("total_duration_ms"),

        // Which Claude model was used (useful for A/B testing models)
        modelUsed: t.varchar("model_used", { length: 100 }),

        // Whether prompt caching was used (for cost tracking)
        promptCacheHit: t.boolean("prompt_cache_hit").default(false),

        // Timestamp
        createdAt: t.timestamp("created_at").defaultNow().notNull(),
    }),
    (table) => ({
        // Index for analyzing traces by conversation
        traceConvIdx: index("trace_conv_idx").on(table.conversationId),

        // Index for filtering by outcome (e.g., "show me all escalations")
        traceOutcomeIdx: index("trace_outcome_idx").on(table.outcome),

        // Index for time-range queries ("traces from the last hour")
        traceTimeIdx: index("trace_time_idx").on(table.createdAt),
    })
);

// SCHEMA: Pending Actions (added in Section 17)
//
// PURPOSE: Stores actions awaiting user confirmation.
// Replaces the in-memory Map from Section 9 so pending actions
// survive server restarts and work across multiple instances.

export const pendingActions = pgTable("pending_actions", (t) => ({
    id: t.uuid().defaultRandom().primaryKey(),
    conversationId: t.uuid("conversation_id").notNull().unique(),
    toolName: t.varchar("tool_name", { length: 100 }).notNull(),
    args: t.jsonb().notNull().$type<Record<string, unknown>>(),
    description: t.text().notNull(),
    guardrailReason: t.text("guardrail_reason").notNull(),
    tenantId: t.uuid("tenant_id"),
    expiresAt: t.timestamp("expires_at").notNull(),
    createdAt: t.timestamp("created_at").defaultNow().notNull(),
}));



// TYPE EXPORTS

// Drizzle generates TypeScript types from your schema definitions.
// These types are used throughout the app for type-safe queries:
//
//   - $inferInsert → the shape of data you INSERT (optional fields allowed)
//   - $inferSelect → the shape of data you SELECT (all fields present)
//
// Using these instead of hand-written interfaces means your types
// are always in sync with your database — change a column, and
// TypeScript errors appear everywhere that column is referenced.

export type KnowledgeDocument = typeof knowledgeDocuments.$inferSelect;
export type NewKnowledgeDocument = typeof knowledgeDocuments.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;

export type AgentTrace = typeof agentTraces.$inferSelect;
export type NewAgentTrace = typeof agentTraces.$inferInsert;

export type PendingAction = typeof pendingActions.$inferSelect;
export type NewPendingAction = typeof pendingActions.$inferInsert;