import { Inject, Injectable, Logger } from '@nestjs/common';
import { toSql } from 'pgvector/pg';
import type {
  HybridSearchPortInput,
  KnowledgeIngestionPort,
  KnowledgeSearchPort,
} from '../../domain/knowledge/knowledge.ports.js';
import type {
  KnowledgeChunkWithEmbedding,
  KnowledgeDocumentDraft,
  KnowledgeSearchHit,
  KnowledgeTopic,
  UpsertDocumentResult,
} from '../../domain/knowledge/knowledge.types.js';
import { PostgresPoolProvider } from './postgres-pool.provider.js';
import { buildRagMigrationSql, DEFAULT_EMBEDDING_DIMENSIONS } from './rag-schema.js';

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'which',
  'where',
  'when',
  'how',
  'does',
  'did',
  'have',
  'has',
  'had',
  'are',
  'was',
  'were',
  'about',
  'into',
  'using',
  'used',
  'use',
  'work',
  'working',
  'experience',
  'santiago',
  'olayo',
  'villamil',
  'que',
  'como',
  'cual',
  'cuales',
  'donde',
  'cuando',
  'para',
  'por',
  'con',
  'sin',
  'sobre',
  'tiene',
  'tuvo',
  'usa',
  'uso',
  'experiencia',
  'empresa',
  'empresas',
  'trabajo',
  'or',
  'and',
  'not',
]);

export function buildWebsearchOrQuery(queryText: string, keywords: string[]): string {
  const combined = [queryText, ...keywords].join(' ');
  const tokens = combined
    .toLowerCase()
    .replace(/["'()[\]{}?!,;:|&<>]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[./-]+|[./-]+$/g, '').trim())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  const unique = Array.from(new Set(tokens)).slice(0, 14);
  return unique.join(' OR ');
}

@Injectable()
export class PgVectorKnowledgeRepository
  implements KnowledgeSearchPort, KnowledgeIngestionPort
{
  readonly backend = 'postgres-pgvector' as const;
  private readonly logger = new Logger(PgVectorKnowledgeRepository.name);

  constructor(
    @Inject(PostgresPoolProvider)
    private readonly poolProvider: PostgresPoolProvider,
  ) {}

  async ensureSchema(): Promise<void> {
    const pool = this.requirePool();
    const dims =
      Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10) ||
      DEFAULT_EMBEDDING_DIMENSIONS;
    await pool.query(buildRagMigrationSql(dims));
  }

  async listTopics(): Promise<KnowledgeTopic[]> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{
      id: string;
      title: string;
      category: string;
      chunk_count: string;
    }>(`
      SELECT
        d.id,
        d.title,
        d.category,
        count(c.id)::text AS chunk_count
      FROM knowledge_documents d
      LEFT JOIN knowledge_chunks c ON c.document_id = d.id
      GROUP BY d.id, d.title, d.category
      ORDER BY d.id ASC
    `);

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      chunkCount: Number.parseInt(row.chunk_count, 10) || 0,
    }));
  }

  async hybridSearch(input: HybridSearchPortInput): Promise<KnowledgeSearchHit[]> {
    const pool = this.requirePool();
    const lexicalQuery = buildWebsearchOrQuery(input.queryText, input.keywords);
    const hasEmbedding = Array.isArray(input.queryEmbedding) && input.queryEmbedding.length > 0;
    const categoryFilter = input.category && input.category !== 'all' ? input.category : null;

    if (!hasEmbedding && !lexicalQuery) {
      return [];
    }

    const vectorSqlLiteral = hasEmbedding ? toSql(input.queryEmbedding as number[]) : null;

    const sql = `
      WITH
      semantic AS (
        SELECT
          c.id,
          (1.0 - (c.embedding <=> $1::vector))::double precision AS semantic_similarity,
          ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1::vector ASC) AS sem_rank
        FROM knowledge_chunks c
        JOIN knowledge_documents d ON d.id = c.document_id
        WHERE $1::vector IS NOT NULL
          AND ($3::text IS NULL OR d.category = $3 OR c.metadata->>'category' = $3)
        ORDER BY c.embedding <=> $1::vector ASC
        LIMIT $4
      ),
      lexical_terms AS (
        SELECT
          CASE WHEN $2::text <> '' THEN websearch_to_tsquery('simple', $2) ELSE NULL END AS tsq_simple,
          CASE WHEN $2::text <> '' THEN websearch_to_tsquery('english', $2) ELSE NULL END AS tsq_english
      ),
      lexical AS (
        SELECT
          c.id,
          (
            coalesce(ts_rank_cd(c.search_tsv, lt.tsq_simple, 32), 0.0) * 1.2 +
            coalesce(ts_rank_cd(c.search_tsv, lt.tsq_english, 32), 0.0) * 0.8
          )::double precision AS lexical_score,
          ROW_NUMBER() OVER (
            ORDER BY (
              coalesce(ts_rank_cd(c.search_tsv, lt.tsq_simple, 32), 0.0) * 1.2 +
              coalesce(ts_rank_cd(c.search_tsv, lt.tsq_english, 32), 0.0) * 0.8
            ) DESC
          ) AS lex_rank
        FROM knowledge_chunks c
        JOIN knowledge_documents d ON d.id = c.document_id
        CROSS JOIN lexical_terms lt
        WHERE $2::text <> ''
          AND ($3::text IS NULL OR d.category = $3 OR c.metadata->>'category' = $3)
          AND (
            (lt.tsq_simple IS NOT NULL AND c.search_tsv @@ lt.tsq_simple) OR
            (lt.tsq_english IS NOT NULL AND c.search_tsv @@ lt.tsq_english)
          )
        ORDER BY lexical_score DESC
        LIMIT $4
      ),
      fused AS (
        SELECT
          coalesce(s.id, l.id) AS id,
          s.id IS NOT NULL AS has_sem,
          l.id IS NOT NULL AS has_lex,
          coalesce(s.semantic_similarity, 0.0)::double precision AS semantic_similarity,
          coalesce(l.lexical_score, 0.0)::double precision AS lexical_score,
          (
            coalesce(0.65 / (60.0 + s.sem_rank), 0.0) +
            coalesce(0.35 / (60.0 + l.lex_rank), 0.0)
          )::double precision AS rrf_score
        FROM semantic s
        FULL OUTER JOIN lexical l ON s.id = l.id
      )
      SELECT
        c.id,
        c.document_id,
        d.title AS document_title,
        c.section_id,
        c.section_title,
        c.contextual_header,
        coalesce(c.metadata->>'category', d.category) AS category,
        c.content,
        c.tags,
        f.semantic_similarity,
        f.lexical_score,
        f.rrf_score,
        CASE
          WHEN f.has_sem AND f.has_lex THEN 'hybrid'
          WHEN f.has_sem THEN 'semantic'
          ELSE 'lexical'
        END AS matched_via
      FROM fused f
      JOIN knowledge_chunks c ON c.id = f.id
      JOIN knowledge_documents d ON d.id = c.document_id
      WHERE (f.semantic_similarity >= $5 OR f.has_lex)
      ORDER BY f.rrf_score DESC, f.semantic_similarity DESC, f.lexical_score DESC
      LIMIT $6
    `;

    const { rows } = await pool.query<{
      id: string;
      document_id: string;
      document_title: string;
      section_id: string;
      section_title: string;
      contextual_header: string;
      category: string;
      content: string;
      tags: string[];
      semantic_similarity: number;
      lexical_score: number;
      rrf_score: number;
      matched_via: 'hybrid' | 'semantic' | 'lexical';
    }>(sql, [
      vectorSqlLiteral,
      lexicalQuery,
      categoryFilter,
      input.candidatePool,
      input.minSemanticSimilarity,
      input.limit,
    ]);

    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      documentTitle: row.document_title,
      sectionId: row.section_id,
      sectionTitle: row.section_title,
      contextualHeader: row.contextual_header,
      category: row.category,
      content: row.content,
      tags: Array.isArray(row.tags) ? row.tags : [],
      semanticSimilarity: Number(row.semantic_similarity.toFixed(4)),
      lexicalScore: Number(row.lexical_score.toFixed(4)),
      rrfScore: Number(row.rrf_score.toFixed(6)),
      matchedVia: row.matched_via,
    }));
  }

  async getHealthStatus(): Promise<{
    backend: 'postgres-pgvector';
    connected: boolean;
    documentCount: number;
    chunkCount: number;
  }> {
    const pool = this.poolProvider.getPool();
    if (!pool) {
      return {
        backend: 'postgres-pgvector',
        connected: false,
        documentCount: 0,
        chunkCount: 0,
      };
    }

    try {
      const { rows } = await pool.query<{ docs: string; chunks: string }>(`
        SELECT
          (SELECT count(*)::text FROM knowledge_documents) AS docs,
          (SELECT count(*)::text FROM knowledge_chunks) AS chunks
      `);
      return {
        backend: 'postgres-pgvector',
        connected: true,
        documentCount: Number.parseInt(rows[0]?.docs || '0', 10) || 0,
        chunkCount: Number.parseInt(rows[0]?.chunks || '0', 10) || 0,
      };
    } catch (err) {
      this.logger.warn(
        `Database health check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        backend: 'postgres-pgvector',
        connected: false,
        documentCount: 0,
        chunkCount: 0,
      };
    }
  }

  async recordSearchLog(entry: {
    queryText: string;
    keywords: string[];
    category?: string;
    searchMode: string;
    matchedChunkIds: string[];
    topRrfScore: number | null;
    latencyMs: number;
  }): Promise<void> {
    const pool = this.poolProvider.getPool();
    if (!pool) return;

    try {
      await pool.query(
        `
        INSERT INTO rag_query_logs
          (query_text, keywords, category, search_mode, matched_chunk_ids, top_rrf_score, latency_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [
          entry.queryText.slice(0, 500),
          entry.keywords.slice(0, 15),
          entry.category ?? null,
          entry.searchMode,
          entry.matchedChunkIds,
          entry.topRrfScore,
          entry.latencyMs,
        ],
      );
    } catch (err) {
      this.logger.debug(
        `Skipped rag_query_logs write: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async getStoredDocumentHash(
    documentId: string,
  ): Promise<{ contentHash: string; chunkCount: number } | null> {
    const pool = this.requirePool();
    const { rows } = await pool.query<{ content_hash: string; chunk_count: string }>(
      `
      SELECT d.content_hash, count(c.id)::text AS chunk_count
      FROM knowledge_documents d
      LEFT JOIN knowledge_chunks c ON c.document_id = d.id
      WHERE d.id = $1
      GROUP BY d.id, d.content_hash
      `,
      [documentId],
    );
    if (rows.length === 0) return null;
    return {
      contentHash: rows[0].content_hash,
      chunkCount: Number.parseInt(rows[0].chunk_count, 10) || 0,
    };
  }

  async upsertDocumentWithChunks(
    document: Omit<KnowledgeDocumentDraft, 'chunks'>,
    chunks: KnowledgeChunkWithEmbedding[],
    options: { force?: boolean } = {},
  ): Promise<UpsertDocumentResult> {
    const pool = this.requirePool();

    if (!options.force) {
      const existing = await this.getStoredDocumentHash(document.id);
      if (existing && existing.contentHash === document.contentHash && existing.chunkCount === chunks.length) {
        return {
          documentId: document.id,
          action: 'skipped-unchanged',
          chunkCount: existing.chunkCount,
        };
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `
        INSERT INTO knowledge_documents (id, source_path, title, category, content_hash, metadata, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET
          source_path = EXCLUDED.source_path,
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          content_hash = EXCLUDED.content_hash,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        `,
        [
          document.id,
          document.sourcePath,
          document.title,
          document.category,
          document.contentHash,
          JSON.stringify(document.metadata),
        ],
      );

      await client.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [document.id]);

      for (const chunk of chunks) {
        await client.query(
          `
          INSERT INTO knowledge_chunks (
            id, document_id, chunk_index, section_id, section_title, contextual_header,
            content, embedded_text, tags, token_estimate, content_hash, embedding, metadata, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, $13::jsonb, now())
          `,
          [
            chunk.id,
            chunk.documentId,
            chunk.chunkIndex,
            chunk.sectionId,
            chunk.sectionTitle,
            chunk.contextualHeader,
            chunk.content,
            chunk.embeddedText,
            chunk.tags,
            chunk.tokenEstimate,
            chunk.contentHash,
            toSql(chunk.embedding),
            JSON.stringify(chunk.metadata),
          ],
        );
      }

      await client.query('COMMIT');
      return {
        documentId: document.id,
        action: 'upserted',
        chunkCount: chunks.length,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteStaleDocuments(activeDocumentIds: string[]): Promise<string[]> {
    const pool = this.requirePool();
    if (activeDocumentIds.length === 0) {
      const { rows } = await pool.query<{ id: string }>(
        'DELETE FROM knowledge_documents RETURNING id',
      );
      return rows.map((r) => r.id);
    }

    const { rows } = await pool.query<{ id: string }>(
      'DELETE FROM knowledge_documents WHERE NOT (id = ANY($1::text[])) RETURNING id',
      [activeDocumentIds],
    );
    return rows.map((r) => r.id);
  }

  private requirePool() {
    const pool = this.poolProvider.getPool();
    if (!pool) {
      throw new Error('DATABASE_URL is not configured for PgVectorKnowledgeRepository.');
    }
    return pool;
  }
}
