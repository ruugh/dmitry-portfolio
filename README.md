# Dmitry Korchagin — Notion → Astro (Cloudflare Pages)

MVP: статический сайт на Astro, который на этапе build тянет контент из Notion по `ROOT_PAGE_ID`.

## Требования
- Node.js 18+ (лучше 20+)
- Notion Integration с доступом к корневой странице

## Переменные окружения
Создай `.env` локально (не коммить):

```bash
NOTION_TOKEN=secret_xxx
ROOT_PAGE_ID=09fae64f-9c3b-4f2d-9965-ebf476269966
```

Шаблон: `.env.example`.

## Локальный запуск
```bash
npm i
npm run dev
```

## Деплой на Cloudflare Pages (по кнопке)
1. Создай репозиторий на GitHub и запушь этот проект.
2. Cloudflare → **Pages** → Create project → подключи репо.
3. Build settings:
   - Framework preset: **Astro**
   - Build command: `npm run build`
   - Build output directory: `dist`
4. Environment variables (Settings → Environment variables):
   - `NOTION_TOKEN`
   - `ROOT_PAGE_ID`
5. Custom domain: `dmitrykorchagin.org`.

## Как определяется, что не является кейсом
На корневой странице Notion берутся **дочерние страницы** (child pages) и классифицируются так:
- `CV` → `/cv`
- `Сертификаты` → `/certificates`
- всё остальное → `/cases/<slug>`

Slug строится транслитерацией заголовка.

## Ограничения MVP
Рендер блоков Notion сейчас базовый (заголовки/параграфы/списки/картинки/цитаты/код). Сложные блоки игнорируются.


## Build note
Cloudflare Pages build requires env vars: NOTION_TOKEN, ROOT_PAGE_ID.
