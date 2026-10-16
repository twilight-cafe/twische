/**
 * 建立一次 WebDAV 连接：配置 + 凭据 → 可用的后端。
 *
 * 把「拼装」与「报错文案」放在这里而不是 store 里，是为了让连接向导、
 * 设置页、CLI 三条路径共用同一套判定与提示。
 */
import { DavClient, isDavError, type FetchLike } from './webdav/client';
import { WebDavStore, newStoreMeta } from './webdav/store';
import type { RemoteBackend } from './backend';
import type { DavProfile } from './credentials';
import type { DavErrorKind } from './webdav/client';

export interface ProbeSummary {
  /** 远端已有的记录文件数 */
  recordCount: number;
  /** 这次连接是否顺带创建了存储目录 */
  created: boolean;
  /** 服务器是否给出 ETag（拿不到也能用，只是并发窗口变大） */
  etagReadable: boolean;
  davClasses: string[];
}

export interface DavConnection {
  store: WebDavStore;
  client: DavClient;
  probe: ProbeSummary;
}

export interface ConnectDeps {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** 地址是否填了东西（连接向导的按钮可用性判断）。 */
export function isConnectable(profile: DavProfile): boolean {
  return profile.url.trim().length > 0 && profile.username.trim().length > 0;
}

/**
 * 连接并自检。失败时抛 `DavError`，界面直接用 `friendlyError` 转文案。
 */
export async function openDavConnection(
  profile: DavProfile,
  password: string,
  deps: ConnectDeps = {},
): Promise<DavConnection> {
  const client = new DavClient({
    url: profile.url,
    username: profile.username,
    password,
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  const store = new WebDavStore(client);
  const probe = await store.probe();
  // 首次连接写下自述文件，方便以后认出「这个目录是 Twische 的」
  if (probe.created || probe.recordCount === 0) {
    await store.writeMetaIfAbsent(newStoreMeta());
  }
  return { store, client, probe };
}

export interface FriendlyError {
  title: string;
  detail: string;
  hint: string;
}

/**
 * 把异常翻译成界面能直接显示的三段式文案。
 *
 * 跨域失败尤其重要：浏览器只会说 "Failed to fetch"，用户完全无从下手，
 * 所以这里必须把「去服务器上开 CORS」这条行动项说清楚。
 */
export function friendlyError(err: unknown): FriendlyError {
  if (isDavError(err)) {
    // 每种 kind 都必须有标题：漏掉一种就会在界面上显示成"连接失败"，
    // 而用户最需要看到的恰恰是具体原因
    const titles: Record<DavErrorKind, string> = {
      aborted: '请求已取消',
      network: '连不上这个地址',
      cors: '浏览器拦截了跨域请求',
      unauthorized: '认证失败',
      forbidden: '没有权限',
      'not-found': '路径不存在',
      precondition: '资源已被其它设备修改',
      conflict: '目录结构不对',
      server: '服务器内部错误',
      'bad-response': '服务器返回了无法理解的内容',
      'not-dav': '这个地址不支持 WebDAV',
    };
    return {
      title: titles[err.kind],
      detail: err.message,
      hint: err.hint,
    };
  }
  return {
    title: '连接失败',
    detail: err instanceof Error ? err.message : String(err),
    hint: '',
  };
}

/** 供 CLI/诊断使用：把一次探测结果渲染成几行文本。 */
export function describeProbe(probe: ProbeSummary): string[] {
  return [
    `DAV 级别：${probe.davClasses.join(', ') || '（服务器未声明）'}`,
    `远端记录数：${probe.recordCount}`,
    `ETag：${probe.etagReadable ? '可用' : '不可用（仍可同步，并发窗口略大）'}`,
    probe.created ? '已创建 Twische 存储目录' : '存储目录已存在',
  ];
}

/** 让 RemoteBackend 与 WebDavStore 的对应关系显式化（编译期检查用）。 */
export function asBackend(conn: DavConnection): RemoteBackend {
  return conn.store;
}
