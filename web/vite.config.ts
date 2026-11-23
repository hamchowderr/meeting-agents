import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served by the Mastra server under /app/. In dev, API calls go to `mastra dev` on :4111.
export default defineConfig({
  root: 'web',
  base: '/app/',
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: { '/calls': 'http://localhost:4111', '/screen': 'http://localhost:4111' },
  },
})
