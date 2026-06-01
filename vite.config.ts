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
    },
    plugins: [
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      devApiPlugin(env),
    ],
  }
})
