import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // En dev, le backend Hono tourne sur PORT (3001 par défaut, voir ../.env).
    // /api (JSON + SSE) est proxifié pour éviter tout souci de CORS.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        // Le chat passe par un WebSocket (/api/chat/ws) : il doit être
        // relayé comme le reste de /api, sinon il n'atteint jamais le
        // backend en dev.
        ws: true,
      },
    },
  },
})
