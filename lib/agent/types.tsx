import Anthropic from '@anthropic-ai/sdk';

export interface ToolContext {
  tenantId: string;
  tenantName: string;
}

export interface TenantInfo {
  id: string;
  companyName: string;
  agentName: string | null;
  guardrailConfig: {
    maxAutoRefundCents: number;
    escalationRefundCents: number;
    maxToolCallsPerTurn: number;
    confidenceThreshold: number;
  };
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<string>;

// PATTERN: Co-located Definition + Implementation
// Each tool bundles its API schema (what claude sees) with its handler (what our code runs).
// This means adding a new tool is one file change
export interface RegisteredTool {
  // The tool definition sent to Anthropic's API (name, description, input_schema)
  definition: Anthropic.Tool;

  // The function that executes when Claude calls this tool
  handler: ToolHandler;

  // Whether this tool performs a destructive/costly action
  // that requires user confirmation before execution.
  // Used in the guardrails layer
  requiresConfirmation: boolean;

  // Human-readable category for logging and observability
  category: 'billing' | 'knowledge' | 'account' | 'escalation';
}

// The shape of a request to the agent API endpoint
export interface AgentRequest {
  // The user's message
  message: string;
  // Conversation ID for multi-turn context (null = new conversation)
  conversationId: string | null;
  customerEmail?: string;
  // If the user is confirming a pending action
  confirmAction?: boolean;
}

// The shape of the agent's response
export interface AgentResponse {
  // The agent's text reply to the user
  message: string;
  // Conversation ID (created if new, echoed if existing)
  conversationId: string;
  // Whether the agent needs the user to confirm an action before it can proceed (e.g., "Are you sure you want to cancel?")
  requiresConfirmation: boolean;
  // Description of the pending action, if any
  pendingAction?: {
    tool: string;
    description: string;
    args: Record<string, unknown>;
  };
  // Resolution status of this turn
  outcome: 'resolved' | 'escalated' | 'needs_confirm' | 'continue' | 'error';
  // Confidence score (0-1) for this response
  confidence: number;
}
