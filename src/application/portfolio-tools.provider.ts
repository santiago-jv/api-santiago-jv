import { AgentFunction } from '@nestjs/ai';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { KnowledgeRepositoryService } from '../domain/knowledge-repository.service.js';

export const QueryKnowledgeSchema = z.object({
  topics: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(20)
    .describe(
      'Up to 5 concise English or Spanish topic keywords or section IDs (e.g. ["experience", "payments", "architecture", "stack"]).',
    ),
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
    description: 'Lists all available section IDs and headings in the knowledge base.',
    inputSchema: ListTopicsSchema,
  })
  async listKnowledgeTopics() {
    const topics = await this.knowledgeRepo.listTopics();
    return { topics };
  }

  @AgentFunction({
    name: 'query_knowledge_base',
    description:
      'Retrieves knowledge base sections matching the requested topics to answer questions or evaluate a job vacancy.',
    inputSchema: QueryKnowledgeSchema,
  })
  async queryKnowledgeBase({ topics }: z.infer<typeof QueryKnowledgeSchema>) {
    const sections = await this.knowledgeRepo.getSectionsByTopics(topics);
    return {
      matchedSectionsCount: sections.length,
      sections,
    };
  }
}
