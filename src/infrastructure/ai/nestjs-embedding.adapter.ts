import { AiService } from '@nestjs/ai';
import { Inject, Injectable } from '@nestjs/common';
import type { EmbeddingPort } from '../../domain/knowledge/knowledge.ports.js';
import { DEFAULT_EMBEDDING_DIMENSIONS } from '../database/rag-schema.js';

@Injectable()
export class NestJsEmbeddingAdapter implements EmbeddingPort {
  readonly modelId: string;
  readonly dimensions: number;

  constructor(
    @Inject(AiService)
    private readonly aiService: AiService,
  ) {
    this.modelId = process.env.EMBEDDING_MODEL_ID?.trim() || 'gemini-embedding-001';
    this.dimensions =
      Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10) ||
      DEFAULT_EMBEDDING_DIMENSIONS;
  }

  async embedQuery(text: string): Promise<number[]> {
    const result = await this.aiService.embed({
      value: text,
      label: 'rag:query-embedding',
      providerOptions: {
        google: {
          outputDimensionality: this.dimensions,
          taskType: 'RETRIEVAL_QUERY',
        },
      },
    });
    return result.embedding;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const result = await this.aiService.embedMany({
      values: texts,
      label: 'rag:document-ingestion',
      providerOptions: {
        google: {
          outputDimensionality: this.dimensions,
          taskType: 'RETRIEVAL_DOCUMENT',
        },
      },
    });
    return result.embeddings;
  }
}
