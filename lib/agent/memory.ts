import Anthropic from '@anthropic-ai/sdk';
import { db, conversations, conversationMessages } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

// PURPOSE: Persists and retrieves conversation history
//
// PATTERN: Conversation Store
// Every message in a conversation is stored as a row in the
// conversation_messages table. On each new request, we load
// the full history and pass it to Claude as the messages array.

/**
 * Create a new conversation and return its ID.
 */
export async function createConversation(
  tenantId?: string,
  customerEmail?: string,
): Promise<string> {
  const id = uuidv4();
  await db.insert(conversations).values({
    id,
    tenantId: tenantId || null,
    customerId: customerEmail || null,
    status: 'active',
  });
  return id;
}

/**
 * Store a message in the conversation history.
 */
export async function storeMessage(
  conversationId: string,
  role: string,
  content: string,
  metadata?: {
    toolName?: string;
    toolArgs?: string;
    toolCallId?: string;
  },
): Promise<void> {
  // Get the next sequence number for this conversation
  const existing = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId));

  await db.insert(conversationMessages).values({
    conversationId,
    role,
    content,
    toolName: metadata?.toolName || null,
    toolArgs: metadata?.toolArgs || null,
    toolCallId: metadata?.toolCallId || null,
    sequence: existing.length,
  });
}

/**
 * Load conversation history as Anthropic MessageParam[].
 *
 * This transforms our database rows back into the format
 * Anthropic's API expects. The key challenge is reconstructing
 * tool_use and tool_result content blocks, which are stored
 * as separate rows but need to be grouped into messages.
 *
 * APPROACH: We store the role and the full content for each
 * message. For user/assistant text messages, content is a string.
 * For tool calls and results, content is the JSON-serialized
 * content blocks. When loading, we detect which format it is
 * and reconstruct accordingly.
 */
export async function loadHistory(
  conversationId: string,
): Promise<Anthropic.MessageParam[]> {
  const rows = await db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, conversationId))
    .orderBy(conversationMessages.sequence);

  if (rows.length === 0) return [];

  const messages: Anthropic.MessageParam[] = [];

  for (const row of rows) {
    // Try to parse content as JSON (tool blocks are stored as JSON)
    // If it fails, treat as plain text (user/assistant messages)
    let content: string | Anthropic.ContentBlock[];
    try {
      const parsed = JSON.parse(row.content);
      // If it's an array of content blocks, use as-is
      if (Array.isArray(parsed)) {
        content = parsed;
      } else {
        content = row.content;
      }
    } catch {
      // Not JSON — plain text message
      content = row.content;
    }

    messages.push({
      role: row.role as 'user' | 'assistant',
      content,
    });
  }

  return messages;
}

/**
 * Update conversation status (resolved, escalated, etc.)
 */
export async function updateConversationStatus(
  conversationId: string,
  status: string,
  resolution?: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({
      status,
      resolution: resolution || null,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));
}
