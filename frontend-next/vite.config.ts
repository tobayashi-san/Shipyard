import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Default UI served from the backend root.
export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': process.env.VITE_API_TARGET || 'http://localhost:3001',
      '/plugins': process.env.VITE_API_TARGET || 'http://localhost:3001',
      '/ws': {
        target: (process.env.VITE_API_TARGET || 'http://localhost:3001').replace(/^http/, 'ws'),
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
  test: {
    // Playwright specs live outside src and are run exclusively through
    // `npm run test:e2e`.  Without this exclusion Vitest tries to execute
    // them as unit tests as well.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
