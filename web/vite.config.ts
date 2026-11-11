import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL('../dist', import.meta.url)), emptyOutDir: true },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/socket.io': { target: 'http://localhost:8787', ws: true },
    },
  },
});
