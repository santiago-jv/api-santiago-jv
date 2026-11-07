import fs from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';

export interface KnowledgeSection {
  id: string;
  title: string;
  content: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class KnowledgeRepositoryService {
  private cachedSections: KnowledgeSection[] = [];
  private cacheExpiresAt = 0;

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

  async listTopics(): Promise<Array<{ id: string; title: string }>> {
    const sections = await this.loadSections();
    return sections.map(({ id, title }) => ({ id, title }));
  }

  async getSectionsByTopics(topics: string[]): Promise<KnowledgeSection[]> {
    const sections = await this.loadSections();
    if (sections.length === 0 || topics.length === 0) {
      return sections;
    }

    const normalized = topics.map((t) => t.toLowerCase().trim()).filter(Boolean);
    const matched = sections.filter((section) => {
      const haystack = `${section.id} ${section.title} ${section.content}`.toLowerCase();
      return normalized.some((term) => haystack.includes(term));
    });

    return matched.length > 0 ? matched : sections;
  }

  private async loadSections(): Promise<KnowledgeSection[]> {
    const now = Date.now();
    if (this.cachedSections.length > 0 && now < this.cacheExpiresAt) {
      return this.cachedSections;
    }

    const rawMarkdown = await this.resolveMarkdownSource();
    this.cachedSections = this.parseMarkdownSections(rawMarkdown);
    this.cacheExpiresAt = now + CACHE_TTL_MS;
    return this.cachedSections;
  }

  private async resolveMarkdownSource(): Promise<string> {
    const fromB64 = process.env.KNOWLEDGE_BASE_MD_B64?.trim();
    if (fromB64) {
      return Buffer.from(fromB64, 'base64').toString('utf8');
    }

    const fromPlain = process.env.KNOWLEDGE_BASE_MD?.trim();
    if (fromPlain) {
      return fromPlain;
    }

    const remoteUrl = process.env.KNOWLEDGE_BASE_URL?.trim();
    if (remoteUrl) {
      const headers: Record<string, string> = { Accept: 'text/plain, text/markdown' };
      const token = process.env.KNOWLEDGE_BASE_BEARER_TOKEN?.trim();
      if (token) headers.Authorization = `Bearer ${token}`;

      const response = await fetch(remoteUrl, { headers });
      return response.ok ? response.text() : '';
    }

    const localPath = path.resolve(process.cwd(), '.private/knowledge-base.md');
    return fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '';
  }

  private parseMarkdownSections(markdown: string): KnowledgeSection[] {
    if (!markdown.trim()) return [];

    return markdown
      .split(/^#\s+/m)
      .filter((chunk) => chunk.trim().length > 0)
      .map((chunk, index) => {
        const [firstLine = `Section ${index + 1}`, ...rest] = chunk.split('\n');
        const title = firstLine.trim();
        const id =
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || `section-${index + 1}`;

        return {
          id,
          title,
          content: rest.join('\n').trim(),
        };
      });
  }
}
