/**
 * WebDAV 连接的配置与凭据。
 *
 * 分两处存：
 * - **非敏感配置**（地址、用户名）→ localStorage。启动时同步可读，用来决定
 *   首屏渲染什么，不必等 IndexedDB 打开。
 * - **密码** → IndexedDB 的 meta 表。用户选「仅本次会话」时只留在内存里，
 *   页面关掉就没了（代价是下次打开要重新输入）。
 *
 * 明文存储的风险在 UI 上明说：能物理接触这台设备的人就能读到它。
 * 缓解手段是建议用户使用**应用专用密码**（可单独吊销）而不是主密码。
 */
import { getOne, putMany } from '@/repo/idb';
import { STORE_META } from '@/repo/idb';

export interface DavProfile {
  /** 用户填写的 WebDAV 目录地址 */
  url: string;
  username: string;
  /** 是否把密码留在本机 */
  remember: boolean;
}

const PROFILE_KEY = 'twische.dav.profile';
const SECRET_META_KEY = 'davPassword';

export const EMPTY_PROFILE: DavProfile = { url: '', username: '', remember: true };

/**
 * 内存中的密码。
 *
 * - `undefined` —— 还不知道，读一次 IndexedDB
 * - `null`      —— 本次会话里已被显式清空（**不再回落到磁盘**，
 *                  否则"清除密码"在落盘失败时会立刻把旧密码读回来）
 * - `string`    —— 就是它
 */
let memoryPassword: string | null | undefined = undefined;

function safeLocalStorage(): Storage | null {
  try {
    // 隐私模式下 localStorage 可能存在但一写就抛
    const probe = '__twische_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export function loadProfile(): DavProfile {
  const ls = safeLocalStorage();
  if (!ls) return { ...EMPTY_PROFILE };
  try {
    const raw = ls.getItem(PROFILE_KEY);
    if (!raw) return { ...EMPTY_PROFILE };
    const parsed = JSON.parse(raw) as Partial<DavProfile>;
    return {
      url: typeof parsed.url === 'string' ? parsed.url : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      remember: parsed.remember !== false,
    };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export function saveProfile(profile: DavProfile): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* 存不下就只留内存，不影响本次会话 */
  }
}

export function clearProfile(): void {
  const ls = safeLocalStorage();
  try {
    ls?.removeItem(PROFILE_KEY);
  } catch {
    /* 忽略 */
  }
  // 清配置就顺手清凭据：留着一条"没有归属的密码"是纯粹的隐患，
  // 调用方（清除本机数据 / 换服务器）本来也不会想保留它。
  void clearPassword();
}

/** 读密码：先看内存，再按需从 IndexedDB 取。 */
export async function loadPassword(): Promise<string | null> {
  if (memoryPassword !== undefined) return memoryPassword;
  try {
    const row = await getOne<{ key: string; value: string }>(STORE_META, SECRET_META_KEY);
    const value = row?.value;
    if (typeof value === 'string' && value !== '') {
      memoryPassword = value;
      return value;
    }
  } catch {
    /* 读不出来就当没有，让用户重新输入 */
  }
  return null;
}

export async function savePassword(password: string, remember: boolean): Promise<void> {
  memoryPassword = password;
  try {
    await putMany(STORE_META, [{ key: SECRET_META_KEY, value: remember ? password : '' }]);
  } catch {
    /* 落盘失败不影响本次会话 */
  }
}

export async function clearPassword(): Promise<void> {
  memoryPassword = null;
  try {
    await putMany(STORE_META, [{ key: SECRET_META_KEY, value: '' }]);
  } catch {
    /* 忽略 */
  }
}

/** 仅供测试：重置内存中的密码。 */
export function __resetCredentialCacheForTest(): void {
  memoryPassword = undefined;
}
