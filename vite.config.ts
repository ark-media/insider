import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { devApiPlugin } from './server/dev-api'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    build: {
      // Rolldown's default OXC minifier (rolldown-rc.15) intermittently mangles
      // a local variable inside a wrapped CommonJS module factory to the same
      // single letter as an outer interop thunk it then calls — emitting
      // `var t=t()`, which `var`-hoists to undefined and throws "t is not a
      // function" at chunk init. It surfaced in html-dom-parser (via
      // html-react-parser) and took down every page that imports the parser.
      // esbuild's renamer is scope-aware and never produces that shadowing.
      minify: 'esbuild',
      // The TipTap/ProseMirror editor is ~620 kB in one unsplittable vendor
      // chunk. It's admin-only and lazily loaded (components/LazyRichTextEditor),
      // so it blocks nothing — but it trips the stock 500 kB warning on every
      // build. Raised just past it so the check still catches anything new.
      chunkSizeWarningLimit: 650,
      rolldownOptions: {
        output: {
          advancedChunks: {
            groups: [
              // PostHog + Sentry are ~200 kB of vendor code that every page
              // pulls in via lib/observability, and they change on their own
              // release cadence. Splitting them out of the entry chunk keeps
              // app edits from busting their cache on every deploy.
              {
                name: 'observability',
                test: /node_modules\/(posthog-js|@sentry)\//,
              },
            ],
          },
        },
      },
    },
    plugins: [
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      devApiPlugin(env),
    ],
  }
})
