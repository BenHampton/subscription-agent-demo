select current_database();

-- CREATE EXTENSION IF NOT EXISTS vector;

    -- Verify tables created
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;


    -- Create a function that casts our text column to a vector type
-- CREATE INDEX knowledge_embedding_idx
--     ON knowledge_documents
--         USING ivfflat ((embedding::vector(512)) vector_cosine_ops)
--     WITH (lists = 100);
    -- Verify
-- You should see knowledge_embedding_idx in the results
-- along with the two indexes from the migration (knowledge_source_idx and knowledge_tenant_idx). Three total.
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'knowledge_documents';


SELECT id, source_document, section_title, chunk_index, length(content) as content_length
FROM knowledge_documents
ORDER BY source_document, chunk_index;



