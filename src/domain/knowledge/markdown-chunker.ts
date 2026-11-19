import crypto from 'node:crypto';
import type {
  KnowledgeCategory,
  KnowledgeChunkDraft,
  KnowledgeDocumentDraft,
} from './knowledge.types.js';

const DEFAULT_MAX_CHUNK_CHARS = 1200;
const DEFAULT_OVERLAP_PARAGRAPHS = 1;

const VALID_CATEGORIES = new Set<KnowledgeCategory>([
  'identity',
  'compensation',
  'experience',
  'integrations',
  'architecture',
  'skills',
  'education',
  'general',
]);

const KNOWN_TECH_TERMS = [
  'TypeScript',
  'Node.js',
  'NestJS',
  'Java',
  'Spring Boot',
  'LoopBack 4',
  'PostgreSQL',
  'MongoDB',
  'MySQL',
  'Redis',
  'GraphQL',
  'REST',
  'AWS',
  'ECS',
  'Lambda',
  'SQS',
  'SNS',
  'EventBridge',
  'BullMQ',
  'Google Cloud Functions',
  'Cloudflare Workers',
  'Cloudflare AI Gateway',
  'Docker',
  'GitHub Actions',
  'Stripe',
  'Nequi',
  'Refácil',
  'Tusdatos.co',
  'Datadog',
  'CleverTap',
  'Metabase',
  'Retool',
  'AppsFlyer',
  'Intercom',
  'Twilio',
  'SendGrid',
  'Firebase FCM',
  'MCP',
  'Hexagonal',
  'DDD',
  'pgvector',
  'GoodRec',
  'Bolsiyo',
  'Cooltivalo',
  'React',
  'Next.js',
  'Astro',
];

export interface ChunkMarkdownOptions {
  maxChunkChars?: number;
  overlapParagraphs?: number;
}

interface ParsedDirectiveMetadata {
  category?: KnowledgeCategory;
  company?: string;
  tags: string[];
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsWholeTerm(haystack: string, term: string): boolean {
  const escaped = escapeRegExp(term.trim());
  if (!escaped) return false;
  const rx = new RegExp(`(?:^|[^\\p{L}\\p{N}+#])${escaped}(?:$|[^\\p{L}\\p{N}+#])`, 'iu');
  return rx.test(haystack);
}

function parseDirectiveCommentBody(commentBody: string, target: ParsedDirectiveMetadata): void {
  const pairs = commentBody.split(';');
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const key = pair.slice(0, colonIdx).trim().toLowerCase();
    const val = pair.slice(colonIdx + 1).trim();
    if (!val) continue;

    if (key === 'category') {
      const normalized = val.toLowerCase() as KnowledgeCategory;
      if (VALID_CATEGORIES.has(normalized)) {
        target.category = normalized;
      }
    } else if (key === 'company') {
      target.company = val;
    } else if (key === 'tags') {
      for (const tag of val.split(',')) {
        const clean = tag.trim();
        if (clean) target.tags.push(clean);
      }
    }
  }
}

/**
 * Parses only leading HTML metadata comments at the top of a document or section
 * so section-level directives inside `##` blocks are never stripped prematurely.
 */
function parseLeadingMetadataDirectives(raw: string): {
  meta: ParsedDirectiveMetadata;
  body: string;
} {
  const meta: ParsedDirectiveMetadata = { tags: [] };
  let remaining = raw.trimStart();

  while (remaining.startsWith('<!--')) {
    const endIdx = remaining.indexOf('-->');
    if (endIdx === -1) break;
    const commentBody = remaining.slice(4, endIdx);
    parseDirectiveCommentBody(commentBody, meta);
    remaining = remaining.slice(endIdx + 3).trimStart();
  }

  return { meta, body: remaining.trim() };
}

function stripInlineHtmlComments(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, '').trim();
}

interface MarkdownHeadingBlock {
  title: string;
  body: string;
}

/**
 * Splits markdown by headings of the given level (`#` or `##`) while ignoring
 * `#` lines inside fenced code blocks (``` or ~~~).
 */
function splitByHeadingLevel(
  markdown: string,
  level: 1 | 2,
): { preamble: string; blocks: MarkdownHeadingBlock[] } {
  const lines = markdown.split('\n');
  const headingRx = level === 1 ? /^#\s+(.+)$/ : /^##\s+(.+)$/;
  const preambleLines: string[] = [];
  const blocks: MarkdownHeadingBlock[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];
  let activeFence: '`' | '~' | null = null;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      activeFence = activeFence === '`' ? null : activeFence === null ? '`' : activeFence;
    } else if (trimmed.startsWith('~~~')) {
      activeFence = activeFence === '~' ? null : activeFence === null ? '~' : activeFence;
    }

    const match = activeFence === null ? line.match(headingRx) : null;
    if (match) {
      if (currentTitle !== null) {
        blocks.push({ title: currentTitle, body: currentLines.join('\n').trim() });
      }
      currentTitle = match[1].trim();
      currentLines = [];
      continue;
    }

    if (currentTitle === null) {
      preambleLines.push(line);
    } else {
      currentLines.push(line);
    }
  }

  if (currentTitle !== null) {
    blocks.push({ title: currentTitle, body: currentLines.join('\n').trim() });
  }

  return { preamble: preambleLines.join('\n').trim(), blocks };
}

function inferCategoryFromText(title: string, content: string): KnowledgeCategory {
  const titleLower = title.toLowerCase();
  if (
    titleLower.includes('compensation') ||
    titleLower.includes('salary') ||
    titleLower.includes('contract')
  ) {
    return 'compensation';
  }
  if (
    titleLower.includes('education') ||
    titleLower.includes('university') ||
    titleLower.includes('degree')
  ) {
    return 'education';
  }
  if (titleLower.includes('third-party') || titleLower.includes('integration')) {
    return 'integrations';
  }
  if (
    titleLower.includes('architecture') ||
    titleLower.includes('blueprint') ||
    titleLower.includes('ci/cd') ||
    titleLower.includes('devops')
  ) {
    return 'architecture';
  }
  if (titleLower.includes('skill') || titleLower.includes('non-primary stack')) {
    return 'skills';
  }
  if (
    titleLower.includes('goodrec') ||
    titleLower.includes('bolsiyo') ||
    titleLower.includes('cooltivalo') ||
    titleLower.includes('work experience')
  ) {
    return 'experience';
  }
  if (
    titleLower.includes('identity') ||
    titleLower.includes('executive profile') ||
    titleLower.includes('contact') ||
    titleLower.includes('official links')
  ) {
    return 'identity';
  }

  const lower = `${titleLower} ${content.toLowerCase()}`;
  if (lower.includes('compensation') || lower.includes('salary')) {
    return 'compensation';
  }
  if (lower.includes('universidad') || lower.includes('bachelor') || lower.includes('systems engineering')) {
    return 'education';
  }
  if (lower.includes('goodrec') || lower.includes('bolsiyo') || lower.includes('work experience')) {
    return 'experience';
  }
  if (lower.includes('third-party') || lower.includes('integrations breakdown')) {
    return 'integrations';
  }
  if (lower.includes('architecture') || lower.includes('blueprint') || lower.includes('ci/cd')) {
    return 'architecture';
  }
  if (lower.includes('skill matrix') || lower.includes('non-primary stack')) {
    return 'skills';
  }
  if (lower.includes('identity') || lower.includes('executive')) {
    return 'identity';
  }
  return 'general';
}

function inferSectionCategory(
  sectionTitle: string,
  explicitSectionCategory: KnowledgeCategory | undefined,
  docCategory: KnowledgeCategory,
): KnowledgeCategory {
  if (explicitSectionCategory) {
    return explicitSectionCategory;
  }
  const titleLower = sectionTitle.toLowerCase();
  if (
    titleLower.includes('compensation') ||
    titleLower.includes('salary') ||
    titleLower.includes('contract')
  ) {
    return 'compensation';
  }
  if (
    titleLower.includes('education') ||
    titleLower.includes('university') ||
    titleLower.includes('learning')
  ) {
    return 'education';
  }
  return docCategory;
}

function extractDetectedTags(
  chunkText: string,
  sectionSeedTags: string[],
  docSeedTags: string[],
): string[] {
  const seen = new Map<string, string>();

  // Always keep tags declared explicitly on the section itself
  for (const tag of sectionSeedTags) {
    const clean = tag.trim();
    if (clean) seen.set(clean.toLowerCase(), clean);
  }

  // Only inherit document-level tags that actually appear in this chunk
  for (const tag of docSeedTags) {
    const clean = tag.trim();
    if (clean && !seen.has(clean.toLowerCase()) && containsWholeTerm(chunkText, clean)) {
      seen.set(clean.toLowerCase(), clean);
    }
  }

  // Detect known technical terms using whole-word boundaries (prevents "interesting" -> REST)
  for (const term of KNOWN_TECH_TERMS) {
    if (!seen.has(term.toLowerCase()) && containsWholeTerm(chunkText, term)) {
      seen.set(term.toLowerCase(), term);
    }
  }

  // Fallback to a small slice of docSeedTags only if nothing matched at all
  if (seen.size === 0) {
    for (const tag of docSeedTags.slice(0, 6)) {
      const clean = tag.trim();
      if (clean) seen.set(clean.toLowerCase(), clean);
    }
  }

  return Array.from(seen.values()).slice(0, 16);
}

function joinedLength(blocks: string[]): number {
  if (blocks.length === 0) return 0;
  return blocks.reduce((acc, item) => acc + item.length, 0) + (blocks.length - 1) * 2;
}

function splitLongSection(
  content: string,
  maxChunkChars: number,
  overlapParagraphs: number,
): string[] {
  const normalized = content.trim();
  if (!normalized) return [];
  if (normalized.length <= maxChunkChars) {
    return [normalized];
  }

  const blocks = normalized
    .split(/\n{2,}/)
    .flatMap((block) => {
      if (block.length <= maxChunkChars) return [block.trim()];
      // Split oversized bullet lists line by line so no bullet is cut mid-sentence.
      return block
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    })
    .filter(Boolean);

  const chunks: string[] = [];
  let current: string[] = [];

  for (const block of blocks) {
    const nextLen = joinedLength(current) + (current.length > 0 ? 2 : 0) + block.length;
    if (current.length > 0 && nextLen > maxChunkChars) {
      chunks.push(current.join('\n\n'));
      const overlap = overlapParagraphs > 0 ? current.slice(-overlapParagraphs) : [];
      current = joinedLength(overlap) < maxChunkChars * 0.45 ? [...overlap] : [];
    }
    current.push(block);
  }

  if (current.length > 0) {
    chunks.push(current.join('\n\n'));
  }

  return chunks;
}

export function parseKnowledgeMarkdownDocument(
  sourcePath: string,
  rawMarkdown: string,
  options: ChunkMarkdownOptions = {},
): KnowledgeDocumentDraft {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlapParagraphs = options.overlapParagraphs ?? DEFAULT_OVERLAP_PARAGRAPHS;
  const normalizedRaw = rawMarkdown.replace(/\r\n/g, '\n').trim();
  const { meta: docMeta, body } = parseLeadingMetadataDirectives(normalizedRaw);

  const rawBaseName = sourcePath.split('/').pop()?.replace(/\.md$/i, '') || 'knowledge-document';
  const documentId = slugify(rawBaseName) || 'knowledge-document';

  const { blocks: h1Blocks } = splitByHeadingLevel(body, 1);
  const docTitle =
    h1Blocks.length === 1
      ? h1Blocks[0].title || rawBaseName
      : h1Blocks.length === 0
        ? rawBaseName
        : 'Santiago Olayo Knowledge Base';

  const docCategory = docMeta.category ?? inferCategoryFromText(docTitle, body);

  interface RawSection {
    title: string;
    body: string;
    sectionTags: string[];
    category: KnowledgeCategory;
    company?: string;
  }

  const sections: RawSection[] = [];

  if (h1Blocks.length <= 1) {
    const contentAfterH1 = h1Blocks.length === 1 ? h1Blocks[0].body : body;
    const { meta: afterH1Meta, body: afterH1Body } = parseLeadingMetadataDirectives(contentAfterH1);
    const mergedDocCategory = docMeta.category ?? afterH1Meta.category ?? docCategory;
    const mergedDocTags = [...docMeta.tags, ...afterH1Meta.tags];
    const { preamble, blocks: h2Blocks } = splitByHeadingLevel(afterH1Body, 2);

    if (h2Blocks.length > 0) {
      if (preamble) {
        const cleanPreamble = stripInlineHtmlComments(preamble);
        if (cleanPreamble) {
          sections.push({
            title: docTitle,
            body: cleanPreamble,
            sectionTags: mergedDocTags,
            category: mergedDocCategory,
            company: docMeta.company ?? afterH1Meta.company,
          });
        }
      }
      for (const h2 of h2Blocks) {
        const { meta: secMeta, body: secBodyRaw } = parseLeadingMetadataDirectives(h2.body);
        const secBody = stripInlineHtmlComments(secBodyRaw);
        if (!secBody) continue;
        sections.push({
          title: h2.title,
          body: secBody,
          sectionTags: secMeta.tags,
          category: inferSectionCategory(h2.title, secMeta.category, mergedDocCategory),
          company: secMeta.company ?? docMeta.company ?? afterH1Meta.company,
        });
      }
    } else {
      const cleanBody = stripInlineHtmlComments(afterH1Body);
      if (cleanBody) {
        sections.push({
          title: docTitle,
          body: cleanBody,
          sectionTags: mergedDocTags,
          category: mergedDocCategory,
          company: docMeta.company ?? afterH1Meta.company,
        });
      }
    }
  } else {
    // Multi-H1 fallback (supports single-file knowledge-base.md format seamlessly)
    for (const h1 of h1Blocks) {
      const { meta: h1Meta, body: h1Body } = parseLeadingMetadataDirectives(h1.body);
      const { preamble, blocks: h2Blocks } = splitByHeadingLevel(h1Body, 2);
      const h1Category = h1Meta.category ?? inferCategoryFromText(h1.title, h1Body);

      if (h2Blocks.length > 0) {
        if (preamble) {
          const cleanPreamble = stripInlineHtmlComments(preamble);
          if (cleanPreamble) {
            sections.push({
              title: h1.title,
              body: cleanPreamble,
              sectionTags: h1Meta.tags,
              category: h1Category,
              company: h1Meta.company ?? docMeta.company,
            });
          }
        }
        for (const h2 of h2Blocks) {
          const secTitle = `${h1.title} · ${h2.title}`;
          const { meta: secMeta, body: secBodyRaw } = parseLeadingMetadataDirectives(h2.body);
          const secBody = stripInlineHtmlComments(secBodyRaw);
          if (!secBody) continue;
          sections.push({
            title: secTitle,
            body: secBody,
            sectionTags: [...h1Meta.tags, ...secMeta.tags],
            category: inferSectionCategory(h2.title, secMeta.category, h1Category),
            company: secMeta.company ?? h1Meta.company ?? docMeta.company,
          });
        }
      } else {
        const cleanBody = stripInlineHtmlComments(h1Body);
        if (cleanBody) {
          sections.push({
            title: h1.title,
            body: cleanBody,
            sectionTags: h1Meta.tags,
            category: h1Category,
            company: h1Meta.company ?? docMeta.company,
          });
        }
      }
    }
  }

  const chunks: KnowledgeChunkDraft[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const baseSectionId = slugify(section.title) || `section-${chunkIndex + 1}`;
    const subChunks = splitLongSection(section.body, maxChunkChars, overlapParagraphs);

    subChunks.forEach((partContent, partIdx) => {
      const partLabel = subChunks.length > 1 ? ` (Part ${partIdx + 1}/${subChunks.length})` : '';
      const displaySectionTitle = `${section.title}${partLabel}`;
      const contextualHeader =
        docTitle.toLowerCase() === section.title.toLowerCase()
          ? displaySectionTitle
          : `${docTitle} > ${displaySectionTitle}`;

      const tags = extractDetectedTags(
        `${displaySectionTitle}\n${partContent}`,
        section.sectionTags,
        docMeta.tags,
      );

      const embeddedText = [
        `Document: ${docTitle}`,
        `Section: ${displaySectionTitle}`,
        `Category: ${section.category}`,
        tags.length > 0 ? `Tags: ${tags.join(', ')}` : '',
        '',
        partContent,
      ]
        .filter((line, idx, arr) => line !== '' || (idx > 0 && arr[idx - 1] !== ''))
        .join('\n');

      chunks.push({
        id: `${documentId}::${chunkIndex}`,
        documentId,
        chunkIndex,
        sectionId: baseSectionId,
        sectionTitle: displaySectionTitle,
        contextualHeader,
        content: partContent,
        embeddedText,
        tags,
        tokenEstimate: estimateTokens(embeddedText),
        contentHash: sha256(embeddedText),
        metadata: {
          category: section.category,
          ...(section.company ? { company: section.company } : {}),
          sourcePath,
        },
      });
      chunkIndex += 1;
    });
  }

  return {
    id: documentId,
    sourcePath,
    title: docTitle,
    category: docCategory,
    contentHash: sha256(normalizedRaw),
    metadata: {
      ...(docMeta.company ? { company: docMeta.company } : {}),
      tags: docMeta.tags,
    },
    chunks,
  };
}
