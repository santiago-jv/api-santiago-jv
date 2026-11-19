import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import type {
  HybridSearchPortInput,
  KnowledgeSearchPort,
} from '../../domain/knowledge/knowledge.ports.js';
import { parseKnowledgeMarkdownDocument } from '../../domain/knowledge/markdown-chunker.js';
import type {
  KnowledgeChunkDraft,
  KnowledgeDocumentDraft,
  KnowledgeSearchHit,
  KnowledgeTopic,
} from '../../domain/knowledge/knowledge.types.js';

@Injectable()
export class InMemoryKnowledgeRepository implements KnowledgeSearchPort {
  readonly backend = 'in-memory-fallback' as const;
  private cachedDocs: KnowledgeDocumentDraft[] = [];
  private cacheSignature = '';

  async listTopics(): Promise<KnowledgeTopic[]> {
    const docs = this.loadDocuments();
    return docs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
      chunkCount: doc.chunks.length,
    }));
  }

  async hybridSearch(input: HybridSearchPortInput): Promise<KnowledgeSearchHit[]> {
    const docs = this.loadDocuments();
    const docTitles = new Map(docs.map((d) => [d.id, d.title]));
    const docCategories = new Map(docs.map((d) => [d.id, d.category]));

    const allChunks: KnowledgeChunkDraft[] = docs.flatMap((doc) =>
      doc.chunks.filter((chunk) => {
        if (!input.category || input.category === 'all') return true;
        const cat = String(chunk.metadata?.category || doc.category);
        return cat === input.category;
      }),
    );

    if (allChunks.length === 0) return [];

    const tokens = Array.from(
      new Set(
        [input.queryText, ...input.keywords]
          .join(' ')
          .toLowerCase()
          .split(/[\s,;/|()[\]]+/)
          .map((t) => t.replace(/[^a-z0-9+#.-]/g, '').trim())
          .filter((t) => t.length >= 2),
      ),
    );

    const scored = allChunks.map((chunk) => {
      const headerLower = `${chunk.sectionTitle} ${chunk.contextualHeader} ${chunk.tags.join(' ')}`.toLowerCase();
      const bodyLower = chunk.content.toLowerCase();
      let lexicalScore = 0;
      for (const token of tokens) {
        if (headerLower.includes(token)) lexicalScore += 3;
        else if (bodyLower.includes(token)) lexicalScore += 1;
      }
      return {
        chunk,
        lexicalScore,
      };
    });

    const ranked = scored
      .filter((item) => item.lexicalScore > 0)
      .sort((a, b) => b.lexicalScore - a.lexicalScore);

    const selected = (ranked.length > 0 ? ranked : scored.slice(0, Math.min(2, allChunks.length))).slice(
      0,
      input.limit,
    );

    return selected.map((item, idx) => ({
      id: item.chunk.id,
      documentId: item.chunk.documentId,
      documentTitle: docTitles.get(item.chunk.documentId) || 'Knowledge Base',
      sectionId: item.chunk.sectionId,
      sectionTitle: item.chunk.sectionTitle,
      contextualHeader: item.chunk.contextualHeader,
      category: String(item.chunk.metadata?.category || docCategories.get(item.chunk.documentId) || 'general'),
      content: item.chunk.content,
      tags: item.chunk.tags,
      semanticSimilarity: 0,
      lexicalScore: item.lexicalScore,
      rrfScore: Number((1 / (60 + idx + 1)).toFixed(6)),
      matchedVia: item.lexicalScore > 0 ? 'lexical' : 'fallback',
    }));
  }

  async getHealthStatus() {
    const docs = this.loadDocuments();
    const chunkCount = docs.reduce((sum, d) => sum + d.chunks.length, 0);
    return {
      backend: 'in-memory-fallback' as const,
      connected: true,
      documentCount: docs.length,
      chunkCount,
    };
  }

  private loadDocuments(): KnowledgeDocumentDraft[] {
    const fromEnvB64 = process.env.KNOWLEDGE_BASE_MD_B64?.trim() || '';
    const fromEnvPlain = process.env.KNOWLEDGE_BASE_MD?.trim() || '';
    const signature = crypto
      .createHash('sha256')
      .update(`${fromEnvB64}|${fromEnvPlain}|${process.cwd()}`)
      .digest('hex');
    if (this.cachedDocs.length > 0 && this.cacheSignature === signature) {
      return this.cachedDocs;
    }

    const docs: KnowledgeDocumentDraft[] = [];
    if (fromEnvPlain) {
      docs.push(parseKnowledgeMarkdownDocument('env:KNOWLEDGE_BASE_MD', fromEnvPlain));
    } else if (fromEnvB64) {
      const decoded = Buffer.from(fromEnvB64, 'base64').toString('utf8');
      docs.push(parseKnowledgeMarkdownDocument('env:KNOWLEDGE_BASE_MD_B64', decoded));
    } else {
      const knowledgeDir = path.resolve(process.cwd(), '.private/knowledge');
      if (fs.existsSync(knowledgeDir)) {
        const files = fs
          .readdirSync(knowledgeDir)
          .filter((name) => name.endsWith('.md'))
          .sort();
        for (const fileName of files) {
          const content = fs.readFileSync(path.join(knowledgeDir, fileName), 'utf8');
          docs.push(parseKnowledgeMarkdownDocument(fileName, content));
        }
      }
      if (docs.length === 0) {
        const singleFile = path.resolve(process.cwd(), '.private/knowledge-base.md');
        if (fs.existsSync(singleFile)) {
          docs.push(
            parseKnowledgeMarkdownDocument('knowledge-base.md', fs.readFileSync(singleFile, 'utf8')),
          );
        }
      }
    }

    this.cachedDocs = docs;
    this.cacheSignature = signature;
    return docs;
  }
}
