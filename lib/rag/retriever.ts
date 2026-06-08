// PURPOSE: Finds the most relevant knowledge base chunks for a
// given user query using vector similarity search
//
// This is the "read" side of RAG. Its runs on every conversation
// turn where the agent needs policy or product information
//
// HOW IT WORKS:
//   1. User asks: "Can I get a refund?"
//   2. We embed that question using Voyage AI (query input_type)
//   3. We search pgvector for the chunks most similar to that
//      question's embedding (cosine similarity)
//   4. We return the top-K chunks as context for Claude
//
// PATTERN: Semantic Search ith Cosine Similarity.
// Cosine similarity measures the angle between two vectors.
// Vectors pointing in the same direction (similar meaning) have
// a cosine similarity near 1.0 Orthogonal vectors (unrelated meaning)
// have similarity near 0.0

// Number of chunks to retrieve per query
// More chunks = more context for Claude, but also more tokens
// 5 is a good starting point; tune based on answer quality.
import { embedQuery } from '@/lib/rag/embeddings';
import { neon } from '@neondatabase/serverless';

const DEFAULT_TOP_K = 5;

// Minimum similarity score to include a chunk.
const MIN_SIMILARITY_SCORE = 0.3;

export interface RetrievedChunk {
  id: string;
  content: string;
  sourceTitle: string;
  sectionTitle: string | null;
  similarityScore: number;
}

// Public API

// Retrieves the most relevant knowledge base chunks for a query.
export const retrieveRelevantChunks = async (
  query: string,
  tenantId?: string,
  topK: number = DEFAULT_TOP_K,
): Promise<RetrievedChunk[]> => {
  // Step 1: Embed the query using Voyage AI
  // Note: we use "query" input_type, not "document"
  const queryEmbedding = await embedQuery(query);

  // Step 2: Format the embedding as a pgvector-compatible string
  const embeddingStr = `[${queryEmbedding.join(',')}]`;

  // Step 3: Query pgvector for the most similar chunks
  //
  // SQL BREAKDOWN:
  //   embedding::vector(1024)  → Cast our text column to pgvector type
  //   <=>                      → Cosine distance operator (lower = more similar)
  //   1 - (distance)           → Convert distance to similarity (higher = more similar)
  //   ORDER BY distance ASC    → Most similar first
  //   LIMIT $topK              → Only return top results

  const sql = neon(process.env.DATABASE_URL!);

  // Build the query with optional tenant filtering.
  // When tenantId is provided (Section 15+), only return documents
  // belonging to that tenant. When null, return all documents
  // (single-tenant mode).

  const results = await sql`
    SELECT
      id,
      content,
      source_document AS "sourceDocument",
      section_title AS "sectionTitle",
      1 - (embedding::vector(1024) <=> ${embeddingStr}::vector(1024)) AS "similarityScore"
    FROM knowledge_documents
    WHERE 1 - (embedding::vector(1024) <=> ${embeddingStr}::vector(1024)) > ${MIN_SIMILARITY_SCORE}
      ${tenantId ? sql`AND tenant_id = ${tenantId}` : sql``}
    ORDER BY embedding::vector(1024) <=> ${embeddingStr}::vector(1024) ASC
    LIMIT ${topK}
  `;

  return results as RetrievedChunk[];
};
