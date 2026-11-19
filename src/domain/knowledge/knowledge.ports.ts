import type {
  KnowledgeChunkWithEmbedding,
  KnowledgeDocumentDraft,
  KnowledgeHealthStatus,
  KnowledgeSearchHit,
  KnowledgeTopic,
  UpsertDocumentResult,
} from './knowledge.types.js';

export const KNOWLEDGE_SEARCH_PORT = Symbol('KNOWLEDGE_SEARCH_PORT');
export const KNOWLEDGE_INGESTION_PORT = Symbol('KNOWLEDGE_INGESTION_PORT');
export const EMBEDDING_PORT = Symbol('EMBEDDING_PORT');

export interface HybridSearchPortInput {
  queryText: string;
  keywords: string[];
  queryEmbedding: number[] | null;
  category?: string;
  limit: number;
  candidatePool: number;
  minSemanticSimilarity: number;
}

export interface KnowledgeSearchPort {
  readonly backend: 'postgres-pgvector' | 'in-memory-fallback';
  listTopics(): Promise<KnowledgeTopic[]>;
  hybridSearch(input: HybridSearchPortInput): Promise<KnowledgeSearchHit[]>;
  getHealthStatus(): Promise<Omit<KnowledgeHealthStatus, 'embeddingModel' | 'embeddingDimensions'>>;
  recordSearchLog?(entry: {
    queryText: string;
    keywords: string[];
    category?: string;
    searchMode: string;
    matchedChunkIds: string[];
    topRrfScore: number | null;
    latencyMs: number;
  }): Promise<void>;
}

export interface KnowledgeIngestionPort {
  ensureSchema(): Promise<void>;
  getStoredDocumentHash(documentId: string): Promise<{ contentHash: string; chunkCount: number } | null>;
  upsertDocumentWithChunks(
    document: Omit<KnowledgeDocumentDraft, 'chunks'>,
    chunks: KnowledgeChunkWithEmbedding[],
    options?: { force?: boolean },
  ): Promise<UpsertDocumentResult>;
  deleteStaleDocuments(activeDocumentIds: string[]): Promise<string[]>;
}

export interface EmbeddingPort {
  readonly modelId: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}
