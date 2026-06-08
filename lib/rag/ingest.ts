// PURPOSE: Takes raw markdown documents, splits them into chunks,
// embeds each chunk, and stores them in the knowledge_documents table.
//
// This is the "write" side of RAG. It runs once (or periodically)
// to populate the knowledge base. The "read" side is the retriever
// (lib/rag/retriever.ts) which searches at query time.
//
// PATTERN: ETL Pipeline (Extract -> Transform -> Load)
//   Extract:   Read markdown files from disk
//   Transform: Split into chunks, generate embeddings
//   Load:      Insert into PostgreSQL with pgvector

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { db, knowledgeDocuments } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { embedTexts } from '@/lib/rag/embeddings';

const MAX_CHUNK_SIZE = 1500;
const MIN_CHUNK_SIZE = 50;

interface DocumentChuck {
  content: string;
  sourceDocument: string;
  sectionTitle: string | null;
  chunkIndex: number;
  metadata: Record<string, string>;
}

// Strategy:
// 1. Split on ## and ### headers (section boundaries)
// 2. Keep each section as one chunk if it's under MAX_CHUNK_SIZE
// 3. Split oversized sections on paragraph boundaries (\n\n)
// 4. Discard chunks under MIN_CHUNK_SIZE
// 5. Store section title as metadata for each chunk

const chunkDocument = (content: string, filename: string): DocumentChuck[] => {
  const chunks: DocumentChuck[] = [];

  // Split on markdown headers (## or ###)
  // The regex captures the header text for use as sectionTitle
  const sections = content.split(/(?=^#{2,3}\s)/m);

  let chunkIndex = 0;

  for (const section of sections) {
    const trimmed = section.trim();
    if (trimmed.length < MIN_CHUNK_SIZE) {
      continue;
    }

    // Extract section title from the first line if it's a header
    const headerMatch = trimmed.match(/^#{2,3}\s+(.+)$/m);
    const sectionTitle = headerMatch ? headerMatch[1].trim() : null;

    // If section is small enough, keep it as one chunk
    if (trimmed.length <= MAX_CHUNK_SIZE) {
      chunks.push({
        content: trimmed,
        sourceDocument: filename,
        sectionTitle,
        chunkIndex: chunkIndex++,
        metadata: { source: filename },
      });
    } else {
      // Section is too long — split on paragraph boundaries
      const paragraphs = trimmed.split(/\n\n+/);
      let currentChunk = '';

      for (const para of paragraphs) {
        if (
          currentChunk.length + para.length + 2 > MAX_CHUNK_SIZE &&
          currentChunk.length > MIN_CHUNK_SIZE
        ) {
          // Flush current chunk
          chunks.push({
            content: currentChunk.trim(),
            sourceDocument: filename,
            sectionTitle,
            chunkIndex: chunkIndex++,
            metadata: { source: filename },
          });
          currentChunk = '';
        }
        currentChunk += para + '\n\n';
      }

      // Don't forget the last chunk
      if (currentChunk.trim().length >= MIN_CHUNK_SIZE) {
        chunks.push({
          content: currentChunk.trim(),
          sourceDocument: filename,
          sectionTitle,
          chunkIndex: chunkIndex++,
          metadata: { source: filename },
        });
      }
    }
  }

  return chunks;
};

// Public API

// Ingests all markdown files from the knowledge-base directory.
// 1. Reads all .md files from knowledge-base/
// 2. Chunks each document using section-aware splitting
// 3. Embeds all chunks in batches via Voyage AI
// 4. Upserts into the knowledge_documents table

export const ingestKnowledgeBase = async (
  tenantId?: string,
  knowledgeBaseDir: string = './knowledge-base',
): Promise<{ documentsProcessed: number; chunksCreated: number }> => {
  const files = readdirSync(knowledgeBaseDir).filter((f) => f.endsWith('.md'));

  let totalChunks = 0;

  for (const file of files) {
    const filePath = join(knowledgeBaseDir, file);
    const content = readFileSync(filePath, 'utf-8');

    console.log(`Processing: ${file}`);

    // Step 1: Chunk the document
    const chunks = chunkDocument(content, file);
    console.log(`  → ${chunks.length} chunks`);

    if (chunks.length === 0) continue;

    // Step 2: Delete existing chunks for this document (idempotency)
    await db
      .delete(knowledgeDocuments)
      .where(eq(knowledgeDocuments.sourceDocument, file));

    // Step 3: Embed all chunks in one batch
    // Using "document" input_type because these are knowledge
    // base documents, not user queries
    const embeddings = await embedTexts(
      chunks.map((c) => c.content),
      'document',
    );
    console.log(`  → Embeddings generated`);

    // Step 4: Insert chunks with their embeddings
    const rows = chunks.map((chunk, i) => ({
      content: chunk.content,
      sourceDocument: chunk.sourceDocument,
      sectionTitle: chunk.sectionTitle,
      chunkIndex: chunk.chunkIndex,
      metadata: chunk.metadata,
      // Store embedding as a JSON string of the float array.
      // pgvector expects the format "[0.1, 0.2, ...]"
      embedding: `[${embeddings[i].join(',')}]`,
      // Associate with tenant if provided (Section 15: multi-tenancy)
      // When null, documents are accessible to all (single-tenant mode)
      tenantId: tenantId || null,
    }));

    await db.insert(knowledgeDocuments).values(rows);
    console.log(`  → Inserted into database`);

    totalChunks += chunks.length;
  }

  return {
    documentsProcessed: files.length,
    chunksCreated: totalChunks,
  };
};
