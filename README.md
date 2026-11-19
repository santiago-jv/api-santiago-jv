# Santiago Olayo — `@nestjs/ai` + `pgvector` Hybrid RAG Backend (`api.santiago-jv.tech`)

Production **NestJS 12 + `@nestjs/ai` + PostgreSQL (`pgvector`)** backend powering the interactive AI engineering and recruiter assistant at **[ai.santiago-jv.tech](https://ai.santiago-jv.tech)** and **[www.santiago-jv.tech](https://www.santiago-jv.tech)**.

---

## Architecture (Hexagonal / Ports & Adapters)

```text
api-santiago-jv/
├── api/index.ts                                  # Vercel Serverless Express entry point
├── docker-compose.yml                            # Local pgvector/pgvector:pg17 container (port 5433)
├── migrations/
│   └── 001_init_rag.sql                          # knowledge_documents, knowledge_chunks (vector(768) + tsvector), rag_query_logs
├── scripts/
│   ├── db-migrate.ts                             # Idempotent PostgreSQL + pgvector migration runner
│   ├── ingest-knowledge.ts                       # Contextual chunking + Gemini embeddings + hash-based upsert CLI
│   ├── rag-query.ts                              # CLI debugger for live hybrid RAG search scores
│   └── pack-secrets.ts                           # Encodes .private/system-prompt.txt -> AGENT_SYSTEM_PROMPT_B64
└── src/
    ├── domain/
    │   ├── knowledge-repository.service.ts       # RAG orchestration, lexical degradation & query telemetry
    │   └── knowledge/
    │       ├── knowledge.types.ts                # Document, chunk, search hit & health domain models
    │       ├── knowledge.ports.ts                # KNOWLEDGE_SEARCH_PORT, KNOWLEDGE_INGESTION_PORT, EMBEDDING_PORT
    │       └── markdown-chunker.ts               # Section-aware contextual chunker + overlap + SHA-256 hashes
    ├── application/
    │   ├── portfolio-tools.provider.ts           # @AgentFunction: list_knowledge_topics, query_knowledge_base
    │   └── portfolio-agent.service.ts            # @nestjs/ai loop, LRU cache, sandboxed history & fallback reply
    ├── infrastructure/
    │   ├── ai/
    │   │   └── nestjs-embedding.adapter.ts       # @nestjs/ai AiService embed / embedMany (gemini-embedding-001 @ 768d)
    │   ├── database/
    │   │   ├── rag-schema.ts                     # Embedded SQL migration + DEFAULT_EMBEDDING_DIMENSIONS (768)
    │   │   ├── postgres-pool.provider.ts         # pg.Pool + smart TLS + @vercel/functions attachDatabasePool
    │   │   ├── pgvector-knowledge.repository.ts  # Hybrid HNSW + GIN tsvector RRF search & incremental upsert
    │   │   └── in-memory-knowledge.repository.ts # Test & offline fallback adapter when DATABASE_URL is unset
    │   └── security/
    │       ├── hmac-origin.guard.ts              # Origin allowlist + HMAC-SHA256 + 60s replay protection
    │       ├── rate-limit.guard.ts               # Dual-window per-IP rate limiter (minute + hour buckets)
    │       └── prompt-injection.guard.ts         # Heuristic pre-LLM inspection, XML sandboxing & output sanitizer
    ├── presentation/
    │   └── agent.controller.ts                   # GET /health, POST /v1/agent/chat
    ├── app.module.ts                             # AiModule.forRoot + Ports/Adapters wiring
    └── main.ts                                   # NestJS bootstrap + getServerlessExpressApp()
```

---

## Hybrid RAG Pipeline (`pgvector` + PostgreSQL FTS + RRF)

1. **Contextual Markdown Chunking (`markdown-chunker.ts`):** Splits private knowledge documents by `##` sections (code-fence aware), preserves document and per-section metadata directives (`category`, `company`, `tags`), prepends document and section breadcrumb headers (`contextual_header`), splits oversized sections along paragraph boundaries with overlap, and computes deterministic SHA-256 `content_hash` fingerprints.
2. **Matryoshka Dense Embeddings (`NestJsEmbeddingAdapter`):** Generates `768`-dimension vectors via `@nestjs/ai` using Google `gemini-embedding-001` (`outputDimensionality: 768`), fitting cleanly inside `pgvector`'s 2000-dimension HNSW index cap.
3. **Hybrid Retrieval + Reciprocal Rank Fusion (`PgVectorKnowledgeRepository`):** Runs a single PostgreSQL CTE combining:
   - **Semantic vector search:** HNSW cosine distance index (`vector_cosine_ops`, `m = 16`, `ef_construction = 64`) on `knowledge_chunks.embedding`.
   - **Weighted Full-Text Search:** GIN-indexed generated `search_tsv` column combining `'A'` titles/headers (`simple`), `'B'` content (`simple` for exact tech identifiers), and `'C'` English stemming (`english`), queried safely via `buildWebsearchOrQuery()`.
   - **RRF Fusion:** Merges both candidate pools with `0.65 / (60.0 + sem_rank) + 0.35 / (60.0 + lex_rank)`, degrading gracefully to PostgreSQL FTS if embeddings fail or `in-memory-fallback` when `DATABASE_URL` is unset.
4. **Incremental Ingestion & Telemetry:** `npm run ingest` skips unchanged documents/chunks via SHA-256 hashes, prunes deleted sources automatically (pass `--no-prune` to keep them), and records query metrics (`search_mode`, `top_rrf_score`, `latency_ms`) in `rag_query_logs` via `@vercel/functions` `waitUntil`.

---

## Model Routing & Security Architecture

- **LLM Fallback Chain (`AppModule`):** Primary `openai/gpt-oss-120b` (`GROQ_MODEL_ID` or `AI_GATEWAY_MODEL`) -> secondary `openai/gpt-oss-20b` (`GROQ_SECONDARY_MODEL_ID`) -> fallback `gemini-3.8-flash` (`GEMINI_MODEL_ID`), with optional Cloudflare AI Gateway URL overrides (`CLOUDFLARE_AI_GATEWAY_GOOGLE_URL`, `CLOUDFLARE_AI_GATEWAY_GROQ_URL`).
- **6-Layer Security Shield:**
  1. Cloudflare WAF / optional AI Gateway edge protection.
  2. `HmacOriginGuard`: origin allowlist + HMAC-SHA256 (`X-Santiago-Timestamp` + `X-Santiago-Signature` within a 60s replay window).
  3. `RateLimitGuard`: dual-window per-IP rate limiting (default 8 req/min, 30 req/hour).
  4. `inspectAndSandboxUserMessage`: pre-LLM prompt injection and system extraction blocking (EN/ES) before spending tokens.
  5. XML delimiter sandboxing (`<untrusted_recruiter_input>`) + read-only `@AgentFunction` tools (`list_knowledge_topics`, `query_knowledge_base`).
  6. `sanitizeModelOutput`: post-generation leak sanitizer.

---

## Zero Prompts / Zero Private Markdown in Git

Because this repository is **public**, **no system prompts or private profile markdown files are committed to Git**:

1. Local authoring files live inside `.private/system-prompt.txt` and `.private/knowledge/*.md` (strictly ignored via `.gitignore`).
2. Run `npm run pack:secrets` locally to encode `.private/system-prompt.txt` into `AGENT_SYSTEM_PROMPT_B64` for Vercel Environment Variables.
3. Private profile knowledge lives inside PostgreSQL (`knowledge_documents` & `knowledge_chunks`), avoiding multi-KB environment variable hacks.
4. An automated unit test in `test/api-santiago-jv.test.ts` fails CI if any `.md`, `.txt`, or `.prompt` file is ever placed inside `src/`.

---

## Local Development (`pgvector` Docker)

```bash
# 1. Install dependencies & prepare local env
npm install
cp .env.example .env

# 2. Start local pgvector/pgvector:pg17 on port 5433
docker compose up -d

# 3. Apply SQL schema & ingest private knowledge chunks
npm run db:migrate
npm run ingest -- --dry-run
npm run ingest

# 4. Inspect hybrid retrieval directly
npm run rag:search -- "Stripe payment idempotency and Nequi webhooks"

# 5. Typecheck, unit tests, live pgvector integration tests & build
npm run typecheck
npm test
npm run test:integration
npm run build
```

---

## Production Deployment (Vercel + Neon Postgres)

1. Provision **Neon Postgres** in Vercel Marketplace (or connect a Neon database with `pgvector`) and expose `DATABASE_URL` in Vercel Environment Variables (`PostgresPoolProvider` uses `@vercel/functions` `attachDatabasePool` and enables SSL automatically for non-local hosts).
2. Configure `AGENT_SYSTEM_PROMPT_B64` (from `npm run pack:secrets`), `INTERNAL_HMAC_SECRET`, `GROQ_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `EMBEDDING_MODEL_ID=gemini-embedding-001`, and `EMBEDDING_DIMENSIONS=768` in Vercel Environment Variables.
3. Run schema migration and knowledge ingestion against your Neon connection string:

```bash
DATABASE_URL="<neon-postgres-connection-string>" npm run db:migrate
DATABASE_URL="<neon-postgres-connection-string>" npm run ingest
```
