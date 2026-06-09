import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { processMessage } from '@/lib/agent/core';
import {
  consumePendingAction,
  cancelPendingAction,
} from '@/lib/guardrails/confirmation';
import { toolRegistry } from '@/lib/tools/registry';
import {
  createConversation,
  loadHistory,
  storeMessage,
  updateConversationStatus,
} from '@/lib/agent/memory';
import { buildFallbackResponse } from '@/lib/agent/fallback';
import { logTrace } from '@/lib/eval/logger';

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
  const startTime = Date.now();
  let conversationId: string | null = null;

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
    conversationId = request.conversationId || null;

    const tenant = {
      // TODO UPDATE 'tenant' form ^^
      id: 'default',
      companyName: 'Demo',
    };

    // Handle confirmation of a pending action
    // User confirmed a pending action → execute it directly
    if (request.confirmAction && conversationId) {
      const pending = consumePendingAction(conversationId);

      if (!pending) {
        return NextResponse.json({
          message:
            "There's no pending action to confirm. It may have " +
            "expired. Could you tell me what you'd like to do?",
          conversationId: conversationId,
          requiresConfirmation: false,
          outcome: 'continue',
          confidence: 0.8,
        });
      }

      // Execute the pending action
      // Note: In the multi-tenant version (Section 15), pass the
      // tenant-scoped context here as the third argument.
      const { result, durationMs } = await toolRegistry.execute(
        pending.toolName,
        pending.args,
        {
          tenantId: tenant.id,
          tenantName: tenant.companyName,
        },
      );

      const parsedResult = JSON.parse(result);
      const success = parsedResult.success !== false;

      return NextResponse.json({
        message: success
          ? `Done! ${pending.description} has been processed successfully.`
          : `I wasn't able to complete that: ${parsedResult.error}`,
        conversationId: conversationId,
        requiresConfirmation: false,
        outcome: success ? 'resolved' : 'error',
        confidence: 0.95,
      });
    }

    // User declined a pending action → clear it, fall through to processMessage
    if (request.confirmAction === false && conversationId) {
      cancelPendingAction(conversationId);
      // Fall through to processMessage — let Claude handle the "no"
    }

    // Load or create conversation
    let history: Anthropic.MessageParam[] = [];

    if (conversationId) {
      // Existing conversation — load history
      history = await loadHistory(conversationId);
    } else {
      // New conversation — create one
      conversationId = await createConversation(
          undefined, // tenant?.id, //TODO implemented in section 15
        request.customerEmail,
      );
    }

    // Store the user's message
    await storeMessage(conversationId, 'user', request.message);

    // Call the agent with conversation history
    const { response, toolCalls } = await processMessage(
      { ...request, conversationId },
      history,
    );

    // Store the agent's response
    await storeMessage(conversationId, 'assistant', response.message);

    // Update conversation status if resolved or escalated
    if (response.outcome === 'resolved' || response.outcome === 'escalated') {
      await updateConversationStatus(
        conversationId,
        response.outcome,
        response.message.substring(0, 500), // Store first 500 chars as resolution
      );
    }

    // Log the trace (fire-and-forget — don't await)
    const totalDuration = Date.now() - startTime;
    logTrace({
      conversationId: response.conversationId,
      userInput: request.message,
      response,
      toolCalls,
      totalDurationMs: totalDuration,
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-6',
    }).catch((err) => console.error('Trace failed:', err)); // Swallow logging errors silently

    // Development logging — formalized trace is logged above via logTrace
    console.log(`Agent response:`, {
      outcome: response.outcome,
      confidence: response.confidence,
      toolCalls: toolCalls.map((t) => t.tool),
      durationMs: totalDuration,
    });

    // Add timing header for debugging
    const res = NextResponse.json(response);
    res.headers.set('X-Agent-Duration-Ms', totalDuration.toString());
    res.headers.set('X-Agent-Tool-Calls', toolCalls.length.toString());

    return res;
  } catch (error) {
    // Graceful fallback:
    // the customer always gets a response, even when something breaks.
    // The fallback categorizes the error and returns an appropriate message.
    //
    // In production, also send to an error tracking service
    // (Sentry, Datadog) for alerting and deduplication.
    console.error('Agent error:', error);

    const fallback = buildFallbackResponse(
      error instanceof Error ? error : new Error('Unknown error'),
        conversationId || 'unknown',
    );

    // Still return 200 — the response IS the error handling.
    // A 500 means our error handling itself failed.
    return NextResponse.json(fallback);
  }
}
