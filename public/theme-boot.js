/**
 * 首屏主题引导。
 *
 * 必须在样式生效之前执行，否则用户会看到一次白→黑（或黑→白）的闪烁。
 * 放在 public/ 下由 index.html 同步加载，不使用内联脚本 —— 服务端 CSP
 * 不允许 unsafe-inline。
 */
(function () {
  // 键名必须与 stores/ui.ts 里的 localPrefs 前缀一致（twische.pref.<key>）。
  // v1 这里读的是 'twische.theme'，而写入方写的是 'twische.pref.theme' ——
  // 结果是深色模式每次冷启动都会闪一下白。
  var KEY = 'twische.pref.theme';
  var pref = 'auto';
  try {
    pref = JSON.parse(localStorage.getItem(KEY) || '"auto"');
  } catch (e) {
    /* 隐私模式或值损坏：退回 auto */
  }
  if (pref !== 'light' && pref !== 'dark') pref = 'auto';

  var dark =
    pref === 'dark' ||
    (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
})();
