import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  build: {
    outDir: path.resolve(process.env.HOME || process.env.USERPROFILE || '', '.agent', 'webui', 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3100',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3100',
      },
    },
  },
});
