import { AiService } from '@nestjs/ai';
import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { KnowledgeRepositoryService } from '../domain/knowledge-repository.service.js';
import {
  inspectAndSandboxUserMessage,
  sanitizeModelOutput,
} from '../infrastructure/security/prompt-injection.guard.js';
import { PortfolioToolsProvider } from './portfolio-tools.provider.js';

export interface ExecutedToolBadge {
  toolName: string;
  argsSummary: string;
  durationMs: number;
}

export interface AgentChatRequestDto {
  message: string;
}

export interface AgentChatResponseDto {
  ok: true;
  reply: string;
  executedTools: ExecutedToolBadge[];
  meta: {
    model: string;
    provider: string;
    gatewayRouted: boolean;
    cached: boolean;
  };
}

interface CacheEntry {
  response: AgentChatResponseDto;
  expiresAt: number;
}

const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 120;

@Injectable()
export class PortfolioAgentService {
  private readonly responseCache = new Map<string, CacheEntry>();

  constructor(
    @Inject(AiService)
    private readonly aiService: AiService,
    @Inject(KnowledgeRepositoryService)
    private readonly knowledgeRepo: KnowledgeRepositoryService,
  ) {}

  async chat(dto: AgentChatRequestDto): Promise<AgentChatResponseDto> {
    const inspection = inspectAndSandboxUserMessage(dto.message);

    if (!inspection.safe) {
      throw new BadRequestException({
        ok: false,
        code: inspection.reason,
        message:
          inspection.reason === 'PROMPT_INJECTION_DETECTED'
            ? 'Request rejected by the Prompt Injection security guardrail.'
            : 'Message must be between 2 and 2,200 characters.',
      });
    }

    const cacheKey = inspection.sanitizedMessage.toLowerCase();
    const cached = this.responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...cached.response,
        meta: { ...cached.response.meta, cached: true },
      };
    }

    const startMs = Date.now();
    try {
      const result = await this.aiService.generateText({
        instructions: this.knowledgeRepo.getSystemInstructions(),
        prompt: inspection.sandboxedPrompt,
        tools: [PortfolioToolsProvider],
        maxSteps: 3,
        maxOutputTokens: 280,
        budget: { maxTokens: 2500 },
      });

      const elapsedMs = Math.max(2, Date.now() - startMs);
      const toolCalls = result.toolCalls || [];
      const executedTools: ExecutedToolBadge[] = toolCalls.map((tc) => ({
        toolName: tc.toolName,
        argsSummary: this.summarizeToolInput(tc.input),
        durationMs: Math.max(2, Math.round(elapsedMs / Math.max(1, toolCalls.length))),
      }));

      const responsePayload: AgentChatResponseDto = {
        ok: true,
        reply: sanitizeModelOutput(result.text || ''),
        executedTools,
        meta: {
          model: result.model?.modelId || 'gemini-2.5-flash',
          provider: result.model?.provider || '@nestjs/ai',
          gatewayRouted: Boolean(
            process.env.CLOUDFLARE_AI_GATEWAY_GOOGLE_URL ||
              process.env.CLOUDFLARE_AI_GATEWAY_GROQ_URL ||
              process.env.AI_GATEWAY_MODEL,
          ),
          cached: false,
        },
      };

      this.saveToCache(cacheKey, responsePayload);
      return responsePayload;
    } catch (err) {
      console.error('[PortfolioAgentService] generateText error:', err);
      throw new ServiceUnavailableException({
        ok: false,
        code: 'AI_PROVIDER_UNAVAILABLE',
        message: 'AI provider temporarily unavailable.',
      });
    }
  }

  clearCacheForTests(): void {
    this.responseCache.clear();
  }

  private summarizeToolInput(input: unknown): string {
    if (!input || typeof input !== 'object') return '';
    return Object.entries(input as Record<string, unknown>)
      .slice(0, 2)
      .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 32)}`)
      .join(', ');
  }

  private saveToCache(key: string, response: AgentChatResponseDto): void {
    if (this.responseCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.responseCache.keys().next().value;
      if (oldestKey) this.responseCache.delete(oldestKey);
    }
    this.responseCache.set(key, {
      response,
      expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
    });
  }
}
