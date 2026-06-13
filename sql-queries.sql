SELECT version();
select current_database();

-- INIT

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

SELECT id, status, created_at
FROM conversations
ORDER BY created_at DESC
LIMIT 1;


-- TRACE

SELECT count(*) FROM agent_traces;

-- Query raw data behind the metrics endpoint.
-- Shows every agent decision with its confidence score, duration, and outcome.
SELECT
    outcome,
    confidence_score,
    total_duration_ms,
    model_used,
    substring(user_input, 1, 50) as question,
    substring(agent_response, 1, 80) as answer
FROM agent_traces
ORDER BY created_at DESC
LIMIT 10;


