import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  type AgentChatRequestDto,
  type AgentChatResponseDto,
  PortfolioAgentService,
} from '../application/portfolio-agent.service.js';
import { KnowledgeRepositoryService } from '../domain/knowledge-repository.service.js';
import type { KnowledgeHealthStatus } from '../domain/knowledge/knowledge.types.js';
import { SiteConfigService } from '../domain/site-config.service.js';
import { HmacOriginGuard } from '../infrastructure/security/hmac-origin.guard.js';
import { RateLimitGuard } from '../infrastructure/security/rate-limit.guard.js';

const HEALTH_CACHE_TTL_MS = 30_000;

@Controller()
export class AgentController {
  private cachedHealth: { status: KnowledgeHealthStatus; expiresAt: number } | null = null;

  constructor(
    @Inject(PortfolioAgentService)
    private readonly agentService: PortfolioAgentService,
    @Inject(KnowledgeRepositoryService)
    private readonly knowledgeRepo: KnowledgeRepositoryService,
    @Optional()
    @Inject(SiteConfigService)
    private readonly siteConfigService?: SiteConfigService,
  ) {}

  @Get('v1/config/public')
  @UseGuards(RateLimitGuard)
  async getPublicConfig(
    @Res({ passthrough: true }) res?: { setHeader?: (name: string, value: string) => void },
  ) {
    res?.setHeader?.('Access-Control-Allow-Origin', '*');
    res?.setHeader?.(
      'Cache-Control',
      'public, max-age=60, s-maxage=120, stale-while-revalidate=600',
    );
    if (!this.siteConfigService) {
      const fallback = new SiteConfigService();
      return fallback.getPublicConfigResponse();
    }
    return this.siteConfigService.getPublicConfigResponse();
  }

  @Get('health')
  @UseGuards(RateLimitGuard)
  async getHealth() {
    const now = Date.now();
    let rag: KnowledgeHealthStatus;
    if (this.cachedHealth && this.cachedHealth.expiresAt > now) {
      rag = this.cachedHealth.status;
    } else {
      rag = await this.knowledgeRepo.getHealthStatus();
      this.cachedHealth = { status: rag, expiresAt: now + HEALTH_CACHE_TTL_MS };
    }

    const isProd = process.env.NODE_ENV === 'production';
    if (isProd) {
      return {
        status: rag.connected ? 'operational' : 'degraded',
        service: 'api-santiago-jv',
      };
    }

    return {
      status: rag.connected ? 'operational' : 'degraded',
      service: 'api-santiago-jv',
      framework: 'NestJS 12 + @nestjs/ai',
      rag: {
        strategy: 'hybrid-pgvector-fts-rrf',
        ...rag,
      },
      security: {
        hmacServerToServer: true,
        promptInjectionShield: true,
        dualWindowRateLimit: true,
        cloudflareOriginLock: Boolean(process.env.CF_ORIGIN_SECRET),
        aiGatewayReady: Boolean(
          process.env.CLOUDFLARE_AI_GATEWAY_GOOGLE_URL ||
            process.env.CLOUDFLARE_AI_GATEWAY_GROQ_URL ||
            process.env.AI_GATEWAY_MODEL,
        ),
      },
      tools: ['list_knowledge_topics', 'query_knowledge_base'],
    };
  }

  @Post('v1/agent/chat')
  @HttpCode(HttpStatus.OK)
  @UseGuards(HmacOriginGuard, RateLimitGuard)
  async chat(@Body() body: AgentChatRequestDto): Promise<AgentChatResponseDto> {
    return this.agentService.chat(body);
  }
}
