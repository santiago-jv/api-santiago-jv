export type KnowledgeCategory =
  | 'identity'
  | 'compensation'
  | 'experience'
  | 'integrations'
  | 'architecture'
  | 'skills'
  | 'education'
  | 'general';

export interface KnowledgeChunkDraft {
  id: string;
  documentId: string;
  chunkIndex: number;
  sectionId: string;
  sectionTitle: string;
  contextualHeader: string;
  content: string;
  embeddedText: string;
  tags: string[];
  tokenEstimate: number;
  contentHash: string;
  metadata: Record<string, unknown>;
}

export interface KnowledgeChunkWithEmbedding extends KnowledgeChunkDraft {
  embedding: number[];
}

export interface KnowledgeDocumentDraft {
  id: string;
  sourcePath: string;
  title: string;
  category: KnowledgeCategory;
  contentHash: string;
  metadata: Record<string, unknown>;
  chunks: KnowledgeChunkDraft[];
}

export interface KnowledgeTopic {
  id: string;
  title: string;
  category: KnowledgeCategory | string;
  chunkCount: number;
}

export interface KnowledgeSearchQuery {
  query: string;
  keywords?: string[];
  category?: KnowledgeCategory | 'all';
  limit?: number;
}

export interface KnowledgeSearchHit {
  id: string;
  documentId: string;
  documentTitle: string;
  sectionId: string;
  sectionTitle: string;
  contextualHeader: string;
  category: string;
  content: string;
  tags: string[];
  semanticSimilarity: number;
  lexicalScore: number;
  rrfScore: number;
  matchedVia: 'hybrid' | 'semantic' | 'lexical' | 'fallback';
}

export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[];
  mode: 'hybrid' | 'lexical-fallback' | 'in-memory';
}

export interface KnowledgeHealthStatus {
  backend: 'postgres-pgvector' | 'in-memory-fallback';
  connected: boolean;
  documentCount: number;
  chunkCount: number;
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface UpsertDocumentResult {
  documentId: string;
  action: 'skipped-unchanged' | 'upserted';
  chunkCount: number;
}
