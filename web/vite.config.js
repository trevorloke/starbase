import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Two apps: the field app (index.html) and the website's admin
  // (website-admin.html, served at /website-admin by the server).
  build: { rollupOptions: { input: { main: 'index.html', 'website-admin': 'website-admin.html' } } },
  server: {
    // Public pages (/p petition, /n newsletter, /v volunteer, /u unsubscribe,
    // /e event RSVP, /d donate)
    // are server-rendered by Hono, so dev proxies them alongside /api.
    proxy: {
      '/api': 'http://localhost:3200',
      '^/(p|n|v|u|e|d)/': 'http://localhost:3200',
      // The public website and its pictures (server/ext/website).
      '^/(site|site-assets|media|fonts)(/|$)': 'http://localhost:3200',
    },
  },
});
