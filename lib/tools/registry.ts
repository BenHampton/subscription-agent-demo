import Anthropic from '@anthropic-ai/sdk';
import { RegisteredTool, ToolHandler, ToolContext } from '@/lib/agent/types';
import { knowledgeSearchTool } from './knowledge-tools';
import {
  lookupCustomerTool,
  getSubscriptionTool,
  getInvoicesTool,
  issueRefundTool,
  cancelSubscriptionTool,
  escalateToHumanTool,
} from './stripe-tools';

// PURPOSE: Central registry of all tools available to the agent.
//
// PATTERN: Registry Pattern
// Instead of hardcoding tool lists everywhere, we register all
// tools in one place. The agent core queries this registry for:
//   - Tool definitions (to send to Anthropic's API)
//   - Tool handlers (to execute when Claude makes a tool call)
//   - Tool metadata (to check confirmation requirements)
//
// WHY A REGISTRY?
//   - Adding a new tool = one import + one registry.register() call
//   - The agent core never changes when tools are added/removed
//   - Testing can register mock tools without touching real ones
//   - Observability can iterate all registered tools for logging

class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  /**
   * Register a tool. Throws if a tool with the same name is
   * already registered — prevents silent overwrites.
   */
  register(tool: RegisteredTool): void {
    const name = tool.definition.name;
    if (this.tools.has(name)) {
      throw new Error(
        `Tool "${name}" is already registered. Tool names must be unique.`,
      );
    }
    this.tools.set(name, tool);
  }

  /**
   * Get all tool definitions for the Anthropic API.
   * This array is passed directly to the `tools` parameter
   * in anthropic.messages.create().
   */
  getDefinitions(): Anthropic.Tool[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Get a specific tool by name.
   * Returns undefined if the tool doesn't exist (the agent core
   * handles this as an error — Claude shouldn't call nonexistent tools).
   */
  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute a tool by name with the given arguments.
   *
   * This is the central execution point — every tool call goes
   * through here. This makes it the ideal place for cross-cutting
   * concerns like:
   *   - Logging (which tool was called, with what args)
   *   - Timing (how long did execution take)
   *   - Error normalization (catch errors, format for Claude)
   *
   * Returns a string result (success or error) that gets sent
   * back to Claude as a tool_result message.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<{ result: string; durationMs: number }> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        result: JSON.stringify({
          error: `Unknown tool: ${name}. Available tools: ${Array.from(
            this.tools.keys(),
          ).join(', ')}`,
        }),
        durationMs: 0,
      };
    }

    const startTime = Date.now();

    try {
      const result = await tool.handler(args, context);
      return {
        result,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      // Format errors as structured data Claude can reason about.
      // "The tool crashed" is useless. "The customer ID cus_xxx
      // was not found" is actionable.
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      return {
        result: JSON.stringify({
          error: `Tool "${name}" failed: ${errorMessage}`,
          suggestion: 'Try a different approach or escalate to a human.',
        }),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check if a tool requires user confirmation before execution.
   */
  requiresConfirmation(name: string): boolean {
    return this.tools.get(name)?.requiresConfirmation ?? false;
  }

  /**
   * Get the category of a tool (for logging).
   */
  getCategory(name: string): string {
    return this.tools.get(name)?.category ?? 'unknown';
  }
}

// Create and populate the registry
export const toolRegistry = new ToolRegistry();

// Register all tools

// ORDER DOESN'T MATTER — Claude sees them as an unordered set.
// But grouping by category here makes the code self-documenting.

// Knowledge / RAG tools
toolRegistry.register(knowledgeSearchTool);

// Billing / Stripe tools (read)
toolRegistry.register(lookupCustomerTool);
toolRegistry.register(getSubscriptionTool);
toolRegistry.register(getInvoicesTool);

// Billing / Stripe tools (write — require confirmation)
toolRegistry.register(issueRefundTool);
toolRegistry.register(cancelSubscriptionTool);

// Escalation
toolRegistry.register(escalateToHumanTool);
