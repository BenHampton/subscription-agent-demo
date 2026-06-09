import { db, agentTraces } from '@/lib/db';
import { gte } from 'drizzle-orm';

// PURPOSE: Computes agent performance metrics from trace data
//
// These metrics answer the questions like:
//   - "What percentage of tickets does the agent resolve autonomously?"
//   - "How often does the agent escalate?"
//   - "What's the average confidence score?"
//   - "How long does a typical resolution take?"
//   - "Which tools are used most/least?"

export interface AgentMetrics {
  totalInteractions: number;
  resolutionRate: number; // % resolved without escalation
  escalationRate: number; // % escalated to human
  averageConfidence: number; // 0-1
  averageToolCalls: number; // tools per interaction
  averageDurationMs: number; // end-to-end time
  confirmationRate: number; // % requiring user confirmation
}

/**
 * Compute aggregate metrics for a time range.
 *
 * @param since - Start of time range (default: last 24 hours)
 */
export async function getMetrics(since?: Date): Promise<AgentMetrics> {
  const cutoff = since || new Date(Date.now() - 24 * 60 * 60 * 1000);

  const traces = await db
    .select()
    .from(agentTraces)
    .where(gte(agentTraces.createdAt, cutoff));

  if (traces.length === 0) {
    return {
      totalInteractions: 0,
      resolutionRate: 0,
      escalationRate: 0,
      averageConfidence: 0,
      averageToolCalls: 0,
      averageDurationMs: 0,
      confirmationRate: 0,
    };
  }

  const total = traces.length;
  const resolved = traces.filter((t) => t.outcome === 'resolved').length;
  const escalated = traces.filter((t) => t.outcome === 'escalated').length;
  const confirmed = traces.filter((t) => t.outcome === 'needs_confirm').length;

  const avgConfidence =
    traces.reduce((sum, t) => sum + (t.confidenceScore || 0), 0) / total;

  const avgToolCalls =
    traces.reduce(
      (sum, t) => sum + ((t.toolCalls as unknown[])?.length || 0),
      0,
    ) / total;

  const avgDuration =
    traces.reduce((sum, t) => sum + (t.totalDurationMs || 0), 0) / total;

  return {
    totalInteractions: total,
    resolutionRate: Math.round((resolved / total) * 100),
    escalationRate: Math.round((escalated / total) * 100),
    averageConfidence: Math.round(avgConfidence * 100) / 100,
    averageToolCalls: Math.round(avgToolCalls * 10) / 10,
    averageDurationMs: Math.round(avgDuration),
    confirmationRate: Math.round((confirmed / total) * 100),
  };
}
