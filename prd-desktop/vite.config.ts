import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'node:fs';
import { devCsp, DEV_CSP_NONCE } from './scripts/devCsp';

const desktopSecurity = JSON.parse(readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security;

export default defineConfig(({ command }) => ({
  plugins: [react(), devCsp(desktopSecurity.devCsp)],
  html: { cspNonce: command === 'serve' ? DEV_CSP_NONCE : undefined },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    globals: true,
    environment: 'node',
  },
}));
