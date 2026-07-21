import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const rootDir = fileURLToPath(new URL('..', import.meta.url))

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Le backend écoute sur BIND_HOST:PORT de ../.env — souvent une IP Tailscale
  // et pas 127.0.0.1 (voir CLAUDE.md). Cibler 127.0.0.1 en dur laissait le
  // proxy dev en ECONNREFUSED : toute l'API et le chat étaient morts.
  const env = loadEnv(mode, rootDir, '')
  const host = env.BIND_HOST || '127.0.0.1'
  // Un hôte IPv6 doit être entre crochets dans une URL.
  const target = `http://${host.includes(':') ? `[${host}]` : host}:${env.PORT || '3001'}`

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // /api (JSON + SSE) est proxifié pour éviter tout souci de CORS.
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          // Le chat passe par un WebSocket (/api/chat/ws) : il doit être
          // relayé comme le reste de /api, sinon il n'atteint jamais le
          // backend en dev.
          ws: true,
        },
      },
    },
  }
})
