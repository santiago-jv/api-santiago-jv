import { AgentFunction } from '@nestjs/ai';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { KnowledgeRepositoryService } from '../domain/knowledge-repository.service.js';

export const QueryKnowledgeSchema = z.object({
  query: z
    .string()
    .min(2)
    .max(1000)
    .describe(
      'Natural-language search query describing what to retrieve about Santiago (e.g., "Stripe payment reconciliation and Redis distributed locks at GoodRec" or "backend stack, cloud architecture, and observability").',
    ),
  keywords: z
    .array(z.string().min(1).max(80))
    .max(15)
    .optional()
    .describe(
      'Optional specific technologies, company names, or domain terms to boost exact lexical matching (e.g., ["Stripe", "Nequi", "GoodRec", "Datadog"]).',
    ),
  category: z
    .enum([
      'all',
      'identity',
      'compensation',
      'experience',
      'integrations',
      'architecture',
      'skills',
      'education',
    ])
    .optional()
    .describe('Optional category filter to narrow retrieval scope. Defaults to "all".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe('Number of top ranked chunks to return (default 5; use 6-8 when evaluating full job descriptions).'),
});

export const ListTopicsSchema = z.object({});

@Injectable()
export class PortfolioToolsProvider {
  constructor(
    @Inject(KnowledgeRepositoryService)
    private readonly knowledgeRepo: KnowledgeRepositoryService,
  ) {}

  @AgentFunction({
    name: 'list_knowledge_topics',
    description:
      'Lists all indexed knowledge documents, categories, and chunk counts in the PostgreSQL + pgvector RAG store.',
    inputSchema: ListTopicsSchema,
  })
  async listKnowledgeTopics() {
    const topics = await this.knowledgeRepo.listTopics();
    return { topics };
  }

  @AgentFunction({
    name: 'query_knowledge_base',
    description:
      'Performs hybrid semantic (pgvector) + lexical (PostgreSQL Full-Text Search) RAG retrieval over Santiago Olayo’s experience, architecture blueprints, third-party integrations, skills, and compensation policy.',
    inputSchema: QueryKnowledgeSchema,
  })
  async queryKnowledgeBase({
    query,
    keywords,
    category,
    limit,
  }: z.infer<typeof QueryKnowledgeSchema>) {
    const { hits, mode } = await this.knowledgeRepo.searchKnowledge({
      query,
      keywords,
      category,
      limit,
    });

    return {
      searchMode: mode,
      matchedChunksCount: hits.length,
      chunks: hits.map((hit) => ({
        id: hit.id,
        documentTitle: hit.documentTitle,
        sectionTitle: hit.sectionTitle,
        category: hit.category,
        tags: hit.tags,
        matchedVia: hit.matchedVia,
        rrfScore: hit.rrfScore,
        semanticSimilarity: hit.semanticSimilarity,
        content: hit.content,
      })),
    };
  }
}
