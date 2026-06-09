import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { processMessage } from '@/lib/agent/core';
import {
  consumePendingAction,
  cancelPendingAction,
} from "@/lib/guardrails/confirmation";
import { toolRegistry } from "@/lib/tools/registry";

// PURPOSE: The HTTP entry point for the agent
//
// This is a Next.js App Router API route that accepts POST requests
// and delegates to the agentic core. It handles:
//   - Request validation (using Zod)
//   - Calling the agent core
//   - Formatting the HTTP response
//
// ENDPOINT: POST /api/agent/chat
// REQUEST BODY: { message, conversationId?, customerEmail?, confirmAction? }
// RESPONSE: { message, conversationId, requiresConfirmation, outcome, confidence }

// Request Validation
//
// Zod validates the request body at runtime. TypeScript types
// disappear at runtime, so without Zod, a malformed request
// body would slip through and cause cryptic errors deep in the
// agent code. Zod catches it at the boundary.

const RequestSchema = z.object({
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(10000, 'Message too long'),
  conversationId: z.string().nullable().optional(),
  customerEmail: z.email().optional(),
  confirmAction: z.boolean().optional(),
});

// Route Handler

export async function POST(req: NextRequest) {
  try {
    // Parse and validate the request body
    const body = await req.json();
    const parsed = RequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: parsed.error.issues.map((i) => i.message),
        },
        { status: 400 },
      );
    }

    const request = parsed.data;




    // Handle confirmation of a pending action
    // User confirmed a pending action → execute it directly
    if (request.confirmAction && request.conversationId) {
      const pending = consumePendingAction(request.conversationId);

      if (!pending) {
        return NextResponse.json({
          message: "There's no pending action to confirm. It may have " +
              "expired. Could you tell me what you'd like to do?",
          conversationId: request.conversationId,
          requiresConfirmation: false,
          outcome: "continue",
          confidence: 0.8,
        });
      }

      // Execute the pending action
      // Note: In the multi-tenant version (Section 15), pass the
      // tenant-scoped context here as the third argument.
      const tenant = {id: "default", companyName: "Demo"} // TODO UPDATE 'tenant' form ^^
      const { result, durationMs } = await toolRegistry.execute(
          pending.toolName,
          pending.args,
          { tenantId: tenant?.id || "default", tenantName: tenant?.companyName || "Demo" }
      );

      const parsedResult = JSON.parse(result);
      const success = parsedResult.success !== false;

      return NextResponse.json({
        message: success
            ? `Done! ${pending.description} has been processed successfully.`
            : `I wasn't able to complete that: ${parsedResult.error}`,
        conversationId: request.conversationId,
        requiresConfirmation: false,
        outcome: success ? "resolved" : "error",
        confidence: 0.95,
      });
    }

    // User declined a pending action → clear it, fall through to processMessage
    if (request.confirmAction === false && request.conversationId) {
      cancelPendingAction(request.conversationId);
      // Fall through to processMessage — let Claude handle the "no"
    }

    // Call the agentic core
    // In Section 10 (Multi-turn Memory), we'll load conversation
    // history from the database here. For now, each request is
    // stateless (no history).
    const { response, toolCalls } = await processMessage({
      message: request.message,
      conversationId: request.conversationId ?? null,
      customerEmail: request.customerEmail,
      confirmAction: request.confirmAction,
    });

    // Log for observability (Section 12 will formalize this)
    console.log(`Agent response:`, {
      outcome: response.outcome,
      confidence: response.confidence,
      toolCalls: toolCalls.map((t) => t.tool),
      durationMs: toolCalls.reduce((sum, t) => sum + t.durationMs, 0),
    });

    return NextResponse.json(response);
  } catch (error) {
    // Catch-all error handler
    // In production, this would log to an error tracking service
    // (Sentry, Datadog). For now, console.error is sufficient.
    console.error('Agent error:', error);

    return NextResponse.json(
      {
        error: 'An internal error occurred',
        message:
          "I'm experiencing a temporary issue. Please try again " +
          'in a moment, or contact support directly.',
      },
      { status: 500 },
    );
  }
}
