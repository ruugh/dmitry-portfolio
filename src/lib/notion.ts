import { Client } from '@notionhq/client';
import type {
  BlockObjectResponse,
  ListBlockChildrenResponse,
  PartialBlockObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { transliterate as tr } from 'transliteration';
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export type NotionNavItem = {
  id: string;
  title: string;
  slug: string;
  kind: 'case' | 'cv' | 'certificates';
  coverUrl?: string; // Notion page cover (preferred for cards)
};

export type CaseItem = {
  id: string;
  title: string;
  slug: string;
  summary?: string;
  role?: string;
  timeline?: string;
  platforms?: string[];
  tags?: string[];
  coverUrl?: string;
  order?: number;
};

function assertEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function getNotionClient() {
  const auth = assertEnv('NOTION_TOKEN');
  return new Client({ auth });
}

export const ROOT_PAGE_ID = () => assertEnv('ROOT_PAGE_ID');

export function slugifyTitle(title: string): string {
  const base = tr(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return base || 'page';
}

export const CASES_DATABASE_ID = () => assertEnv('CASES_DATABASE_ID');

function isChildPageBlock(
  b: PartialBlockObjectResponse | BlockObjectResponse,
): b is BlockObjectResponse & { type: 'child_page'; child_page: { title: string } } {
  // @notionhq/client types are wide; runtime check is safest.
  return (b as any)?.type === 'child_page' && !!(b as any)?.child_page?.title;
}

async function listAllChildren(notion: Client, blockId: string) {
  const out: (PartialBlockObjectResponse | BlockObjectResponse)[] = [];
  let cursor: string | undefined = undefined;
  while (true) {
    const resp: ListBlockChildrenResponse = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor ?? undefined;
  }
  return out;
}

async function getPageCoverUrl(notion: Client, pageId: string): Promise<string | undefined> {
  try {
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    const cover = page?.cover;
    if (!cover) return undefined;
    if (cover.type === 'external') return cover.external?.url;
    if (cover.type === 'file') return cover.file?.url;
    return undefined;
  } catch {
    return undefined;
  }
}

export async function getNavItemsFromRoot(): Promise<NotionNavItem[]> {
  const notion = getNotionClient();
  const rootId = ROOT_PAGE_ID();
  const children = await listAllChildren(notion, rootId);

  const items: NotionNavItem[] = [];
  for (const c of children) {
    if (!isChildPageBlock(c)) continue;
    const title = c.child_page.title.trim();

    let kind: NotionNavItem['kind'] = 'case';
    if (title.toLowerCase() === 'cv') kind = 'cv';
    if (title.toLowerCase() === 'сертификаты') kind = 'certificates';

    items.push({
      id: c.id,
      title,
      slug: slugifyTitle(title),
      kind,
    });
  }

  // Fill covers (useful for cards). This adds a few API calls but keeps content simple.
  for (const it of items) {
    it.coverUrl = await getPageCoverUrl(notion, it.id);
  }

  // Stable order: keep Notion order
  return items;
}

function propText(p: any): string {
  if (!p) return '';
  if (p.type === 'rich_text') return richTextToPlain(p.rich_text);
  if (p.type === 'title') return richTextToPlain(p.title);
  if (p.type === 'text') return p.text?.content ?? '';
  return '';
}

function propCheckbox(p: any): boolean {
  return !!(p && p.type === 'checkbox' && p.checkbox);
}

function propNumber(p: any): number | undefined {
  return p && p.type === 'number' ? (typeof p.number === 'number' ? p.number : undefined) : undefined;
}

function propSelect(p: any): string | undefined {
  return p && p.type === 'select' ? p.select?.name : undefined;
}

function propMultiSelect(p: any): string[] | undefined {
  return p && p.type === 'multi_select' ? (p.multi_select || []).map((x: any) => x.name) : undefined;
}

export async function getCasesFromDatabase(): Promise<CaseItem[]> {
  const notion = getNotionClient();
  const databaseId = CASES_DATABASE_ID();

  // We must use exact property names as defined in Notion (case-sensitive).
  // Fetch DB schema and map properties by case-insensitive keys.
  const schema: any = await notion.databases.retrieve({ database_id: databaseId });
  const propsSchema: Record<string, any> = schema?.properties ?? {};

  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const byNorm: Record<string, string> = {};
  for (const key of Object.keys(propsSchema)) {
    byNorm[normalize(key)] = key;
  }

  const pPublished = byNorm['published'];
  const pOrder = byNorm['order'];

  // Build query. If property names don't match (common), avoid Notion validation errors.
  const queryBody: any = {
    page_size: 100,
  };

  if (pPublished && propsSchema[pPublished]?.type === 'checkbox') {
    queryBody.filter = {
      property: pPublished,
      checkbox: { equals: true },
    };
  }

  if (pOrder && propsSchema[pOrder]?.type === 'number') {
    queryBody.sorts = [
      {
        property: pOrder,
        direction: 'descending',
      },
    ];
  }

  // SDK v5 removed databases.query in favor of dataSources.query.
  // Unfortunately data_source_id may differ from the database page id.
  // To keep this setup simple and stable, call the public REST endpoint directly.
  const token = process.env.NOTION_TOKEN;
  const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(queryBody),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Notion database query failed (${resp.status}): ${text}`);
  }

  const data: any = await resp.json();

  const pName = byNorm['name'] ?? byNorm['название'] ?? 'Name';
  const pSlug = byNorm['slug'] ?? byNorm['слаг'] ?? 'slug';
  const pSummary = byNorm['summary'] ?? byNorm['описание'] ?? 'summary';
  const pRole = byNorm['role'] ?? byNorm['роль'] ?? 'role';
  const pTimeline = byNorm['timeline'] ?? byNorm['таймлайн'] ?? 'timeline';
  const pPlatforms = byNorm['platforms'] ?? byNorm['платформы'] ?? 'platforms';
  const pTags = byNorm['tags'] ?? byNorm['теги'] ?? 'tags';

  const out: CaseItem[] = [];
  for (const page of data.results || []) {
    const props = page.properties || {};
    const title = propText(props[pName]) || 'Untitled';
    const slug = propText(props[pSlug]) || slugifyTitle(title);

    out.push({
      id: page.id,
      title,
      slug,
      summary: propText(props[pSummary]) || undefined,
      role: propSelect(props[pRole]),
      timeline: propText(props[pTimeline]) || undefined,
      platforms: propMultiSelect(props[pPlatforms]),
      tags: propMultiSelect(props[pTags]),
      coverUrl:
        page.cover?.type === 'external'
          ? page.cover.external?.url
          : page.cover?.type === 'file'
            ? page.cover.file?.url
            : undefined,
      order: pOrder ? propNumber(props[pOrder]) : undefined,
    });
  }

  return out;
}

function richTextToPlain(richText: any[] | undefined): string {
  if (!richText?.length) return '';
  return richText.map((t) => t?.plain_text ?? '').join('');
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}

function guessExt(url: string, contentType?: string): string {
  const fromType = (contentType || '').split(';')[0].trim().toLowerCase();
  if (fromType === 'image/png') return 'png';
  if (fromType === 'image/jpeg') return 'jpg';
  if (fromType === 'image/webp') return 'webp';
  if (fromType === 'image/gif') return 'gif';
  if (fromType === 'image/svg+xml') return 'svg';

  const m = url.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  return (m?.[1] || 'jpg').toLowerCase();
}

async function downloadToDistAsset(url: string): Promise<string> {
  // Write directly into dist so it is guaranteed to be published.
  const distDir = path.join(process.cwd(), 'dist');
  const assetsDir = path.join(distDir, 'notion-assets');
  await ensureDir(assetsDir);

  const hash = crypto.createHash('sha1').update(url).digest('hex');

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch asset: ${res.status}`);
  const contentType = res.headers.get('content-type') ?? undefined;
  const ext = guessExt(url, contentType);
  const filename = `${hash}.${ext}`;
  const filePath = path.join(assetsDir, filename);

  // Skip if already downloaded in this build
  try {
    await fs.access(filePath);
    return `/notion-assets/${filename}`;
  } catch {
    // continue
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);
  return `/notion-assets/${filename}`;
}

async function renderBlock(block: any): Promise<string> {
  const t = block.type;
  const v = block[t];

  switch (t) {
    case 'heading_1':
      return `<h1>${escapeHtml(richTextToPlain(v?.rich_text))}</h1>`;
    case 'heading_2':
      return `<h2>${escapeHtml(richTextToPlain(v?.rich_text))}</h2>`;
    case 'heading_3':
      return `<h3>${escapeHtml(richTextToPlain(v?.rich_text))}</h3>`;
    case 'paragraph': {
      const txt = richTextToPlain(v?.rich_text);
      if (!txt) return '';
      return `<p>${escapeHtml(txt)}</p>`;
    }
    case 'bulleted_list_item': {
      const txt = richTextToPlain(v?.rich_text);
      return `<li>${escapeHtml(txt)}</li>`;
    }
    case 'numbered_list_item': {
      const txt = richTextToPlain(v?.rich_text);
      return `<li>${escapeHtml(txt)}</li>`;
    }
    case 'quote':
      return `<blockquote>${escapeHtml(richTextToPlain(v?.rich_text))}</blockquote>`;
    case 'callout':
      return `<div class="callout">${escapeHtml(richTextToPlain(v?.rich_text))}</div>`;
    case 'divider':
      return `<hr />`;
    case 'code':
      return `<pre><code>${escapeHtml(v?.rich_text?.map((x: any) => x.plain_text).join('') ?? '')}</code></pre>`;
    case 'image': {
      const url = v?.type === 'external' ? v?.external?.url : v?.file?.url;
      const cap = richTextToPlain(v?.caption);
      if (!url) return '';

      // Markup helpers: put #wide in caption to make image full-width.
      const isWide = (cap || '').includes('#wide');
      const cleanCap = (cap || '').replace(/\s*#wide\s*/g, ' ').trim();

      // Notion "file" URLs are signed and expire. Download them into dist and reference locally.
      let src = url;
      if (v?.type === 'file') {
        try {
          src = await downloadToDistAsset(url);
        } catch {
          // fallback to original URL
          src = url;
        }
      }

      return `<figure class="${isWide ? 'wide' : ''}"><img src="${escapeHtml(src)}" alt="${escapeHtml(cleanCap || 'image')}" loading="lazy" />${cleanCap ? `<figcaption>${escapeHtml(cleanCap)}</figcaption>` : ''}</figure>`;
    }
    default:
      // ignore unsupported block types for MVP
      return '';
  }
}

export async function renderNotionPageToHtml(pageId: string): Promise<string> {
  const notion = getNotionClient();
  const blocks = await listAllChildren(notion, pageId);

  // Group list items into UL/OL
  const parts: string[] = [];
  let listMode: 'ul' | 'ol' | null = null;
  let listItems: string[] = [];

  function flushList() {
    if (!listMode || !listItems.length) {
      listMode = null;
      listItems = [];
      return;
    }
    parts.push(`<${listMode}>${listItems.join('')}</${listMode}>`);
    listMode = null;
    listItems = [];
  }

  for (const b of blocks as any[]) {
    const type = b?.type;
    if (type === 'bulleted_list_item') {
      if (listMode && listMode !== 'ul') flushList();
      listMode = 'ul';
      listItems.push(await renderBlock(b));
      continue;
    }
    if (type === 'numbered_list_item') {
      if (listMode && listMode !== 'ol') flushList();
      listMode = 'ol';
      listItems.push(await renderBlock(b));
      continue;
    }

    flushList();
    const html = await renderBlock(b);
    if (html) parts.push(html);
  }

  flushList();
  return parts.join('\n');
}
