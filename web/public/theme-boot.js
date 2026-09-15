/**
 * 首屏主题引导。
 *
 * 必须在样式生效之前执行，否则用户会看到一次白→黑（或黑→白）的闪烁。
 * 放在 public/ 下由 index.html 同步加载，不使用内联脚本 —— 服务端 CSP
 * 不允许 unsafe-inline。
 */
(function () {
  var KEY = 'twische.theme';
  var pref = 'auto';
  try {
    pref = localStorage.getItem(KEY) || 'auto';
  } catch (e) {
    /* 隐私模式下 localStorage 可能不可用，退回 auto */
  }
  if (pref !== 'light' && pref !== 'dark') pref = 'auto';

  var dark =
    pref === 'dark' ||
    (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
})();
