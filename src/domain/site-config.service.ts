import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PostgresPoolProvider } from '../infrastructure/database/postgres-pool.provider.js';
import { SITE_CONFIG_MIGRATION_SQL } from '../infrastructure/database/rag-schema.js';

export interface PublicSiteConfig {
  domains: {
    primaryDomain: string;
    portfolioUrl: string;
    aiConsoleUrl: string;
    apiUrl: string;
    mcpUrl: string;
    mcpDocsUrl: string;
    allowedOrigins: string[];
  };
  social: {
    contactEmail: string;
    xHandle: string;
    xUrl: string;
    linkedinHandle: string;
    linkedinUrl: string;
    githubHandle: string;
    githubUrl: string;
    mediumHandle: string;
    mediumUrl: string;
  };
  career: {
    resumeEnUrl: string;
    resumeEsUrl: string;
    availabilityStatus: string;
    workModalitiesEn: string;
    workModalitiesEs: string;
    locationEn: string;
    locationEs: string;
  };
}

const DEFAULT_PRIMARY_DOMAIN = 'santiago-jv.tech';

export const DEFAULT_SITE_CONFIG_MAP: Readonly<Record<string, string>> = {
  primary_domain: DEFAULT_PRIMARY_DOMAIN,
  portfolio_url: 'https://www.santiago-jv.tech',
  ai_console_url: 'https://ai.santiago-jv.tech',
  api_url: 'https://api.santiago-jv.tech',
  mcp_url: 'https://mcp.santiago-jv.tech/mcp',
  mcp_docs_url: 'https://mcp.santiago-jv.tech/docs',
  allowed_origins:
    'https://ai.santiago-jv.tech,https://www.santiago-jv.tech,https://santiago-jv.tech',
  contact_email: 'contact@santiago-jv.tech',
  x_handle: '@santiagojvtech',
  x_url: 'https://x.com/santiagojvtech',
  linkedin_handle: '/in/santiago-jv',
  linkedin_url: 'https://www.linkedin.com/in/santiago-jv',
  github_handle: '@santiago-jv',
  github_url: 'https://github.com/santiago-jv',
  medium_handle: '@santiago-jv',
  medium_url: 'https://medium.com/@santiago-jv/',
  resume_en_url: 'https://www.santiago-jv.tech/Santiago_Olayo_Villamil_CV_EN.pdf',
  resume_es_url: 'https://www.santiago-jv.tech/Santiago_Olayo_Villamil_CV_ES.pdf',
  availability_status: 'open',
  work_modalities_en:
    '100% Remote (Global, US, LatAm, Colombia) or Hybrid / On-site in Barranquilla and Santa Marta, Colombia',
  work_modalities_es:
    '100% Remoto (Global, EE. UU., LatAm, Colombia) o Híbrido / Presencial en Barranquilla y Santa Marta, Colombia',
  location_en: 'Barranquilla / Santa Marta, Colombia (UTC-5)',
  location_es: 'Barranquilla / Santa Marta, Colombia (UTC-5)',
};

const CACHE_TTL_MS = 60_000;

function applyPrimaryDomainCascade(value: string, defaultVal: string, primaryDomain: string): string {
  if (!primaryDomain || primaryDomain === DEFAULT_PRIMARY_DOMAIN) {
    return value;
  }
  // If the specific URL/email row is still at its original santiago-jv.tech default, cascade the new primary_domain
  if (value === defaultVal && value.includes(DEFAULT_PRIMARY_DOMAIN)) {
    return value.replaceAll(DEFAULT_PRIMARY_DOMAIN, primaryDomain);
  }
  return value;
}

export function buildPublicSiteConfigFromMap(rawMap: Record<string, string>): PublicSiteConfig {
  const get = (key: string): string => {
    const val = rawMap[key]?.trim();
    return val && val.length > 0 ? val : (DEFAULT_SITE_CONFIG_MAP[key] ?? '');
  };

  const primaryDomain = get('primary_domain').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const cascade = (key: string): string =>
    applyPrimaryDomainCascade(get(key), DEFAULT_SITE_CONFIG_MAP[key] ?? '', primaryDomain);

  const portfolioUrl = cascade('portfolio_url').replace(/\/+$/, '');
  const aiConsoleUrl = cascade('ai_console_url').replace(/\/+$/, '');
  const apiUrl = cascade('api_url').replace(/\/+$/, '');
  const mcpUrl = cascade('mcp_url');
  const mcpDocsUrl = cascade('mcp_docs_url');

  const rawAllowed = cascade('allowed_origins')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const allowedSet = new Set<string>([
    ...rawAllowed,
    portfolioUrl,
    aiConsoleUrl,
    `https://${primaryDomain}`,
    `https://www.${primaryDomain}`,
    `https://ai.${primaryDomain}`,
  ]);

  const xRawHandle = get('x_handle');
  const xHandle = xRawHandle.startsWith('@') ? xRawHandle : `@${xRawHandle}`;
  const xCleanUser = xHandle.replace(/^@/, '');
  const xUrl =
    rawMap.x_url && rawMap.x_url.trim() !== DEFAULT_SITE_CONFIG_MAP.x_url
      ? rawMap.x_url.trim()
      : `https://x.com/${xCleanUser}`;

  return {
    domains: {
      primaryDomain,
      portfolioUrl,
      aiConsoleUrl,
      apiUrl,
      mcpUrl,
      mcpDocsUrl,
      allowedOrigins: [...allowedSet],
    },
    social: {
      contactEmail: cascade('contact_email'),
      xHandle,
      xUrl,
      linkedinHandle: get('linkedin_handle'),
      linkedinUrl: get('linkedin_url'),
      githubHandle: get('github_handle'),
      githubUrl: get('github_url'),
      mediumHandle: get('medium_handle'),
      mediumUrl: get('medium_url'),
    },
    career: {
      resumeEnUrl: cascade('resume_en_url'),
      resumeEsUrl: cascade('resume_es_url'),
      availabilityStatus: get('availability_status'),
      workModalitiesEn: get('work_modalities_en'),
      workModalitiesEs: get('work_modalities_es'),
      locationEn: get('location_en'),
      locationEs: get('location_es'),
    },
  };
}

@Injectable()
export class SiteConfigService {
  private readonly logger = new Logger(SiteConfigService.name);
  private schemaEnsured = false;
  private cached: {
    config: PublicSiteConfig;
    updatedAt: string;
    source: 'neon-postgres' | 'default-fallback';
    expiresAt: number;
  } | null = null;

  constructor(
    @Optional()
    @Inject(PostgresPoolProvider)
    private readonly poolProvider?: PostgresPoolProvider,
  ) {}

  async getPublicConfigResponse(): Promise<{
    ok: true;
    source: 'neon-postgres' | 'default-fallback';
    updatedAt: string;
    config: PublicSiteConfig;
  }> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return {
        ok: true,
        source: this.cached.source,
        updatedAt: this.cached.updatedAt,
        config: this.cached.config,
      };
    }

    const pool = this.poolProvider?.getPool();
    if (!pool) {
      const fallback = buildPublicSiteConfigFromMap({});
      const updatedAt = new Date().toISOString();
      this.cached = {
        config: fallback,
        updatedAt,
        source: 'default-fallback',
        expiresAt: now + CACHE_TTL_MS,
      };
      return {
        ok: true,
        source: 'default-fallback',
        updatedAt,
        config: fallback,
      };
    }

    try {
      if (!this.schemaEnsured) {
        await pool.query(SITE_CONFIG_MIGRATION_SQL);
        this.schemaEnsured = true;
      }

      const result = await pool.query<{ key: string; value: string; updated_at: Date }>(
        'SELECT key, value, updated_at FROM site_config ORDER BY key ASC',
      );

      const map: Record<string, string> = {};
      let latestDate = new Date(0);
      for (const row of result.rows) {
        map[row.key] = row.value;
        if (row.updated_at && row.updated_at > latestDate) {
          latestDate = row.updated_at;
        }
      }

      const config = buildPublicSiteConfigFromMap(map);
      const updatedAt =
        latestDate.getTime() > 0 ? latestDate.toISOString() : new Date().toISOString();

      this.cached = {
        config,
        updatedAt,
        source: 'neon-postgres',
        expiresAt: now + CACHE_TTL_MS,
      };

      return {
        ok: true,
        source: 'neon-postgres',
        updatedAt,
        config,
      };
    } catch (err) {
      this.logger.warn(
        `Falling back to default site config due to DB error: ${err instanceof Error ? err.message : String(err)}`,
      );
      const fallback = buildPublicSiteConfigFromMap({});
      const updatedAt = new Date().toISOString();
      return {
        ok: true,
        source: 'default-fallback',
        updatedAt,
        config: fallback,
      };
    }
  }

  async getPublicConfig(): Promise<PublicSiteConfig> {
    const res = await this.getPublicConfigResponse();
    return res.config;
  }

  formatSystemPromptOverrideBlock(config: PublicSiteConfig): string {
    return [
      'LIVE REMOTE CONFIG OVERRIDES (These live database values always take precedence over any older URLs, emails, or handles in retrieved chunks):',
      `- Contact Email: ${config.social.contactEmail}`,
      `- X (Twitter): ${config.social.xHandle} (${config.social.xUrl})`,
      `- LinkedIn: ${config.social.linkedinUrl}`,
      `- GitHub: ${config.social.githubUrl}`,
      `- Medium: ${config.social.mediumUrl}`,
      `- Portfolio URL: ${config.domains.portfolioUrl}`,
      `- AI Console URL: ${config.domains.aiConsoleUrl}`,
      `- Public MCP Endpoint: ${config.domains.mcpUrl} (Docs: ${config.domains.mcpDocsUrl})`,
      `- English Resume (PDF): ${config.career.resumeEnUrl}`,
      `- Spanish Resume (PDF): ${config.career.resumeEsUrl}`,
      `- Availability & Work Modalities: ${config.career.availabilityStatus} · ${config.career.workModalitiesEn}`,
    ].join('\n');
  }

  clearCacheForTests(): void {
    this.cached = null;
  }
}
