// PURPOSE: Tools that search the RAG knowledge base

import { RegisteredTool } from '@/lib/agent/types';
import { retrieveRelevantChunks } from '@/lib/rag/retriever';
import { z } from 'zod';

// Zod schema for runtime validation
const KnowledgeSearchArgs = z.object({
  query: z.string().min(1, 'Search query cannot be empty'),
});

export const knowledgeSearchTool: RegisteredTool = {
  definition: {
    name: 'search_knowledge_base',
    description:
      'Search the company knowledge base for information about ' +
      'policies, pricing, features, FAQs, and procedures. Use ' +
      'this tool whenever you need to look up specific rules ' +
      '(refund eligibility, plan features, billing procedures) ' +
      'before making a decision or answering a question. Always ' +
      'search before stating policy. Never guess at rules.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'A natural language search query describing what ' +
            "information you need. Be specific: 'refund " +
            "eligibility for monthly subscriptions' is better " +
            "than 'refund rules'.",
        },
      },
      required: ['query'],
    },
  },

  handler: async (args, context) => {
    // Validate arguments with Zod — catches malformed LLM output
    const parsed = KnowledgeSearchArgs.safeParse(args);
    if (!parsed.success) {
      return JSON.stringify({
        error: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      });
    }
    const { query } = parsed.data;

    // Pass context.tenantId to scope retrieval to this tenant's knowledge base only.
    // Never return another tenant's documents
    const chunks = await retrieveRelevantChunks(query, context.tenantId, 5);

    if (chunks.length === 0) {
      return JSON.stringify({
        found: false,
        message: 'No relevant information found in the knowledge base.',
      });
    }

    // Format results for Claude to read
    // Include source and similarity score so Claude can judge
    // relevance and cite its sources
    const results = chunks.map((chunk) => ({
      source: chunk.sourceDocument,
      section: chunk.sectionTitle,
      relevance: Math.round(chunk.similarityScore * 100) + '%',
      content: chunk.content,
    }));

    return JSON.stringify({ found: true, results });
  },

  requiresConfirmation: false, // Read-only — no side effects
  category: 'knowledge',
};
