/**
 * Vitest 全局 setup：测试环境修补。
 *
 * - fake-indexeddb：让 idb/localrepo 在 Node 里拥有真实的 IndexedDB 实现
 * - matchMedia：jsdom 没有实现，ui store 与 PWA 逻辑依赖它
 */
import 'fake-indexeddb/auto';

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
