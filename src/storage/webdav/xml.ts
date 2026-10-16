/**
 * WebDAV `multistatus` 响应的极简解析。
 *
 * 只用 RFC 4918 里我们真正需要的那一小块：`multistatus / response / href / propstat / prop`，
 * 属性只取 `getetag`、`resourcetype`、`getcontentlength`、`getlastmodified`、`displayname`。
 * 不引入 XML 库：一是体积，二是命名空间前缀差异（`<D:` / `<d:` / 默认命名空间）
 * 用命名空间感知的 DOM API 处理反而比字符串匹配更可靠。
 *
 * 解析一律走 DOMParser（浏览器与 jsdom 都有，Node 侧由 CLI 自己实现 JSON 目录遍历，
 * 不依赖本模块）。
 */

/** 一个 propstat 分组：同一组状态码下的属性集合。 */
export interface DavPropStat {
  status: number;
  etag: string | null;
  isCollection: boolean;
  contentLength: number | null;
  lastModified: string | null;
  displayName: string | null;
}

export interface DavResponse {
  /** 服务器返回的原始 href（可能是绝对 URL，也可能是绝对路径） */
  href: string;
  /** 所有 propstat 分组，按响应顺序 */
  propstats: DavPropStat[];
  /** 是否存在 200 组 —— 即这个属性的读取是成功的 */
  ok: boolean;
  /** 便捷字段：取 200 组里的属性；没有 200 组时为 null */
  etag: string | null;
  isCollection: boolean;
  contentLength: number | null;
  lastModified: string | null;
  displayName: string | null;
}

export class DavXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DavXmlError';
  }
}

/** 从 `<status>HTTP/1.1 200 OK</status>` 里取状态码。 */
function parseStatus(text: string | null): number {
  if (!text) return 0;
  const m = /(\d{3})/.exec(text);
  return m ? Number(m[1]) : 0;
}

function textOf(parent: Element, ns: string, local: string): string | null {
  const el = parent.getElementsByTagNameNS(ns, local)[0];
  if (!el) return null;
  // 空元素（<D:getetag/>）与缺失元素都归一为 null，调用方不必区分
  const t = el.textContent;
  return !t ? null : t;
}

/** 解析单个 `<response>`。 */
function parseResponse(el: Element): DavResponse {
  const href = textOf(el, 'DAV:', 'href') ?? '';
  const propstats: DavPropStat[] = [];

  const groups = el.getElementsByTagNameNS('DAV:', 'propstat');
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    // status 必须取 propstat 的直接子元素，否则会误取 prop 内部嵌套的同名元素
    let statusText: string | null = null;
    for (let c = 0; c < group.children.length; c++) {
      const child = group.children[c];
      if (child.namespaceURI === 'DAV:' && child.localName === 'status') {
        statusText = child.textContent;
        break;
      }
    }
    const prop = group.getElementsByTagNameNS('DAV:', 'prop')[0] ?? null;
    propstats.push({
      status: parseStatus(statusText),
      etag: prop ? textOf(prop, 'DAV:', 'getetag') : null,
      isCollection: prop ? prop.getElementsByTagNameNS('DAV:', 'collection').length > 0 : false,
      contentLength: prop ? toNumber(textOf(prop, 'DAV:', 'getcontentlength')) : null,
      lastModified: prop ? textOf(prop, 'DAV:', 'getlastmodified') : null,
      displayName: prop ? textOf(prop, 'DAV:', 'displayname') : null,
    });
  }

  const good = propstats.find((p) => p.status === 200) ?? null;
  return {
    href,
    propstats,
    ok: good !== null,
    etag: good?.etag ?? null,
    isCollection: good?.isCollection ?? false,
    contentLength: good?.contentLength ?? null,
    lastModified: good?.lastModified ?? null,
    displayName: good?.displayName ?? null,
  };
}

function toNumber(text: string | null): number | null {
  if (text === null) return null;
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 解析 `207 Multi-Status` 响应体。
 *
 * 抛 `DavXmlError` 而不是返回空数组：拿到一坨无法解析的 HTML（典型场景是反向代理
 * 返回了错误页）时，安静返回空会被误判成「远端一条记录都没有」，进而触发全量重建并
 * 删掉本地数据 —— 这类故障必须吵闹。
 */
export function parseMultiStatus(xml: string): DavResponse[] {
  const text = xml.trim();
  if (!text) throw new DavXmlError('服务器返回了空的 multistatus 响应');

  const Parser = typeof DOMParser === 'undefined' ? null : DOMParser;
  if (!Parser) throw new DavXmlError('当前环境没有 DOMParser，无法解析 WebDAV 响应');

  const doc = new Parser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  // 解析失败时浏览器与 jsdom 都会产出一个 <parsererror> 文档，而不是抛异常
  if (root.nodeName === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
    throw new DavXmlError('服务器返回的不是合法 XML（可能被反向代理替换成了错误页）');
  }
  if (root.namespaceURI !== 'DAV:' || root.localName !== 'multistatus') {
    throw new DavXmlError(`期望 multistatus 响应，实际是 <${root.nodeName}>`);
  }

  const nodes = doc.getElementsByTagNameNS('DAV:', 'response');
  const out: DavResponse[] = [];
  for (let i = 0; i < nodes.length; i++) out.push(parseResponse(nodes[i]));
  return out;
}

/**
 * 把 href 变成可以比较的路径形式。
 *
 * 服务器可能返回绝对 URL（`https://host/dav/a.json`）、绝对路径（`/dav/a.json`）
 * 或原始相对路径，还可能带百分号编码差异（`%7C` vs `|`）。本地一律解码成
 * 「以 / 开头的规范路径」再比较，避免因为编码差异把同一个文件认成两个。
 */
export function normalizeHref(href: string, baseUrl: string): string {
  // baseUrl 指向一个目录，但 URL 解析会把不带尾斜杠的最后一段当成文件名。
  // 补上尾斜杠，相对 href 才会落在同一个目录里。
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  let path: string;
  try {
    path = new URL(href, base).pathname;
  } catch {
    path = href;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    // 非法百分号序列：保持原样，不因为一个坏 href 让整轮同步失败
    return path;
  }
}
