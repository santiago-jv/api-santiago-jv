export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

export function buildRagMigrationSql(dimensions = DEFAULT_EMBEDDING_DIMENSIONS): string {
  const safeDims = Number.isInteger(dimensions) && dimensions >= 128 && dimensions <= 2000
    ? dimensions
    : DEFAULT_EMBEDDING_DIMENSIONS;

  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  section_id TEXT NOT NULL,
  section_title TEXT NOT NULL,
  contextual_header TEXT NOT NULL,
  content TEXT NOT NULL,
  embedded_text TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  token_estimate INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding vector(${safeDims}) NOT NULL,
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(section_title, '') || ' ' || coalesce(contextual_header, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(section_title, '') || ' ' || coalesce(content, '')), 'C')
  ) STORED,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document_id
  ON knowledge_chunks(document_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_section_id
  ON knowledge_chunks(section_id);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tsv_gin
  ON knowledge_chunks USING gin(search_tsv);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS rag_query_logs (
  id BIGSERIAL PRIMARY KEY,
  query_text TEXT NOT NULL,
  keywords TEXT[] NOT NULL DEFAULT '{}'::text[],
  category TEXT,
  search_mode TEXT NOT NULL,
  matched_chunk_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  top_rrf_score DOUBLE PRECISION,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_query_logs_created_at
  ON rag_query_logs(created_at DESC);
`.trim();
}
