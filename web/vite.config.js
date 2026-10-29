import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Public pages (/p petition, /n newsletter, /v volunteer, /u unsubscribe,
    // /e event RSVP, /d donate)
    // are server-rendered by Hono, so dev proxies them alongside /api.
    proxy: {
      '/api': 'http://localhost:3200',
      '^/(p|n|v|u|e|d)/': 'http://localhost:3200',
      // Pictures in messages (blast.picture).
      '^/media(/|$)': 'http://localhost:3200',
    },
  },
});
