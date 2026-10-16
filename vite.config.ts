/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
    `${base}.js`,
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

/**
 * 把版本号写进 Service Worker。
 *
 * SW 的缓存名带版本号，旧版本在 activate 时会被整体清掉；没有这个替换，
 * 每次发版都会留下一个同名缓存，"更新后仍然是旧页面"就会变成常态。
 * v1 由 build.py 干这件事，现在前端自己负责。
 */
function stampServiceWorkerPlugin() {
  let outDir = 'dist';
  return {
    name: 'stamp-sw-version',
    configResolved(config: { build: { outDir: string } }) {
      outDir = config.build.outDir;
    },
    // closeBundle 是唯一能覆盖 public/ 拷贝产物的时机：
    // public 下的文件不经过 rollup，generateBundle 里根本看不到它们。
    closeBundle() {
      const file = join(process.cwd(), outDir, 'sw.js');
      if (!existsSync(file)) return;
      const source = readFileSync(file, 'utf8');
      // 用构建时间戳：资源文件名已经带内容哈希了，这里只需要"每次发版都不同"
      writeFileSync(file, source.replace(/__TWISCHE_VERSION__/g, `twische-${Date.now().toString(36)}`));
    },
  };
}

export default defineConfig({
  // 静态托管常常落在子路径下（GitHub Pages / 对象存储前缀），因此 base 必须可配。
  // 用 NXT_BASE=/twische/ npm run build 即可产出子路径版本的产物。
  base: process.env.NXT_BASE || '/',
  plugins: [inkDesignSourcePlugin(), react(), stampServiceWorkerPlugin()],
  optimizeDeps: {
    // 源码 alias 由本工程插件处理，不能让 esbuild 预打包时去解析 @/。
    exclude: ['ink-design'],
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5273,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx,js}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      include: [
        'src/lib/**',
        'src/stores/**',
        'src/hooks/**',
        'src/domain/**',
        'src/storage/**',
        'src/repo/**',
        // CLI 迁移工具是用户把数据搬过来的唯一路径，同样按纯逻辑层要求覆盖
        'src/cli/**',
      ],
      // 纯类型声明文件没有可执行代码，v8 会把 0/0 记成 0%
      exclude: ['src/storage/backend.ts'],
      // 纯逻辑层 100% 覆盖是硬门槛（组件层做关键交互测试，不设阈值）
      thresholds: {
        'src/lib/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/stores/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/hooks/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/domain/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/storage/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/repo/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
