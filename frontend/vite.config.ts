import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      // Attachment display URLs — same-origin in dev, matching the packaged
      // app; the backend accepts local Hosts only (DNS-rebinding guard).
      '/uploads': 'http://localhost:3001',
    },
  },
})
