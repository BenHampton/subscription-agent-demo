import { db, agentTraces } from '@/lib/db';
import { AgentResponse } from '@/lib/agent/types';

// PURPOSE: Records structured traces for every agent interaction.
//
// Every time the agent processes a message, we create a trace that
// captures the complete decision-making chain. This enables:
//   - Debugging: "Why did the agent refund $50 instead of $79?"
//   - Metrics: "What's our autonomous resolution rate this week?"
//   - Improvement: "Which queries cause the most escalations?"
//   - Compliance: "Show me every refund the agent processed in Q4"
//
// PATTERN: Structured Tracing
// Each trace is a structured record, not a log line. This means
// you can query traces with SQL rather than grepping log files.
// "SELECT COUNT(*) WHERE outcome = 'escalated' AND created_at > ..."
// beats "grep ESCALAT agent.log | wc -l" in every way.

interface TraceInput {
  conversationId: string;
  userInput: string;
  response: AgentResponse;
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
    durationMs: number;
  }>;
  retrievedContext?: Array<{
    chunkId: string;
    score: number;
    content: string;
  }>;
  guardrailChecks?: Array<{
    rule: string;
    passed: boolean;
    details: string;
  }>;
  totalDurationMs: number;
  model: string;
  promptCacheHit?: boolean;
}

// Public API

/**
 * Log a complete agent trace to the database.
 *
 * This function is called AFTER processMessage() completes,
 * with the full result. It's fire-and-forget — logging failures
 * should never block the response to the customer.
 */
export async function logTrace(input: TraceInput): Promise<void> {
  try {
    await db.insert(agentTraces).values({
      conversationId: input.conversationId,
      userInput: input.userInput,
      agentResponse: input.response.message,
      toolCalls: input.toolCalls,
      retrievedContext: input.retrievedContext || null,
      guardrailChecks: input.guardrailChecks || null,
      confidenceScore: input.response.confidence,
      outcome: input.response.outcome,
      totalDurationMs: input.totalDurationMs,
      modelUsed: input.model,
      promptCacheHit: input.promptCacheHit || false,
    });
  } catch (error) {
    // CRITICAL: Never let logging failures break the agent.
    // A failed log is a monitoring issue, not a customer issue.
    console.error('Failed to log trace:', error);
  }
}
