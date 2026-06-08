// PURPOSE: Standalone script to ingest knowledge base documents.
// Run with: npm run seed:knowledge
//
// This script runs Outside of Next.js (via tsx), so we need to
// manually load environment variables with dotenv.

import { ingestKnowledgeBase } from '@/lib/rag/ingest';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('=== Knowledge Base Ingestion ===\n');

  // Optional tenant ID — pass as argument for multi-tenant mode.
  // Without it, documents are ingested without tenant scoping.
  const tenantId = process.argv[2] || undefined;

  try {
    const result = await ingestKnowledgeBase(tenantId);

    console.log('\n=== Ingestion Complete ===');

    if (tenantId) {
      console.log(`Tenant: ${tenantId}`);
    } else {
      console.log('Mode: single-tenant (no tenant_id set)');
    }

    console.log(`Documents processed: ${result.documentsProcessed}`);
    console.log(`Chunks created: ${result.chunksCreated}`);
  } catch (error) {
    console.error('Ingestion failed:', error);
    process.exit(1);
  }
}

main();
