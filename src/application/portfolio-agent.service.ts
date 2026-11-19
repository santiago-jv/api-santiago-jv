import crypto from 'node:crypto';
import { AiService } from '@nestjs/ai';
import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { KnowledgeRepositoryService } from '../domain/knowledge-repository.service.js';
import {
  type ConversationTurn,
  inspectAndSandboxUserMessage,
  sanitizeModelOutput,
  stripInvisibleAndControlChars,
} from '../infrastructure/security/prompt-injection.guard.js';
import { PortfolioToolsProvider } from './portfolio-tools.provider.js';

export interface ExecutedToolBadge {
  toolName: string;
  argsSummary: string;
  durationMs: number;
}

export interface AgentChatRequestDto {
  message: string;
  history?: ConversationTurn[];
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

  async chat(dto: AgentChatRequestDto | null | undefined): Promise<AgentChatResponseDto> {
    const rawMessage = dto && typeof dto === 'object' ? dto.message : undefined;
    const rawHistory = dto && typeof dto === 'object' ? dto.history : undefined;
    const inspection = inspectAndSandboxUserMessage(rawMessage, rawHistory);

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

    const historyContextKey = Array.isArray(rawHistory)
      ? rawHistory
          .slice(-2)
          .map((t) => stripInvisibleAndControlChars(String(t?.content || '')).slice(0, 80).toLowerCase())
          .filter(Boolean)
          .join('|')
      : '';
    const cacheKey = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          msg: inspection.sanitizedMessage.toLowerCase(),
          history: inspection.sandboxedMessages.slice(0, -1),
        }),
      )
      .digest('hex');

    const cached = this.responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        ...cached.response,
        meta: { ...cached.response.meta, cached: true },
      };
    }

    const startMs = Date.now();
    try {
      const instructions = this.knowledgeRepo.getSystemInstructions();
      const executedTools: ExecutedToolBadge[] = [];
      let finalReply = '';
      let usedModelId = 'gemini-2.5-flash';
      let usedProvider = '@nestjs/ai';

      try {
        const result = await this.aiService.generateText({
          instructions,
          messages: inspection.sandboxedMessages,
          tools: [PortfolioToolsProvider],
          maxSteps: 4,
          maxOutputTokens: 900,
          budget: { maxTokens: 5500 },
        });

        const elapsedMs = Math.max(2, Date.now() - startMs);
        const toolCalls = result.toolCalls || [];
        for (const tc of toolCalls) {
          executedTools.push({
            toolName: tc.toolName,
            argsSummary: this.summarizeToolInput(tc.input),
            durationMs: Math.max(2, Math.round(elapsedMs / Math.max(1, toolCalls.length))),
          });
        }

        finalReply = sanitizeModelOutput(result.text || '');
        usedModelId = result.model?.modelId || usedModelId;
        usedProvider = result.model?.provider || usedProvider;
      } catch (toolStepErr) {
        console.warn(
          '[PortfolioAgentService] primary tool-calling step failed; falling back to direct RAG synthesis:',
          toolStepErr instanceof Error ? toolStepErr.message : String(toolStepErr),
        );
      }

      if (!finalReply) {
        const ragStartMs = Date.now();
        const searchQuery = historyContextKey
          ? `${historyContextKey} ${inspection.sanitizedMessage}`
          : inspection.sanitizedMessage;
        const { hits } = await this.knowledgeRepo.searchKnowledge({
          query: searchQuery,
          limit: 6,
        });
        const ragDurationMs = Math.max(2, Date.now() - ragStartMs);
        const contextBlock = hits
          .map(
            (hit) =>
              `## ${hit.contextualHeader} (score=${hit.rrfScore}, via=${hit.matchedVia})\n${hit.content}`,
          )
          .join('\n\n');

        const synthesisPrompt = `<knowledge_context>\n${contextBlock}\n</knowledge_context>\n\n${inspection.sandboxedPrompt}`;
        let synthesis;
        try {
          synthesis = await this.aiService.generateText({
            instructions,
            prompt: synthesisPrompt,
            maxOutputTokens: 900,
            budget: { maxTokens: 5500 },
          });
        } catch {
          synthesis = await this.aiService.generateText({
            model: 'gemini-fallback',
            instructions,
            prompt: synthesisPrompt,
            maxOutputTokens: 900,
            budget: { maxTokens: 5500 },
          });
        }

        finalReply = sanitizeModelOutput(synthesis.text || '');
        usedModelId = synthesis.model?.modelId || usedModelId;
        usedProvider = synthesis.model?.provider || usedProvider;

        if (executedTools.length === 0) {
          executedTools.push({
            toolName: 'query_knowledge_base',
            argsSummary: `query=${JSON.stringify(inspection.sanitizedMessage.slice(0, 32))}`,
            durationMs: ragDurationMs,
          });
        }
      }

      if (!finalReply) {
        throw new Error('Model returned an empty response after synthesis.');
      }

      const responsePayload: AgentChatResponseDto = {
        ok: true,
        reply: finalReply,
        executedTools,
        meta: {
          model: usedModelId,
          provider: usedProvider,
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
