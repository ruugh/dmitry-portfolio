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

type RenderOpts = {
  /**
   * For the root page we want images with any caption to behave like Notion "full content width".
   * (Used for portfolio cover-like images embedded into the page content.)
   */
  wideImagesWithCaption?: boolean;
};

type InternalRouteMap = Record<string, string>;

let _internalRouteMapPromise: Promise<InternalRouteMap> | null = null;

function compactPageId(id: string | undefined | null): string | null {
  if (!id) return null;
  const m = String(id).toLowerCase().match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  if (!m) return null;
  return m[0].replace(/-/g, '');
}

function extractNotionPageIdFromHref(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const decoded = decodeURIComponent(href);
    return compactPageId(decoded);
  } catch {
    return compactPageId(href);
  }
}

async function getInternalRouteMap(): Promise<InternalRouteMap> {
  if (_internalRouteMapPromise) return _internalRouteMapPromise;
  _internalRouteMapPromise = (async () => {
    const routes: InternalRouteMap = {};

    const rootId = compactPageId(ROOT_PAGE_ID());
    if (rootId) routes[rootId] = '/';

    const navItems = await getNavItemsFromRoot();
    for (const item of navItems) {
      const key = compactPageId(item.id);
      if (!key) continue;
      if (item.kind === 'cv') routes[key] = '/cv';
      else if (item.kind === 'certificates') routes[key] = '/certificates';
      else routes[key] = `/cases/${item.slug}/`;
    }

    try {
      const cases = await getCasesFromDatabase();
      for (const item of cases) {
        const key = compactPageId(item.id);
        if (!key) continue;
        routes[key] = `/cases/${item.slug}/`;
      }
    } catch {
      // Keep nav-based routes even if DB fetch fails.
    }

    return routes;
  })();
  return _internalRouteMapPromise;
}

async function resolveHref(href: string | undefined | null): Promise<string | null> {
  if (!href) return null;
  const pageId = extractNotionPageIdFromHref(href);
  if (!pageId) return href;
  const routes = await getInternalRouteMap();
  return routes[pageId] || href;
}

async function renderChildrenHtml(notion: Client, blockId: string, depth: number, opts: RenderOpts): Promise<string> {
  if (depth <= 0) return '';
  const blocks = await listAllChildren(notion, blockId);
  return renderBlocksToHtml(notion, blocks as any[], depth - 1, opts);
}

async function getPageCoverUrl(notion: Client, pageId: string): Promise<string | undefined> {
  try {
    const page: any = await notion.pages.retrieve({ page_id: pageId });
    const cover = page?.cover;
    if (!cover) return undefined;
    if (cover.type === 'external') return cover.external?.url;
    if (cover.type === 'file' && cover.file?.url) {
      return mapToLocalAsset(coverKey(pageId), cover.file.url);
    }
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

  const findProp = (candidates: string[], type?: string): string | undefined => {
    for (const c of candidates) {
      const exact = byNorm[c];
      if (exact && (!type || propsSchema[exact]?.type === type)) return exact;
    }
    // fuzzy match
    const candSet = new Set(candidates);
    for (const key of Object.keys(propsSchema)) {
      const n = normalize(key);
      if ([...candSet].some((c) => n.includes(c))) {
        if (!type || propsSchema[key]?.type === type) return key;
      }
    }
    return undefined;
  };

  const pPublished = findProp(['published', 'публик', 'опублик'], 'checkbox');
  const pOrder = findProp(['order', 'порядок'], 'number');

  // Build query: prefer strict filter/sort when we can resolve property names.
  const queryBody: any = { page_size: 100 };
  if (pPublished) {
    queryBody.filter = { property: pPublished, checkbox: { equals: true } };
  }
  if (pOrder) {
    queryBody.sorts = [{ property: pOrder, direction: 'descending' }];
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
          : page.cover?.type === 'file' && page.cover.file?.url
            ? await mapToLocalAsset(coverKey(page.id), page.cover.file.url)
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

async function renderRichTextToHtml(richText: any[] | undefined): Promise<string> {
  if (!richText?.length) return '';

  const parts = await Promise.all(
    richText.map(async (t) => {
      const text = escapeHtml(t?.plain_text ?? '');
      if (!text) return '';

      let html = text;
      const ann = t?.annotations ?? {};
      if (ann.code) html = `<code>${html}</code>`;
      if (ann.bold) html = `<strong>${html}</strong>`;
      if (ann.italic) html = `<em>${html}</em>`;
      if (ann.strikethrough) html = `<s>${html}</s>`;
      if (ann.underline) html = `<u>${html}</u>`;

      const href = await resolveHref(t?.href || t?.text?.link?.url);
      if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
      return html;
    }),
  );

  return parts.join('');
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

type AssetManifest = {
  version: number;
  assets?: Record<string, { file?: string | null }>;
};

let _assetManifest: AssetManifest | null | undefined;
async function getAssetManifest(): Promise<AssetManifest | null> {
  if (_assetManifest !== undefined) return _assetManifest;
  const manifestPath = path.join(process.cwd(), 'public', 'notion-assets', 'manifest.json');
  try {
    const txt = await fs.readFile(manifestPath, 'utf8');
    _assetManifest = JSON.parse(txt) as AssetManifest;
    return _assetManifest;
  } catch {
    _assetManifest = null;
    return null;
  }
}

function imageKey(blockId: string) {
  return `img-${blockId}`;
}

function coverKey(pageId: string) {
  return `cover-${pageId}`;
}

async function mapToLocalAsset(key: string, fallbackUrl: string): Promise<string> {
  const m = await getAssetManifest();
  const file = m?.assets?.[key]?.file;
  if (file && typeof file === 'string') return `/${file.replace(/^\/+/, '')}`;
  return fallbackUrl;
}

async function renderBlock(notion: Client, block: any, depth: number, opts: RenderOpts): Promise<string> {
  const t = block.type;
  const v = block[t];

  // Some blocks are containers, others are references to separate pages.
  // We MUST NOT recursively inline child pages into the current page.
  const shouldInlineChildren = !!block?.has_children && !['child_page', 'child_database', 'link_to_page'].includes(t);
  const childHtml = shouldInlineChildren ? await renderChildrenHtml(notion, block.id, depth, opts) : '';

  switch (t) {
    case 'heading_1':
      return `<h1>${await renderRichTextToHtml(v?.rich_text)}</h1>${childHtml}`;
    case 'heading_2':
      return `<h2>${await renderRichTextToHtml(v?.rich_text)}</h2>${childHtml}`;
    case 'heading_3':
      return `<h3>${await renderRichTextToHtml(v?.rich_text)}</h3>${childHtml}`;
    case 'paragraph': {
      const html = await renderRichTextToHtml(v?.rich_text);
      const p = html ? `<p>${html}</p>` : '';
      return `${p}${childHtml}`;
    }
    case 'bulleted_list_item': {
      const html = await renderRichTextToHtml(v?.rich_text);
      return `<li>${html}${childHtml ? `<div class="li-children">${childHtml}</div>` : ''}</li>`;
    }
    case 'numbered_list_item': {
      const html = await renderRichTextToHtml(v?.rich_text);
      return `<li>${html}${childHtml ? `<div class="li-children">${childHtml}</div>` : ''}</li>`;
    }
    case 'quote':
      return `<blockquote>${await renderRichTextToHtml(v?.rich_text)}</blockquote>${childHtml}`;
    case 'callout': {
      const html = await renderRichTextToHtml(v?.rich_text);
      return `<div class="callout">${html}${childHtml ? `<div class="callout-children">${childHtml}</div>` : ''}</div>`;
    }
    case 'toggle': {
      const summary = await renderRichTextToHtml(v?.rich_text);
      return `<details class="toggle"><summary>${summary}</summary>${childHtml}</details>`;
    }
    case 'column_list': {
      // children are "column" blocks
      return `<div class="columns">${childHtml}</div>`;
    }
    case 'column': {
      return `<div class="column">${childHtml}</div>`;
    }
    case 'table': {
      const hasColHeader = !!v?.has_column_header;
      // Render rows with access to index for header semantics
      const rows = await listAllChildren(notion, block.id);
      const rowHtmlParts: string[] = [];
      let idx = 0;
      for (const r of rows as any[]) {
        if (r?.type !== 'table_row') continue;
        const isHeaderRow = hasColHeader && idx === 0;
        const cells: any[] = r?.table_row?.cells ?? [];
        const cellTag = isHeaderRow ? 'th' : 'td';
        const cellsHtml = cells
          .map((cell) => {
            const txt = escapeHtml(richTextToPlain(cell));
            return `<${cellTag}>${txt}</${cellTag}>`;
          })
          .join('');
        rowHtmlParts.push(`<tr>${cellsHtml}</tr>`);
        idx++;
      }

      return `<div class="table-wrap"><table class="notion-table${hasColHeader ? ' has-header' : ''}"><tbody>${rowHtmlParts.join('')}</tbody></table></div>`;
    }
    case 'table_row': {
      // table rows are rendered by the parent table
      return '';
    }
    case 'divider':
      return `<hr />`;
    case 'code':
      return `<pre><code>${escapeHtml(v?.rich_text?.map((x: any) => x.plain_text).join('') ?? '')}</code></pre>${childHtml}`;
    case 'image': {
      const url = v?.type === 'external' ? v?.external?.url : v?.file?.url;
      const cap = richTextToPlain(v?.caption);
      if (!url) return '';

      // Caption tags:
      // - #wide → full width of content column
      // - #w600 / #w720 ... → cap image max-width in px
      const rawCap = cap || '';
      const wMatch = rawCap.match(/#w(\d{2,4})\b/i);
      const widthPx = wMatch ? Math.max(120, Math.min(2000, Number(wMatch[1]))) : undefined;
      const caseMatch = rawCap.match(/#case:([a-z0-9-]+)/i);
      const caseSlug = caseMatch?.[1];

      // Strip control tags from caption (they should not be visible).
      const cleanCap = rawCap
        .replace(/\s*#wide\s*/g, ' ')
        .replace(/\s*#w\d{2,4}\b\s*/gi, ' ')
        .replace(/\s*#case:[a-z0-9-]+\b\s*/gi, ' ')
        .trim();

      // Wide mode rules:
      // - Explicit: #wide (robust detection)
      // - Optional convenience: when enabled, any REAL caption text (not just tags) makes it wide
      const hasWideTag = /(^|\s)#wide(\s|$)/i.test(rawCap);
      const isWide = hasWideTag || (!!opts.wideImagesWithCaption && cleanCap.length > 0);

      // Notion "file" URLs are signed and expire.
      // During build we download them into public/notion-assets and map via manifest.
      let src = url;
      if (v?.type === 'file') {
        src = await mapToLocalAsset(imageKey(block.id), url);
      }

      const cls = isWide ? 'wide' : '';
      // If image is explicitly marked wide, do not apply #wNNN max-width cap.
      const style = !hasWideTag && !isWide && widthPx ? ` style=\"max-width:min(100%,${widthPx}px);\"` : '';

      // Note: child blocks on image are rare; ignore childHtml.
      // Wrap in a div so layout/CSS can target the whole image block reliably.
      const imgTag = `<img${style} src="${escapeHtml(src)}" alt="${escapeHtml(cleanCap || 'image')}" loading="lazy" />`;
      const maybeLinkedImg = caseSlug ? `<a href="/cases/${escapeHtml(caseSlug)}/" class="case-link">${imgTag}</a>` : imgTag;

      return `<div class="notion-image ${cls}"><figure class="${cls}">${maybeLinkedImg}${cleanCap ? `<figcaption>${escapeHtml(cleanCap)}</figcaption>` : ''}</figure></div>`;
    }
    case 'child_page': {
      const title = escapeHtml(v?.title ?? '');
      const href = (await getInternalRouteMap())[compactPageId(block.id) || ''] || `/cases/${slugifyTitle(v?.title ?? '')}/`;
      return title ? `<p><a href="${escapeHtml(href)}">${title}</a></p>` : '';
    }
    case 'child_database':
      return '';
    case 'link_to_page': {
      const pageId = compactPageId(v?.page_id || v?.database_id || v?.comment_id);
      const href = pageId ? (await getInternalRouteMap())[pageId] : null;
      return href ? `<p><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></p>` : '';
    }
    default:
      return childHtml || '';
  }
}

async function renderBlocksToHtml(notion: Client, blocks: any[], depth: number, opts: RenderOpts): Promise<string> {
  // Group list items into UL/OL at current level
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
      listItems.push(await renderBlock(notion, b, depth, opts));
      continue;
    }
    if (type === 'numbered_list_item') {
      if (listMode && listMode !== 'ol') flushList();
      listMode = 'ol';
      listItems.push(await renderBlock(notion, b, depth, opts));
      continue;
    }

    flushList();
    const html = await renderBlock(notion, b, depth, opts);
    if (html) parts.push(html);
  }

  flushList();
  return parts.join('\n');
}

export async function renderNotionPageToHtml(pageId: string, opts: RenderOpts = {}): Promise<string> {
  const notion = getNotionClient();
  const blocks = await listAllChildren(notion, pageId);
  return renderBlocksToHtml(notion, blocks as any[], 6, opts);
}
