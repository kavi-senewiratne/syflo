/**
 * vite.demo.config.ts — temporary sandbox dev server (2026-08-23)
 *
 * Same app, but proxied to a demo backend on :3010 that runs against a
 * throwaway SYFLO_DATA_DIR. That gives a true fresh-install run — no chats,
 * no API keys — without touching the real ~/.syflo. Delete this file when the
 * walkthrough is over.
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3010',
      '/uploads': 'http://localhost:3010',
    },
  },
})
