import { Client } from '@notionhq/client';
import type {
  BlockObjectResponse,
  ListBlockChildrenResponse,
  PartialBlockObjectResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { transliterate as tr } from 'transliteration';

export type NotionNavItem = {
  id: string;
  title: string;
  slug: string;
  kind: 'case' | 'cv' | 'certificates';
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

  // Stable order: keep Notion order
  return items;
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

function renderBlock(block: any): string {
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
      return `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(cap || 'image')}" />${cap ? `<figcaption>${escapeHtml(cap)}</figcaption>` : ''}</figure>`;
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
      listItems.push(renderBlock(b));
      continue;
    }
    if (type === 'numbered_list_item') {
      if (listMode && listMode !== 'ol') flushList();
      listMode = 'ol';
      listItems.push(renderBlock(b));
      continue;
    }

    flushList();
    const html = renderBlock(b);
    if (html) parts.push(html);
  }

  flushList();
  return parts.join('\n');
}
