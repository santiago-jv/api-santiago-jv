import fs from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import {
  EMBEDDING_PORT,
  type EmbeddingPort,
  KNOWLEDGE_SEARCH_PORT,
  type KnowledgeSearchPort,
} from './knowledge/knowledge.ports.js';
import type {
  KnowledgeHealthStatus,
  KnowledgeSearchHit,
  KnowledgeSearchQuery,
  KnowledgeSearchResult,
  KnowledgeTopic,
} from './knowledge/knowledge.types.js';
import { DEFAULT_EMBEDDING_DIMENSIONS } from '../infrastructure/database/rag-schema.js';

@Injectable()
export class KnowledgeRepositoryService {
  private readonly logger = new Logger(KnowledgeRepositoryService.name);

  constructor(
    @Optional()
    @Inject(KNOWLEDGE_SEARCH_PORT)
    private readonly searchPort?: KnowledgeSearchPort,
    @Optional()
    @Inject(EMBEDDING_PORT)
    private readonly embeddingPort?: EmbeddingPort,
  ) {}

  getSystemInstructions(): string {
    const fromB64 = process.env.AGENT_SYSTEM_PROMPT_B64?.trim();
    if (fromB64) {
      return Buffer.from(fromB64, 'base64').toString('utf8').trim();
    }

    const fromPlain = process.env.AGENT_SYSTEM_PROMPT?.trim();
    if (fromPlain) {
      return fromPlain;
    }

    const localPath = path.resolve(process.cwd(), '.private/system-prompt.txt');
    return fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8').trim() : '';
  }

  async listTopics(): Promise<KnowledgeTopic[]> {
    if (!this.searchPort) return [];
    return this.searchPort.listTopics();
  }

  async searchKnowledge(params: KnowledgeSearchQuery): Promise<KnowledgeSearchResult> {
    if (!this.searchPort) {
      return { hits: [], mode: 'in-memory' };
    }

    const startedAt = Date.now();
    const cleanQuery = params.query.trim();
    const keywords = (params.keywords ?? [])
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
      .slice(0, 15);
    const limit = Math.min(Math.max(params.limit ?? 5, 1), 8);
    const candidatePool = Number.parseInt(process.env.RAG_CANDIDATE_POOL || '20', 10) || 20;
    const minSemanticSimilarity =
      Number.parseFloat(process.env.RAG_MIN_SEMANTIC_SIMILARITY || '0.32') || 0.32;

    if (this.searchPort.backend === 'in-memory-fallback') {
      let hits = await this.searchPort.hybridSearch({
        queryText: cleanQuery,
        keywords,
        queryEmbedding: null,
        category: params.category,
        limit,
        candidatePool,
        minSemanticSimilarity: 0,
      });
      if (hits.length === 0 && params.category && params.category !== 'all') {
        hits = await this.searchPort.hybridSearch({
          queryText: cleanQuery,
          keywords,
          queryEmbedding: null,
          category: undefined,
          limit,
          candidatePool,
          minSemanticSimilarity: 0,
        });
      }
      return { hits, mode: 'in-memory' };
    }

    let queryEmbedding: number[] | null = null;
    if (this.embeddingPort) {
      const embeddingText =
        keywords.length > 0 ? `${cleanQuery}\nKeywords: ${keywords.join(', ')}` : cleanQuery;
      try {
        queryEmbedding = await this.embeddingPort.embedQuery(embeddingText);
      } catch (err) {
        this.logger.warn(
          `Query embedding failed, degrading gracefully to PostgreSQL FTS: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    let hits = await this.searchPort.hybridSearch({
      queryText: cleanQuery,
      keywords,
      queryEmbedding,
      category: params.category,
      limit,
      candidatePool,
      minSemanticSimilarity,
    });

    // If a strict category filter returned zero hits, broaden to all categories first
    if (hits.length === 0 && params.category && params.category !== 'all') {
      hits = await this.searchPort.hybridSearch({
        queryText: cleanQuery,
        keywords,
        queryEmbedding,
        category: undefined,
        limit,
        candidatePool,
        minSemanticSimilarity,
      });
    }

    if (hits.length === 0 && queryEmbedding) {
      hits = await this.searchPort.hybridSearch({
        queryText: cleanQuery,
        keywords,
        queryEmbedding,
        category: undefined,
        limit: Math.min(3, limit),
        candidatePool,
        minSemanticSimilarity: 0,
      });
    }

    const mode: KnowledgeSearchResult['mode'] = queryEmbedding ? 'hybrid' : 'lexical-fallback';

    if (this.searchPort.recordSearchLog) {
      const logPromise = this.searchPort
        .recordSearchLog({
          queryText: cleanQuery,
          keywords,
          category: params.category,
          searchMode: mode,
          matchedChunkIds: hits.map((h) => h.id),
          topRrfScore: hits[0]?.rrfScore ?? null,
          latencyMs: Math.max(1, Date.now() - startedAt),
        })
        .catch(() => undefined);

      try {
        waitUntil(logPromise);
      } catch {
        void logPromise;
      }
    }

    return { hits, mode };
  }

  async getSectionsByTopics(topics: string[]): Promise<KnowledgeSearchHit[]> {
    const query = topics.join(' ').trim() || 'Santiago Olayo experience and architecture';
    const result = await this.searchKnowledge({
      query,
      keywords: topics,
      limit: 4,
    });
    return result.hits;
  }

  async getHealthStatus(): Promise<KnowledgeHealthStatus> {
    const embeddingModel = this.embeddingPort?.modelId || process.env.EMBEDDING_MODEL_ID || 'gemini-embedding-001';
    const embeddingDimensions =
      this.embeddingPort?.dimensions ||
      Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10) ||
      DEFAULT_EMBEDDING_DIMENSIONS;

    if (!this.searchPort) {
      return {
        backend: 'in-memory-fallback',
        connected: false,
        documentCount: 0,
        chunkCount: 0,
        embeddingModel,
        embeddingDimensions,
      };
    }

    const storageStatus = await this.searchPort.getHealthStatus();
    return {
      ...storageStatus,
      embeddingModel,
      embeddingDimensions,
    };
  }
}
