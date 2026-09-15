/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // 向量时钟与重复规则引擎与后端共享同一份源码，避免"两端实现漂移"
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2022',
    sourcemap: false,
    // 单页应用，产物不大；不做手动分包以免缓存粒度变差
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    // 开发时把 /api 透传到后端，这样 cookie 在浏览器看来仍是同源的
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      include: ['src/lib/**', 'src/stores/**', 'src/hooks/**'],
      // 纯逻辑层 100% 覆盖是硬门槛（组件层做关键交互测试，不设阈值）
      thresholds: {
        'src/lib/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/stores/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/hooks/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
