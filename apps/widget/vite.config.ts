import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/**
 * Two artefacts from one build.
 *
 * `loader.js` is what a host page embeds, so its URL has to be stable and predictable; a
 * hashed filename would mean editing salon-saas every time the widget is rebuilt. The chat
 * application inside the iframe is ordinary hashed output, because only the loader links
 * to it.
 *
 * No framework. The loader runs on somebody else's page and the chat app is loaded before
 * a customer has said anything, so both stay small enough not to be noticed.
 */
export default defineConfig({
  base: '/widget/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        loader: fileURLToPath(new URL('./src/loader.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'loader' ? 'loader.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 5174, proxy: { '/api': { target: 'http://localhost:3000' } } },
})
