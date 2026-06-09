import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { toolRegistry } from '@/lib/tools/registry';
import { buildSystemPrompt } from './system-prompt';
import { AgentRequest, AgentResponse, ToolContext, TenantInfo } from './types';
import { evaluatePolicies } from '@/lib/guardrails/policies';
import {
  setPendingAction,
  consumePendingAction,
} from '@/lib/guardrails/confirmation';

// PURPOSE: The agentic loop, the core engine of the entire system.
//
// This module orchestrates:
//   1. Sending user messages to Claude with tool definitions
//   2. Processing Claude's response (text and/or tool calls)
//   3. Executing tool calls via the tool registry
//   4. Sending tool results back to Claude
//   5. Repeating until Claude produces a final text response
//
// PATTERN: ReAct Loop (Reasoning + Acting)
// The ReAct pattern is: Reason -> Act -> Observe -> Repeat.
//   - Reason: Claude analyzes the conversation and decides what to do
//   - Act: Claude generates a tool call (or a final response)
//   - Observe: We execute the tool and return the result
//   - Repeat: Claude incorporates the result and continues
//
// SAFETY MECHANISMS:
//   - Max iterations (prevent infinite loops)
//   - Guardrail checks before executing destructive tools
//   - Error handling for failed tool calls
//   - Timeout enforcement (not implemented here, but noted)

const MAX_ITERATIONS = 10; // Max tool call rounds per user message
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-6';

interface ToolCallTrace {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
}

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    'ANTHROPIC_API_KEY is not set. ' +
      'Get one at: https://console.anthropic.com/settings/keys',
  );
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// The Agentic Loop

/**
 * Process a user message through the agentic loop.
 *
 * This is the main entry point for the agent. It:
 *   1. Constructs the message array (system + conversation history + new message)
 *   2. Calls Claude with tool definitions
 *   3. Loops through tool calls until Claude produces a final response
 *   4. Returns the structured AgentResponse
 *
 * @param request - The user's message and conversation context
 * @param conversationHistory - Previous messages in this conversation
 *   (for multi-turn context — see Section 10)
 *
 * @returns AgentResponse with the reply, confidence, and metadata
 */
export async function processMessage(
  request: AgentRequest,
  conversationHistory: Anthropic.MessageParam[] = [],
  tenant?: TenantInfo, // Optional for backward compat; required in production
): Promise<{
  response: AgentResponse;
  toolCalls: ToolCallTrace[];
}> {
  // Track all tool calls for observability
  const toolCallTraces: ToolCallTrace[] = [];
  const startTime = Date.now();

  // Build the tool context for this request.
  // This context is passed to every tool handler so they can
  // access tenant-scoped data without it being in Claude's args.
  const toolContext: ToolContext = {
    tenantId: tenant?.id || 'default',
    tenantName: tenant?.companyName || 'Demo Company',
  };

  // Build the message array
  //
  // STRUCTURE:
  //   system: The system prompt (agent instructions)
  //   messages: [
  //     ...conversationHistory,  (previous turns)
  //     { role: "user", content: request.message }  (current turn)
  //   ]
  //   tools: All registered tool definitions
  //
  // Claude sees the entire conversation history on every call.
  // This is how multi-turn context works — it's not "memory",
  // it's "send everything every time." This is stateless by
  // design, which is exactly what serverless needs.

  // If the frontend provided a customer email (e.g., from a logged-in
  // session), inject it as context so Claude can skip the "what's your
  // email?" step and go straight to looking up the account.
  // We prepend it as a system-level context note in the user message,
  // not as a separate message, to keep the conversation flow natural.
  const userContent = request.customerEmail
    ? `[System context: The customer's email is ${request.customerEmail}. ` +
      `Use this to look up their account — do not ask for their email.]\n\n` +
      request.message
    : request.message;

  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory,
    { role: 'user', content: userContent },
  ];

  // The Loop
  //
  // INVARIANT: Each iteration either:
  //   a. Produces a final text response (loop ends), OR
  //   b. Executes tool calls and feeds results back (loop continues)
  //
  // The loop MUST terminate because:
  //   1. MAX_ITERATIONS enforces a hard upper bound
  //   2. Claude naturally converges to a text response after
  //      getting the information it needs
  //   3. If all tools fail, Claude responds with an error message

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Call Claude
    //
    // This is where the magic happens. We send:
    //   - The system prompt (who you are, what rules to follow)
    //   - The conversation history (what's been said so far)
    //   - The tool definitions (what tools are available)
    //
    // Claude responds with one or more content blocks:
    //   - TextBlock: { type: "text", text: "..." }
    //   - ToolUseBlock: { type: "tool_use", id: "...", name: "...", input: {...} }
    //
    // A single response can contain BOTH text AND tool calls.
    // For example, Claude might say "Let me look that up for you"
    // (text) AND call lookup_customer (tool_use) in the same response.

    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: buildSystemPrompt(tenant),
      messages,
      tools: toolRegistry.getDefinitions(),
    });

    // Process the response
    //
    // Check what Claude returned. There are three possible stop_reasons:
    //
    // SCENARIO A: stop_reason === "end_turn"
    //   Claude is done — it has a final text response.
    //   Extract the text and return it. Loop ends.
    //
    // SCENARIO B: stop_reason === "tool_use"
    //   Claude wants to call one or more tools.
    //   Execute each tool, collect results, and send them
    //   back as tool_result messages.
    //   The Loop continues.
    //
    // SCENARIO C: stop_reason === "max_tokens"
    //   Claude hit the max_tokens limit mid-response.
    //   This is rare with max_tokens: 4096 but can happen with
    //   very long tool results. We treat it the same as end_turn
    //   (extract whatever text Claude generated). In production,
    //   you might retry with a higher max_tokens or truncate
    //   the conversation history to free up space.

    if (
      response.stop_reason === 'end_turn' ||
      response.stop_reason === 'max_tokens'
    ) {
      // FINAL RESPONSE
      // Extract text from content blocks
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );

      const agentMessage = textBlocks
        .map((b) => b.text)
        .join('\n')
        .trim();

      // Parse confidence from the response if Claude included it
      // (the system prompt asks Claude to include a confidence note)
      const confidence = extractConfidence(agentMessage);

      return {
        response: {
          message: cleanResponse(agentMessage),
          conversationId: request.conversationId || generateId(),
          requiresConfirmation: false,
          outcome: confidence < 0.5 ? 'escalated' : 'resolved',
          confidence,
        },
        toolCalls: toolCallTraces,
      };
    }

    // TOOL CALLS
    //
    // Claude wants to use tools. Process each tool_use block.

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUseBlocks.length === 0) {
      // Shouldn't happen, but handle gracefully
      // (stop_reason wasn't "end_turn" but no tool calls either)
      break;
    }

    // ---- CHECK GUARDRAILS ----
    // Before executing any tool, run it through the policy engine.
    // The policy engine checks business rules (dollar limits, required
    // fields, etc.) and decides whether to allow, deny, or require
    // confirmation.
    //
    // NOTE: This uses the global evaluatePolicies with environment
    // variable limits. Section 15 upgrades this to per-tenant
    // policies via evaluatePoliciesForTenant.
    //
    // This replaces the simple requiresConfirmation check with a
    // full policy evaluation that:
    //   1. Checks ALL policies (not just a boolean flag)
    //   2. Returns structured reasons (for the customer AND audit log)
    //   3. Differentiates between "deny" and "escalate" and "confirm"
    //   4. Logs every evaluation for observability

    for (const toolCall of toolUseBlocks) {
      const args = toolCall.input as Record<string, unknown>;

      // Evaluate all policies for this tool call
      // After Section 15, upgrade to:
      //   tenant ? evaluatePoliciesForTenant(name, args, tenant) : evaluatePolicies(name, args)
      const { result: policyResult, evaluations } = evaluatePolicies(
        toolCall.name,
        args,
      );

      // Log policy evaluations for observability (Section 12)
      console.log(`Guardrails [${toolCall.name}]:`,
        evaluations
          .map((e) => `${e.policy}: ${e.result.allowed ? '✓' : '✗'}`)
          .join(', '),
      );

      // DENIED — block the tool call entirely
      if (!policyResult.allowed) {
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === 'text',
        );

        if (policyResult.action === 'escalate') {
          // Auto-escalate: execute the escalation tool on behalf of the agent
          return {
            response: {
              message:
                policyResult.reason +
                " I'm connecting you with a team member who can help with this.",
              conversationId: request.conversationId || generateId(),
              requiresConfirmation: false,
              outcome: 'escalated',
              confidence: 0.9,
            },
            toolCalls: toolCallTraces,
          };
        }

        // Hard deny: tell Claude the tool call was blocked
        // and let it try a different approach
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: JSON.stringify({
                error: `BLOCKED BY POLICY: ${policyResult.reason}`,
                suggestion: 'Try a different approach or escalate.',
              }),
              is_error: true,
            },
          ],
        });
        continue; // Let Claude try again with the denial feedback
      }

      // CONFIRMATION REQUIRED — store pending action and ask user
      if (
        (policyResult.action === 'confirm' ||
          toolRegistry.requiresConfirmation(toolCall.name)) &&
        !request.confirmAction
      ) {
        const textBlocks = response.content.filter(
          (block): block is Anthropic.TextBlock => block.type === 'text',
        );
        const preText = textBlocks.map((b) => b.text).join('\n');

        // Store the pending action for later execution
        const convId = request.conversationId || generateId();
        setPendingAction({
          toolName: toolCall.name,
          args,
          description: describeToolAction(toolCall.name, args),
          proposedAt: new Date(),
          conversationId: convId,
          guardrailReason:
            policyResult.reason || 'Action requires confirmation',
        });

        return {
          response: {
            message:
              preText ||
              "I'd like to perform the following action. Please confirm.",
            conversationId: convId,
            requiresConfirmation: true,
            pendingAction: {
              tool: toolCall.name,
              description: describeToolAction(toolCall.name, args),
              args,
            },
            outcome: 'needs_confirm',
            confidence: 0.9,
          },
          toolCalls: toolCallTraces,
        };
      }
    }

    // EXECUTE TOOLS
    //
    // All guardrail checks passed — execute each tool call.

    // First, add Claude's response (with tool_use blocks) to
    // the message history. Anthropic's API requires that tool_use
    // messages appear in the conversation before their tool_result
    // responses.
    messages.push({
      role: 'assistant',
      content: response.content,
    });

    // Execute each tool and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolCall of toolUseBlocks) {
      const args = toolCall.input as Record<string, unknown>;

      console.log(
        `🔧 Tool: ${toolCall.name}`,
        JSON.stringify(args).substring(0, 100),
      );

      // Execute via the registry (handles errors internally)
      const { result, durationMs } = await toolRegistry.execute(
        toolCall.name,
        args,
        toolContext,
      );

      // Track for observability
      toolCallTraces.push({
        tool: toolCall.name,
        args,
        result: safeJsonParse(result),
        durationMs,
      });

      // Format as Anthropic tool_result
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolCall.id,
        content: result,
      });

      console.log(`  → ${durationMs}ms`, result.substring(0, 100));
    }

    // SEND RESULTS BACK
    //
    // Add all tool results as a single user message.
    //
    // WHY ONE MESSAGE WITH MULTIPLE RESULTS?
    // Anthropic's API expects tool results as content blocks
    // within a single "user" message, not as separate messages.
    // This mirrors how the conversation would look: the user
    // (our code) responds to all of Claude's tool requests at once.

    messages.push({
      role: 'user',
      content: toolResults,
    });

    // Loop continues — Claude will process the tool results
    // and either make more tool calls or produce a final response.
  }

  // MAX ITERATIONS REACHED
  //
  // If we get here, the agent used all its iterations without
  // producing a final response. This is abnormal — escalate.
  return {
    response: {
      message:
        "I'm having trouble resolving this issue and need to " +
        'connect you with a team member who can help. Let me ' +
        'transfer you now.',
      conversationId: request.conversationId || generateId(),
      requiresConfirmation: false,
      outcome: 'escalated',
      confidence: 0.3,
    },
    toolCalls: toolCallTraces,
  };
}

// Helper Functions

/**
 * Extract confidence score from Claude's response.
 * The system prompt asks Claude to include a confidence note.
 * We parse it out so it doesn't appear in the customer-facing response.
 */
function extractConfidence(text: string): number {
  // Look for patterns like "Confidence: 0.9" or "[confidence: 0.85]"
  const match = text.match(/\[?confidence:?\s*([\d.]+)\]?/i);
  return match ? parseFloat(match[1]) : 0.8; // Default to 0.8
}

/**
 * Remove internal confidence notes from the customer-facing response.
 */
function cleanResponse(text: string): string {
  return text.replace(/\[?confidence:?\s*[\d.]+\]?/gi, '').trim();
}

/**
 * Generate a human-readable description of a pending tool action.
 * Used in confirmation dialogs so the customer knows exactly
 * what the agent wants to do.
 */
function describeToolAction(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'issue_refund':
      return (
        `Issue a refund of $${((args.amountInCents as number) / 100).toFixed(2)} ` +
        `for: ${args.reason}`
      );
    case 'cancel_subscription':
      return 'Cancel your subscription at the end of the current billing period';
    default:
      return `Execute ${toolName}`;
  }
}

/**
 * Safely parse JSON, returning the raw string if parsing fails.
 */
function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

/**
 * Generate a unique ID for new conversations using the uuid package.
 */
function generateId(): string {
  return uuidv4();
}
