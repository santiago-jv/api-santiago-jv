export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

export const SITE_CONFIG_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS site_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO site_config (key, value, category, description) VALUES
  ('primary_domain', 'santiago-jv.tech', 'domains', 'Primary root domain'),
  ('portfolio_url', 'https://www.santiago-jv.tech', 'domains', 'Public portfolio base URL'),
  ('ai_console_url', 'https://ai.santiago-jv.tech', 'domains', 'Interactive AI console base URL'),
  ('api_url', 'https://api.santiago-jv.tech', 'domains', 'NestJS AI & RAG backend base URL'),
  ('mcp_url', 'https://mcp.santiago-jv.tech/mcp', 'domains', 'Public MCP Streamable HTTP endpoint'),
  ('mcp_docs_url', 'https://mcp.santiago-jv.tech/docs', 'domains', 'Public MCP interactive docs URL'),
  ('allowed_origins', 'https://ai.santiago-jv.tech,https://www.santiago-jv.tech,https://santiago-jv.tech', 'domains', 'Comma-separated CORS and gatekeeper allowed browser origins'),
  ('contact_email', 'contact@santiago-jv.tech', 'social', 'Primary public and Resend destination email'),
  ('x_handle', '@santiagojvtech', 'social', 'X (Twitter) handle'),
  ('x_url', 'https://x.com/santiagojvtech', 'social', 'X (Twitter) profile URL'),
  ('linkedin_handle', '/in/santiago-jv', 'social', 'LinkedIn short handle'),
  ('linkedin_url', 'https://www.linkedin.com/in/santiago-jv', 'social', 'LinkedIn profile URL'),
  ('github_handle', '@santiago-jv', 'social', 'GitHub handle'),
  ('github_url', 'https://github.com/santiago-jv', 'social', 'GitHub profile URL'),
  ('medium_handle', '@santiago-jv', 'social', 'Medium handle'),
  ('medium_url', 'https://medium.com/@santiago-jv/', 'social', 'Medium blog URL'),
  ('resume_en_url', 'https://www.santiago-jv.tech/Santiago_Olayo_Villamil_CV_EN.pdf', 'career', 'English Resume PDF URL'),
  ('resume_es_url', 'https://www.santiago-jv.tech/Santiago_Olayo_Villamil_CV_ES.pdf', 'career', 'Spanish Resume PDF URL'),
  ('availability_status', 'open', 'career', 'Current recruiting availability status (open, selective, unavailable)'),
  ('work_modalities_en', '100% Remote (Global, US, LatAm, Colombia) or Hybrid / On-site in Barranquilla and Santa Marta, Colombia', 'career', 'Supported work modalities in English'),
  ('work_modalities_es', '100% Remoto (Global, EE. UU., LatAm, Colombia) o Híbrido / Presencial en Barranquilla y Santa Marta, Colombia', 'career', 'Supported work modalities in Spanish'),
  ('location_en', 'Barranquilla / Santa Marta, Colombia (UTC-5)', 'career', 'Location and timezone label in English'),
  ('location_es', 'Barranquilla / Santa Marta, Colombia (UTC-5)', 'career', 'Location and timezone label in Spanish')
ON CONFLICT (key) DO NOTHING;
`.trim();

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

${SITE_CONFIG_MIGRATION_SQL}
`.trim();
}
