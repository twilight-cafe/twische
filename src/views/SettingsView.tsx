/**
 * 设置。
 *
 * 分成四页而不是拉成一条长滚动：外观、连接、本机、数据各自牵扯不同的心理状态
 * （习惯 / 信任 / 身份 / 故障排查），混在一页里会让人在找一个开关时读到一堆
 * 不该在这时候出现的信息。
 *
 * 与原版的差别：账户页（改密码、审计）与设备页（吊销会话）都是服务端功能，
 * 在无后端架构里没有对应物，替换为「连接」（WebDAV 配置）与「本机」（向量时钟分量）。
 */
import { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '@/stores/session';
import { notify, useUiStore, uiMode, type ThemePref } from '@/stores/ui';
import {
  knownDevices,
  localVector,
  state as repo,
  setDeviceName,
  wipeLocal,
} from '@/repo/localrepo';
import { conflictTotal, syncNow, syncState } from '@/repo/sync';
import { buildExport, downloadExport, importRecords, parseExport } from '@/repo/transfer';
import { formatDateTime, formatRelative, todayKey } from '@/domain/datetime';
import { useSyncTick, useRepoRev } from '@/hooks/useSyncTick';
import { listTasks, collectNotifySource } from '@/stores/tasks';
import { notifyPrefs, notificationEnv, useNotifyStore, NOTIFY_MAX_LINES_RANGE } from '@/stores/notifyPrefs';
import { currentChannel } from '@/lib/notifyChannel';
import { notifyRuntime } from '@/lib/notifyRuntime';
import { buildNotificationPlan } from '@/domain/notifyPlan';
import { useEditorStore } from '@/stores/editor';
import { Alert, Switch } from 'ink-design';
import PageHead from '@/components/PageHead';
import Icon from '@/components/Icon';
import './SettingsView.css';

type Tab = 'appearance' | 'connection' | 'device' | 'data';

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'appearance', label: '外观', icon: 'sun' },
  { id: 'connection', label: '连接', icon: 'link' },
  { id: 'device', label: '本机', icon: 'smartphone' },
  { id: 'data', label: '同步与数据', icon: 'layers' },
];

const themeOptions: Array<{ v: ThemePref; label: string; icon: string }> = [
  { v: 'auto', label: '跟随系统', icon: 'sparkle' },
  { v: 'light', label: '浅色', icon: 'sun' },
  { v: 'dark', label: '深色', icon: 'moon' },
];

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function SettingsView() {
  useSyncTick();
  useRepoRev();

  const profile = useSessionStore((s) => s.profile);
  const probe = useSessionStore((s) => s.probe);
  const connect = useSessionStore((s) => s.connect);
  const disconnect = useSessionStore((s) => s.disconnect);
  const disconnectAndWipe = useSessionStore((s) => s.disconnectAndWipe);
  const refreshProbe = useSessionStore((s) => s.refreshProbe);
  const connecting = useSessionStore((s) => s.connecting);

  const themePref = useUiStore((s) => s.themePref);
  const systemDark = useUiStore((s) => s.systemDark);
  const weekStart = useUiStore((s) => s.weekStart);
  const compactHours = useUiStore((s) => s.compactHours);
  const isStandalone = useUiStore((s) => s.isStandalone);
  const canInstall = useUiStore((s) => s.canInstall);
  const online = useUiStore((s) => s.online);
  const swUpdateReady = useUiStore((s) => s.swUpdateReady);
  const notifyEnabled = useNotifyStore((s) => s.enabled);
  const notifyWhileVisible = useNotifyStore((s) => s.showWhileVisible);
  const notifyMaxLines = useNotifyStore((s) => s.maxLines);
  const notifyPermission = useNotifyStore((s) => s.permission);
  const setNotifyPrefs = useNotifyStore((s) => s.setPrefs);
  const setNotifyPermission = useNotifyStore((s) => s.setPermission);

  const setThemePref = useUiStore((s) => s.setThemePref);
  const setWeekStart = useUiStore((s) => s.setWeekStart);
  const setCompactHours = useUiStore((s) => s.setCompactHours);
  const promptInstall = useUiStore((s) => s.promptInstall);
  const applyUpdate = useUiStore((s) => s.applyUpdate);

  const mode = uiMode({ themePref, systemDark });

  /**
   * 权限对表。
   *
   * 浏览器：同步读 Notification.permission。
   * 壳内：WebView 没有 Notifications API，只能让原生通道重读一次
   * （reconcile 的回调会把结果写进 store）。**不能**用 WebView 的 API 值去覆盖它，
   * 否则用户从系统设置里授权回来，界面反而会显示成"已拒绝"。
   */
  useEffect(() => {
    const sync = () => {
      const channel = currentChannel((p) => setNotifyPermission(p));
      if (channel.reconcile) {
        channel.reconcile();
        return;
      }
      const env = notificationEnv();
      if (env !== 'unsupported') setNotifyPermission(env);
    };
    sync();
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [setNotifyPermission]);

  /** 现在切到状态栏会显示什么。空仓库时给一句解释，而不是空白。 */
  const notifyPreview = buildNotificationPlan(collectNotifySource(), Date.now(), notifyMaxLines)
    .body.split('\n')
    .filter(Boolean);

  /** 打开开关时顺手申请权限 —— 用户点开关本身就是明确的意图。 */
  async function toggleNotify(next: boolean): Promise<void> {
    setNotifyPrefs({ enabled: next });

    const runtime = notifyRuntime();
    if (!next) {
      // 关掉就要立刻从状态栏消失：只改偏好的话，那条常驻通知会一直挂着
      runtime?.reconcile();
      return;
    }
    // 打开也立刻生效，不让用户等下一次分钟脉冲
    runtime?.reconcile();

    const permission = runtime
      ? await runtime.requestPermission()
      : await currentChannel().request();
    if (permission !== 'unsupported') setNotifyPermission(permission);
    if (permission === 'denied') {
      notify.warn('系统拒绝了通知权限', '请在浏览器或系统设置里为本站开启通知后重试');
    } else if (permission === 'granted') {
      notify.ok('已开启', '有逾期或今日未完成的事项时会挂在状态栏');
    }
  }

  const [tab, setTab] = useState<Tab>(() => localPrefsTab());
  function pickTab(id: Tab): void {
    setTab(id);
    try {
      localStorage.setItem('twische.pref.settingsTab', JSON.stringify(id));
    } catch {
      /* 忽略 */
    }
  }

  // ───────────────────────── 连接 ─────────────────────────
  const [url, setUrl] = useState(profile.url);
  const [username, setUsername] = useState(profile.username);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(profile.remember);

  useEffect(() => {
    setUrl(profile.url);
    setUsername(profile.username);
    setRemember(profile.remember);
  }, [profile.url, profile.username, profile.remember]);

  async function saveConnection(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const ok = await connect({
      url,
      username,
      // 留空表示「沿用已保存的密码」——否则每次改地址都要重敲一遍密码
      password: password || ' ',
      remember,
    });
    if (ok) {
      setPassword('');
      notify.ok('连接已更新');
    }
  }

  async function doDisconnect(): Promise<void> {
    if (!window.confirm('断开与 WebDAV 的连接？本地数据会保留，可以随时重新连接。')) return;
    await disconnect();
  }

  async function doWipe(): Promise<void> {
    if (
      !window.confirm(
        '清除本机数据？这会删掉本机缓存的全部任务与连接配置，远端服务器上的数据不受影响。',
      )
    )
      return;
    await disconnectAndWipe();
  }

  // ───────────────────────── 本机 ─────────────────────────
  const [deviceNameInput, setDeviceNameInput] = useState(repo.deviceName);
  useEffect(() => {
    setDeviceNameInput(repo.deviceName);
  }, [repo.deviceName]);

  const clocks = knownDevices();

  // ───────────────────────── 同步与数据 ─────────────────────────
  const pending = repo.records.size > 0 ? countDirtyLocal() : 0;
  const recordCount = repo.records.size;

  const syncLabel = syncState.running
    ? '同步中…'
    : syncState.unconfigured
      ? '未连接'
      : syncState.lastError
        ? '上次同步失败'
        : !syncState.online
          ? '当前离线'
          : pending > 0
            ? `${pending} 项待上传`
            : '已是最新';

  const syncTone = syncState.running
    ? 'busy'
    : syncState.lastError || !syncState.online
      ? 'warn'
      : 'ok';

  async function manualSync(): Promise<void> {
    const ok = await syncNow({ silent: false });
    if (ok) {
      notify.ok(
        '同步完成',
        `上传 ${syncState.lastPushedCount} 条 · 获取 ${syncState.lastPulledCount} 条` +
          (syncState.lastRemovedCount > 0 ? ` · 清理 ${syncState.lastRemovedCount} 条` : ''),
      );
      void refreshProbe();
    } else if (syncState.unconfigured) {
      notify.error('尚未连接 WebDAV', '请先在「连接」里填写服务器地址');
    } else if (syncState.lastError) {
      notify.error('同步未完成', syncState.lastError);
    }
  }

  const fileInput = useRef<HTMLInputElement>(null);

  function doExport(): void {
    downloadExport(buildExport());
    notify.ok('已导出', `${recordCount} 条记录`);
  }

  async function doImport(file: File): Promise<void> {
    try {
      const parsed = parseExport(await file.text());
      const { imported } = await importRecords(parsed.records);
      notify.ok(
        '导入完成',
        `${imported} 条记录已加入待上传队列` +
          (parsed.skipped.length > 0 ? ` · 跳过 ${parsed.skipped.length} 条` : ''),
      );
      void syncNow({ silent: true });
    } catch (err) {
      notify.error('导入失败', err instanceof Error ? err.message : undefined);
    }
  }

  /** 浏览器给出的存储占用；隐私模式下可能不可用。 */
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);

  const storageText = (() => {
    if (!storage) return '不可用';
    const { usage, quota } = storage;
    if (!quota) return '不可用';
    return `${formatBytes(usage)} / ${formatBytes(quota)}（${Math.round((usage / quota) * 100)}%）`;
  })();

  const installHint = isStandalone
    ? '已作为独立应用运行'
    : canInstall
      ? '可安装到本机，离线也能打开'
      : '用浏览器的「添加到主屏幕 / 安装应用」也可以装成 App';

  useEffect(() => {
    void refreshProbe();
    if (navigator.storage?.estimate) {
      navigator.storage
        .estimate()
        .then((est) => {
          setStorage({ usage: est.usage ?? 0, quota: est.quota ?? 0 });
        })
        .catch(() => {
          setStorage(null);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const conflicts = conflictTotal();

  return (
    <div className="settings">
      <PageHead
        title="设置"
        actions={
          <button
            className="btn btn--sm"
            type="button"
            onClick={() => useEditorStore.getState().openCreate()}
          >
            <Icon name="plus" size={15} />
            新建任务
          </button>
        }
      />

      {/* ── 分页 ── */}
      <nav className="tabs" aria-label="设置分类">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tabs__btn${tab === t.id ? ' is-on' : ''}`}
            onClick={() => pickTab(t.id)}
          >
            <Icon name={t.icon} size={15} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {/* ═══════════ 外观 ═══════════ */}
      {tab === 'appearance' && (
        <section className="pane enter">
          <div className="card group">
            <h2 className="group__title">主题</h2>
            <p className="group__desc">
              深浅两套配色都由同一组墨白基色推导，切换不会丢失信息层级。
            </p>
            <div className="choice">
              {themeOptions.map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  className={`choice__btn${themePref === opt.v ? ' is-on' : ''}`}
                  onClick={() => setThemePref(opt.v)}
                >
                  <Icon name={opt.icon} size={16} />
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="group__foot faint">
              当前生效：{mode === 'dark' ? '深色' : '浅色'}
              {themePref === 'auto' && (
                <>（由系统偏好决定，系统当前为{systemDark ? '深色' : '浅色'}）</>
              )}
            </p>
          </div>

          <div className="card group">
            <h2 className="group__title">一周从哪天开始</h2>
            <div className="choice">
              <button
                type="button"
                className={`choice__btn${weekStart === 1 ? ' is-on' : ''}`}
                onClick={() => setWeekStart(1)}
              >
                周一
              </button>
              <button
                type="button"
                className={`choice__btn${weekStart === 0 ? ' is-on' : ''}`}
                onClick={() => setWeekStart(0)}
              >
                周日
              </button>
            </div>
          </div>

          <div className="card group">
            <h2 className="group__title">周视图行高</h2>
            <p className="group__desc">
              紧凑模式一屏能看到更多时段，适合白天日程密集时使用。
            </p>
            <div className="choice">
              <button
                type="button"
                className={`choice__btn${!compactHours ? ' is-on' : ''}`}
                onClick={() => setCompactHours(false)}
              >
                舒适 · 60px
              </button>
              <button
                type="button"
                className={`choice__btn${compactHours ? ' is-on' : ''}`}
                onClick={() => setCompactHours(true)}
              >
                紧凑 · 44px
              </button>
            </div>
          </div>

          <div className="card group">
            <h2 className="group__title">状态栏通知</h2>
            <p className="group__desc">
              有逾期事项、或今天还有没做完的（包括还没到时间的）时，
              把清单挂在系统状态栏上。做完最后一项就自动撤掉。
            </p>

            {notifyPermission === 'unsupported' ? (
              <p className="group__foot faint">
                当前环境不支持通知。iOS 需要先把 Twische 添加到主屏幕，
                再从主屏幕打开，才能获得通知权限。
              </p>
            ) : (
              <>
                <label className="check">
                  <Switch checked={notifyEnabled} onChange={(e) => void toggleNotify(e.target.checked)} />
                  <span>开启通知</span>
                </label>

                {notifyPermission === 'denied' && (
                  <Alert
                    type="warning"
                    message="系统已拒绝通知权限"
                    description="浏览器不会再弹申请框，需要在系统或浏览器设置里为本站手动允许，然后回到这里重新打开开关。"
                  />
                )}

                {notifyEnabled && (
                  <>
                    <label className="check">
                      <Switch
                        checked={notifyWhileVisible}
                        onChange={(e) => setNotifyPrefs({ showWhileVisible: e.target.checked })}
                      />
                      <span>App 开着的时候也提醒</span>
                    </label>

                    <div className="choice">
                      {[3, 5, 8, 12].map((n) => (
                        <button
                          key={n}
                          type="button"
                          className={`choice__btn${notifyMaxLines === n ? ' is-on' : ''}`}
                          onClick={() => setNotifyPrefs({ maxLines: n })}
                        >
                          最多 {n} 行
                        </button>
                      ))}
                    </div>

                    <div className="notify-preview">
                      <span className="notify-preview__label faint">现在会显示</span>
                      {notifyPreview.length === 0 ? (
                        <p className="notify-preview__empty">没有逾期，今天也清空了 —— 此刻不会有通知。</p>
                      ) : (
                        <pre className="notify-preview__body">{notifyPreview.join('\n')}</pre>
                      )}
                    </div>
                  </>
                )}
              </>
            )}

            <p className="group__foot faint">
              行数可在 {NOTIFY_MAX_LINES_RANGE.min}–{NOTIFY_MAX_LINES_RANGE.max} 之间调整；
              超出的事项会归并成一行计数。通知开关只保存在这台设备上。
            </p>
          </div>

          <p className="note faint">
            外观设置只保存在这台设备上，不会同步 ——
            手机与桌面的屏幕差异太大，强行一致只会让其中一边别扭。
          </p>
        </section>
      )}

      {/* ═══════════ 连接 ═══════════ */}
      {tab === 'connection' && (
        <section className="pane enter">
          <div className="card group">
            <h2 className="group__title">WebDAV 服务器</h2>
            <p className="group__desc">
              所有数据以 JSON 文件存在这个目录里（<code className="mono">twische/records/</code>），
              换任何支持 WebDAV 的服务器都能继续用。
            </p>

            <form className="form" onSubmit={saveConnection}>
              <div className="field">
                <label htmlFor="set-url">地址</label>
                <input
                  id="set-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  type="url"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://dav.example.com/dav/files/用户名/twische/"
                />
              </div>

              <div className="field">
                <label htmlFor="set-user">用户名</label>
                <input
                  id="set-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  type="text"
                  spellCheck={false}
                  autoComplete="username"
                />
              </div>

              <div className="field">
                <label htmlFor="set-pass">密码</label>
                <input
                  id="set-pass"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete="current-password"
                  placeholder="留空则沿用已保存的密码"
                />
                <p className="hint">
                  密码以明文保存在本机 IndexedDB 里。建议使用**应用专用密码**，
                  这样即使设备丢失也能单独吊销。
                </p>
              </div>

              <label className="check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>在这台设备上记住密码（关闭后每次打开都需要重新输入）</span>
              </label>

              <div className="actions">
                <button className="btn btn--primary" type="submit" disabled={connecting}>
                  <Icon name="check" size={15} />
                  {connecting ? '连接中…' : '保存并测试'}
                </button>
                <button className="btn" type="button" onClick={() => void doDisconnect()}>
                  <Icon name="log-out" size={15} />
                  断开连接
                </button>
              </div>
            </form>
          </div>

          {probe && (
            <div className="card group">
              <h2 className="group__title">服务器状态</h2>
              <dl className="kv">
                <div className="kv__row">
                  <dt>DAV 级别</dt>
                  <dd className="tnum">{probe.davClasses.join(', ') || '未声明'}</dd>
                </div>
                <div className="kv__row">
                  <dt>远端记录</dt>
                  <dd className="tnum">{probe.recordCount} 条</dd>
                </div>
                <div className="kv__row">
                  <dt>ETag</dt>
                  <dd>{probe.etagReadable ? '可用' : '不可用（仍可同步，并发窗口略大）'}</dd>
                </div>
              </dl>
              <div className="actions">
                <button className="btn btn--sm" type="button" onClick={() => void refreshProbe()}>
                  <Icon name="refresh" size={14} />
                  重新探测
                </button>
              </div>
            </div>
          )}

          <div className="card group">
            <h2 className="group__title">危险操作</h2>
            <p className="group__desc">
              清除本机数据只影响这台设备上缓存的副本；远端服务器上的记录不会被删除。
            </p>
            <div className="actions">
              <button className="btn btn--danger" type="button" onClick={() => void doWipe()}>
                <Icon name="trash" size={15} />
                清除本机数据
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ═══════════ 本机 ═══════════ */}
      {tab === 'device' && (
        <section className="pane enter">
          <div className="card group">
            <h2 className="group__title">本机名称</h2>
            <p className="group__desc">只用于区分多台设备，会写进每次修改的向量时钟里。</p>
            <div className="field">
              <input
                value={deviceNameInput}
                onChange={(e) => setDeviceNameInput(e.target.value)}
                type="text"
                maxLength={40}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setDeviceName(deviceNameInput.trim() || repo.deviceName);
                    notify.ok('已重命名');
                  }
                }}
                onBlur={() => {
                  const next = deviceNameInput.trim();
                  if (next && next !== repo.deviceName) setDeviceName(next);
                }}
              />
            </div>
            <p className="group__foot faint mono">本机 ID：{repo.deviceId.slice(0, 8)}…</p>
          </div>

          <div className="card group">
            <h2 className="group__title">参与同步的设备</h2>
            <p className="group__desc">
              每台设备用独立的向量时钟记录改动，因此可以离线各改各的，联网后自动合并。
              下面是本机记录里出现过的时钟分量。
            </p>
            <ul className="devices">
              {clocks.map((c) => (
                <li key={c.id} className="dev">
                  <span className="dev__icon">
                    <Icon name="clock" size={16} />
                  </span>
                  <div className="dev__main">
                    <div className="dev__line">
                      <span className="dev__name mono">{c.id.slice(0, 8)}…</span>
                      {c.id === repo.deviceId && <span className="dev__badge">本机</span>}
                    </div>
                    <p className="dev__meta faint">已记录 {c.counter} 次改动</p>
                  </div>
                </li>
              ))}
              {clocks.length === 0 && <p className="group__foot faint">还没有任何记录。</p>}
            </ul>
            <p className="group__foot faint">
              本机时钟总量：{Object.keys(localVector()).length} 个分量
            </p>
          </div>
        </section>
      )}

      {/* ═══════════ 同步与数据 ═══════════ */}
      {tab === 'data' && (
        <section className="pane enter">
          <div className="card group">
            <div className="group__head">
              <h2 className="group__title">同步状态</h2>
              <span className="tone" data-tone={syncTone}>
                {syncLabel}
              </span>
            </div>

            <dl className="kv">
              <div className="kv__row">
                <dt>最后成功同步</dt>
                <dd className="tnum">{formatRelative(repo.lastSyncAt)}</dd>
              </div>
              <div className="kv__row">
                <dt>本地待上传</dt>
                <dd className="tnum">{pending} 项</dd>
              </div>
              <div className="kv__row">
                <dt>本地记录</dt>
                <dd className="tnum">{recordCount} 条</dd>
              </div>
              <div className="kv__row">
                <dt>本次会话冲突</dt>
                <dd className="tnum">{conflicts} 次</dd>
              </div>
            </dl>

            {syncState.lastError && <p className="error-line">{syncState.lastError}</p>}

            <div className="actions">
              <button
                className="btn btn--primary"
                type="button"
                disabled={syncState.running}
                onClick={() => void manualSync()}
              >
                <Icon name="refresh" size={15} />
                {syncState.running ? '同步中…' : '立即同步'}
              </button>
            </div>

            {conflicts > 0 && (
              <p className="group__foot faint">
                同一记录在两台设备上被并发修改时，按「后写入者胜出」裁决；时钟会取并集，
                因此不会反复冲突。冲突期间两边的内容都不会丢，本地版本优先。
              </p>
            )}
          </div>

          <div className="card group">
            <h2 className="group__title">离线与安装</h2>
            <dl className="kv">
              <div className="kv__row">
                <dt>网络</dt>
                <dd>{online ? '在线' : '离线（改动会暂存本地，恢复后自动上传）'}</dd>
              </div>
              <div className="kv__row">
                <dt>安装状态</dt>
                <dd>{installHint}</dd>
              </div>
              <div className="kv__row">
                <dt>本地存储占用</dt>
                <dd className="tnum">{storageText}</dd>
              </div>
            </dl>
            <div className="actions">
              {canInstall && (
                <button className="btn btn--primary" type="button" onClick={() => void promptInstall()}>
                  <Icon name="download" size={15} />
                  安装到桌面
                </button>
              )}
              {swUpdateReady && (
                <button className="btn" type="button" onClick={applyUpdate}>
                  <Icon name="sparkle" size={15} />
                  有新版本，立即更新
                </button>
              )}
            </div>
          </div>

          <div className="card group">
            <h2 className="group__title">导出与导入</h2>
            <p className="group__desc">
              导出为 JSON（含向量时钟），格式与旧版服务端的导出完全一致，
              可以直接喂给迁移工具；导入的记录会加入待上传队列，由下一次同步推到服务器。
            </p>
            <div className="actions">
              <button className="btn" type="button" onClick={doExport}>
                <Icon name="download" size={15} />
                导出 JSON
              </button>
              <button className="btn" type="button" onClick={() => fileInput.current?.click()}>
                <Icon name="upload" size={15} />
                导入 JSON
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void doImport(file);
                }}
              />
            </div>
          </div>

          <div className="card group">
            <h2 className="group__title">关于</h2>
            <dl className="kv">
              <div className="kv__row">
                <dt>应用版本</dt>
                <dd className="tnum">{APP_VERSION}</dd>
              </div>
              <div className="kv__row">
                <dt>运行方式</dt>
                <dd className="tnum">纯静态页面 + WebDAV</dd>
              </div>
              <div className="kv__row">
                <dt>今天</dt>
                <dd className="tnum">{todayKey()}</dd>
              </div>
              <div className="kv__row">
                <dt>任务总数</dt>
                <dd className="tnum">{listTasks().length}</dd>
              </div>
            </dl>
            <p className="group__foot faint">
              没有自建后端：页面是纯静态的，所有数据都在你自己的 WebDAV 服务器上。
            </p>
          </div>
        </section>
      )}
    </div>
  );
}

const APP_VERSION = '2.0.0';

function localPrefsTab(): Tab {
  try {
    const raw = localStorage.getItem('twische.pref.settingsTab');
    const value = raw ? (JSON.parse(raw) as Tab) : 'appearance';
    return TABS.some((t) => t.id === value) ? value : 'appearance';
  } catch {
    return 'appearance';
  }
}

function countDirtyLocal(): number {
  let n = 0;
  for (const r of repo.records.values()) if (r.dirty) n++;
  return n;
}
