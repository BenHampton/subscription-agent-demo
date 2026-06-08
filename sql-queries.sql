-- CREATE EXTENSION IF NOT EXISTS vector;

    -- Verify tables created
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
-- ORDER BY table_name;


    -- Create a function that casts our text column to a vector type
-- CREATE INDEX IF NOT EXISTS knowledge_embedding_idx
-- ON knowledge_documents
-- USING ivfflat ((embedding::vector(1024)) vector_cosine_ops)
-- WITH (lists = 100);
    -- Verify
-- You should see knowledge_embedding_idx in the results
-- along with the two indexes from the migration (knowledge_source_idx and knowledge_tenant_idx). Three total.
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE tablename = 'knowledge_documents';
