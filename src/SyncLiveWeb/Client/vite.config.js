import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: '../Server/wwwroot', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4317', '/health': 'http://127.0.0.1:4317', '/webhooks': 'http://127.0.0.1:4317' } },
});
