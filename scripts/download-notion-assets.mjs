import 'dotenv/config'
import { Client } from '@notionhq/client'
import crypto from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'

function assertEnv(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing env var: ${name}`)
  return v
}

const NOTION_TOKEN = assertEnv('NOTION_TOKEN')
const ROOT_PAGE_ID = assertEnv('ROOT_PAGE_ID')
const CASES_DATABASE_ID = assertEnv('CASES_DATABASE_ID')

const notion = new Client({ auth: NOTION_TOKEN })

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true })
}

function guessExt(url, contentType) {
  const fromType = (contentType || '').split(';')[0].trim().toLowerCase()
  if (fromType === 'image/png') return 'png'
  if (fromType === 'image/jpeg') return 'jpg'
  if (fromType === 'image/webp') return 'webp'
  if (fromType === 'image/gif') return 'gif'
  if (fromType === 'image/svg+xml') return 'svg'

  const m = url.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/)
  return (m?.[1] || 'jpg').toLowerCase()
}

async function listAllChildren(blockId) {
  const out = []
  let cursor = undefined
  while (true) {
    const resp = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor
    })
    out.push(...resp.results)
    if (!resp.has_more) break
    cursor = resp.next_cursor ?? undefined
  }
  return out
}

async function walkBlocks(blockId, depth = 50) {
  const blocks = await listAllChildren(blockId)
  const out = []
  for (const b of blocks) {
    out.push(b)
    if (depth > 0 && b?.has_children) {
      // Do not inline child pages/databases — they are separate documents.
      if (['child_page', 'child_database', 'link_to_page'].includes(b.type)) continue
      out.push(...(await walkBlocks(b.id, depth - 1)))
    }
  }
  return out
}

function coverKey(pageId) {
  return `cover-${pageId}`
}

function imageBlockFileKey(blockId) {
  return `img-${blockId}`
}

async function downloadAsset({ key, url }) {
  const publicDir = path.join(process.cwd(), 'public', 'notion-assets')
  await ensureDir(publicDir)

  // If we already have a file for this key in manifest, we may still want to skip.
  // But we detect by existing file with any ext: we store exact filename in manifest.
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch asset (${res.status}) ${url}`)
  const contentType = res.headers.get('content-type') ?? undefined
  const ext = guessExt(url, contentType)
  const filename = `${key}.${ext}`
  const filePath = path.join(publicDir, filename)

  try {
    await fs.access(filePath)
    const stat = await fs.stat(filePath)
    return { key, file: `notion-assets/${filename}`, bytes: stat.size, contentType }
  } catch {
    // continue
  }

  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(filePath, buf)
  return { key, file: `notion-assets/${filename}`, bytes: buf.length, contentType }
}

async function queryCasesDatabase() {
  const resp = await fetch(`https://api.notion.com/v1/databases/${CASES_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ page_size: 100 })
  })
  if (!resp.ok) throw new Error(`Notion database query failed (${resp.status})`) 
  const data = await resp.json()
  return data.results || []
}

async function main() {
  const startedAt = new Date().toISOString()

  const assets = []

  // Root page blocks
  const rootBlocks = await walkBlocks(ROOT_PAGE_ID)
  for (const b of rootBlocks) {
    if (b?.type === 'image' && b.image?.type === 'file' && b.image?.file?.url) {
      assets.push({ key: imageBlockFileKey(b.id), url: b.image.file.url })
    }
  }

  // Cases: covers + content blocks
  const casePages = await queryCasesDatabase()
  for (const p of casePages) {
    const pageId = p.id
    // Cover
    try {
      const page = await notion.pages.retrieve({ page_id: pageId })
      const cover = page?.cover
      if (cover?.type === 'file' && cover.file?.url) {
        assets.push({ key: coverKey(pageId), url: cover.file.url })
      }
    } catch {
      // ignore
    }

    // Content blocks
    try {
      const blocks = await walkBlocks(pageId)
      for (const b of blocks) {
        if (b?.type === 'image' && b.image?.type === 'file' && b.image?.file?.url) {
          assets.push({ key: imageBlockFileKey(b.id), url: b.image.file.url })
        }
      }
    } catch {
      // ignore
    }
  }

  // Deduplicate by key, keep last url.
  const byKey = new Map()
  for (const a of assets) byKey.set(a.key, a.url)

  const manifest = {
    version: 1,
    startedAt,
    source: {
      rootPageId: ROOT_PAGE_ID,
      casesDatabaseId: CASES_DATABASE_ID
    },
    assets: {}
  }

  let ok = 0
  let failed = 0

  for (const [key, url] of byKey.entries()) {
    try {
      const rec = await downloadAsset({ key, url })
      manifest.assets[key] = {
        file: rec.file,
        bytes: rec.bytes,
        contentType: rec.contentType || null,
        sha1: crypto.createHash('sha1').update(`${key}:${rec.bytes}`).digest('hex')
      }
      ok++
    } catch (e) {
      failed++
      manifest.assets[key] = { error: String(e?.message || e), file: null }
    }
  }

  const manifestPath = path.join(process.cwd(), 'public', 'notion-assets', 'manifest.json')
  await ensureDir(path.dirname(manifestPath))
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  console.log(`[notion-assets] downloaded: ${ok}, failed: ${failed}, total: ${byKey.size}`)
  if (failed > 0) process.exitCode = 0 // do not fail build; broken assets fallback to remote
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
