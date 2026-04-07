// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  vite: {
    // Expose this build-time flag for preview builds that run without Notion env vars.
    define: {
      'import.meta.env.ALLOW_MISSING_NOTION_ENV': JSON.stringify(process.env.ALLOW_MISSING_NOTION_ENV ?? ''),
    },
  },
});
