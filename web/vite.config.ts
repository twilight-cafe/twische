/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const INK_SRC = fileURLToPath(new URL('./node_modules/ink-design/src', import.meta.url));
const APP_SRC = fileURLToPath(new URL('./src', import.meta.url));
/** 解析源码目录里的模块 id，支持 .ts/.tsx 与目录 index 文件。 */
function resolveSource(root: string, id: string): string | undefined {
  const base = join(root, id);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * 将裸包名 ink-design 解析到已安装包内的 src/。
 * 应用与 InkUI 源码都使用 @/：按 importer 所在根目录分别解析，
 * 这样应用自己的 @/ 与 InkUI 内部的 @/ 不会互相串线。
 */
function inkDesignSourcePlugin() {
  return {
    name: 'ink-design-source',
    enforce: 'pre' as const,
    resolveId(source: string, importer: string | undefined) {
      if (source === 'ink-design') return resolveSource(INK_SRC, 'index.ts') ?? join(INK_SRC, 'index.ts');
      if (source.startsWith('@/')) {
        const id = source.slice(2);
        // 同一份源码/应用都写 @/；按 importer 决定根目录，避免两套 @ 冲突。
        if (importer && importer.includes('/node_modules/ink-design/src/')) {
          return resolveSource(INK_SRC, id);
        }
        return resolveSource(APP_SRC, id);
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [inkDesignSourcePlugin(), react()],
  optimizeDeps: {
    // 源码 alias 由本工程插件处理，不能让 esbuild 预打包时去解析 @/。
    exclude: ['ink-design'],
  },
  resolve: {
    alias: {
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
