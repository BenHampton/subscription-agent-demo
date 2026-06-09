import { AgentResponse } from './types';

// PURPOSE: Centralized error handling and fallback strategizes
//
// PATTERN: Circuit Breaker + Fallback Chain
// When a component fails (Stripe API down, Voyage embeddings
// timeout, Claude rate-limited), we don't crash, we degrade
// gracefully through a chain of fallbacks:
//   1. Retry (with exponential backoff for transient errors)
//   2. Partial response (answer what we can without the failed tool)
//   3. Human handoff (escalate with full context)

/**
 * Retry a function with exponential backoff.
 *
 * WHY EXPONENTIAL BACKOFF?
 * If Stripe's API is rate-limited or temporarily down, retrying
 * immediately will just get rate-limited again. Exponential backoff
 * (wait 1s, then 2s, then 4s) gives the service time to recover
 * while still retrying quickly for transient glitches.
 *
 * @param fn - The async function to retry
 * @param maxRetries - Maximum number of retries (default: 3)
 * @param baseDelayMs - Initial delay in ms (default: 1000)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on non-transient errors
      if (isNonRetryable(error)) {
        throw lastError;
      }

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.warn(
          `Retry ${attempt + 1}/${maxRetries} after ${delay}ms:`,
          lastError.message,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Check if an error is non-retryable (e.g., validation errors,
 * auth failures — retrying won't fix these).
 */
function isNonRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('invalid') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('not found')
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fallback Response Builder

/**
 * Generate a graceful fallback response when the agent can't
 * process the request normally.
 *
 * This function is the "safety net" — called when processMessage()
 * throws an unrecoverable error. It ensures the customer always
 * gets a human-readable response.
 */
export function buildFallbackResponse(
  error: Error,
  conversationId: string,
): AgentResponse {
  console.error('Agent fallback triggered:', error.message);

  // Categorize the error for appropriate messaging
  const msg = error.message.toLowerCase();

  if (msg.includes('rate limit') || msg.includes('429')) {
    return {
      message:
        "I'm currently handling a high volume of requests. " +
        'Could you try again in a moment? If this persists, ' +
        'I can connect you with a team member.',
      conversationId,
      requiresConfirmation: false,
      outcome: 'error',
      confidence: 0.5,
    };
  }

  if (msg.includes('stripe') || msg.includes('billing')) {
    return {
      message:
        "I'm having trouble accessing the billing system right now. " +
        'Let me connect you with a team member who can help. ' +
        "Your issue hasn't been lost — they'll have full context.",
      conversationId,
      requiresConfirmation: false,
      outcome: 'escalated',
      confidence: 0.3,
    };
  }

  // Generic fallback
  return {
    message:
      "I'm experiencing a temporary issue and can't fully process " +
      'your request right now. Let me connect you with a team member ' +
      'who can help. I apologize for the inconvenience.',
    conversationId,
    requiresConfirmation: false,
    outcome: 'escalated',
    confidence: 0.2,
  };
}
