/**
 * 纯数据转换。
 *
 * Vue 的 `reactive()` / `ref()` 会把对象包成 Proxy，而 Proxy 是不可结构化克隆的：
 * 把它交给 IndexedDB 会直接抛 DataCloneError。这个坑很隐蔽 —— 写入失败发生在
 * 事务内部，调用方一旦 catch 掉，症状就变成"界面一切正常、数据却从未落盘"，
 * 只有刷新页面或断网时才会暴露。
 *
 * 记录按设计就是纯 JSON（HTTP 线上格式同样是 JSON），因此用 JSON 往返做一次
 * 深拷贝既安全又不丢信息：读取 Proxy 的属性会得到普通值，嵌套的 ref 也一并展开。
 */

/** 深拷贝成普通对象，断开与任何响应式代理、以及调用方对象的引用关系。 */
export function toPlain<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
