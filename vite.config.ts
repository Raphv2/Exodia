import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    host: true,
    port: 5180,
    proxy: { '/api': { target: 'http://localhost:3180' } },
  },
});
