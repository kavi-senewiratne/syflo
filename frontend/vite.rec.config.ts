// Temporary config for article GIF recordings (Claude, 2026-07-28).
// Second dev server on :5174 proxying the isolated demo backend on :3002
// so recordings never touch the real database. Delete after recording.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3002',
      '/uploads': 'http://localhost:3002',
    },
  },
})
