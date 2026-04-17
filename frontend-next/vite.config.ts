import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Parallel UI served under /next on the backend.
// Mirrors the proxy rules from frontend/vite.config.js so dev hits :3001.
export default defineConfig({
  base: '/next/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3001',
      '/plugins': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
          editor: ['@uiw/react-codemirror', '@codemirror/lang-yaml'],
          router: ['@tanstack/react-router'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
