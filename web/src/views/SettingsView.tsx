/**
 * 设置。
 *
 * 分成四页而不是拉成一条长滚动：账户、设备、同步各自牵扯不同的心理状态
 * （安全 / 信任 / 故障排查），混在一页里会让人在找一个开关时读到一堆
 * 不该在这时候出现的信息。
 */
import { useEffect, useState } from 'react';
import { useSessionStore } from '@/stores/session';
import { notify, useUiStore, uiMode, type ThemePref } from '@/stores/ui';
import { api } from '@/lib/api';
import { localPrefs, state as repo } from '@/lib/localrepo';
import { syncNow, syncState } from '@/lib/sync';
import { formatDateTime, formatRelative, todayKey } from '@/lib/datetime';
import { useSyncTick, useRepoRev } from '@/hooks/useSyncTick';
import { listTasks } from '@/stores/tasks';
import { useEditorStore } from '@/stores/editor';
import PageHead from '@/components/PageHead';
import Icon from '@/components/Icon';
import Sheet from '@/components/Sheet';
import './SettingsView.css';

type Tab = 'appearance' | 'account' | 'devices' | 'data';

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'appearance', label: '外观', icon: 'sun' },
  { id: 'account', label: '账户', icon: 'user' },
  { id: 'devices', label: '设备', icon: 'smartphone' },
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

  const account = useSessionStore((s) => s.account);
  const stats = useSessionStore((s) => s.stats);
  const devices = useSessionStore((s) => s.devices);
  const environment = useSessionStore((s) => s.environment);
  const serverVersion = useSessionStore((s) => s.serverVersion);
  const initializedAt = useSessionStore((s) => s.initializedAt);
  const deviceId = repo.deviceId;
  const passwordPromptOpen = useSessionStore((s) => s.passwordPromptOpen);
  const passwordPromptReason = useSessionStore((s) => s.passwordPromptReason);
  const changePassword = useSessionStore((s) => s.changePassword);
  const logout = useSessionStore((s) => s.logout);
  const logoutAll = useSessionStore((s) => s.logoutAll);
  const refreshAccount = useSessionStore((s) => s.refreshAccount);
  const refreshDevices = useSessionStore((s) => s.refreshDevices);
  const renameDevice = useSessionStore((s) => s.renameDevice);
  const revokeDevice = useSessionStore((s) => s.revokeDevice);
  const forgetDevice = useSessionStore((s) => s.forgetDevice);
  const submitElevation = useSessionStore((s) => s.submitPassword);
  const cancelPassword = useSessionStore((s) => s.cancelPassword);

  const themePref = useUiStore((s) => s.themePref);
  const systemDark = useUiStore((s) => s.systemDark);
  const weekStart = useUiStore((s) => s.weekStart);
  const compactHours = useUiStore((s) => s.compactHours);
  const isStandalone = useUiStore((s) => s.isStandalone);
  const canInstall = useUiStore((s) => s.canInstall);
  const online = useUiStore((s) => s.online);
  const swUpdateReady = useUiStore((s) => s.swUpdateReady);
  const setThemePref = useUiStore((s) => s.setThemePref);
  const setWeekStart = useUiStore((s) => s.setWeekStart);
  const setCompactHours = useUiStore((s) => s.setCompactHours);
  const promptInstall = useUiStore((s) => s.promptInstall);
  const applyUpdate = useUiStore((s) => s.applyUpdate);

  const mode = uiMode({ themePref, systemDark });

  const [tab, setTab] = useState<Tab>(() => localPrefs.get<Tab>('settingsTab', 'appearance'));
  function pickTab(id: Tab): void {
    setTab(id);
    localPrefs.set('settingsTab', id);
  }

  // ───────────────────────── 账户 ─────────────────────────
  const [curPassword, setCurPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  /** 与服务端一致的强度提示；真正的判定在服务端，这里只做即时反馈。 */
  const passwordHints = [
    { ok: newPassword.length >= 8, text: '至少 8 个字符' },
    {
      ok: /[a-zA-Z]/.test(newPassword) && /[0-9]/.test(newPassword),
      text: '同时包含字母与数字',
    },
    {
      ok: newPassword.length > 0 && new TextEncoder().encode(newPassword).length <= 72,
      text: '不超过 72 字节（bcrypt 上限）',
    },
  ];

  const passwordReady =
    passwordHints.every((h) => h.ok) &&
    newPassword === confirmPassword &&
    curPassword.length > 0;

  async function submitPassword(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      const { notify } = await import('@/stores/ui');
      notify.error('两次输入的新密码不一致');
      return;
    }
    setSavingPassword(true);
    const ok = await changePassword(curPassword, newPassword);
    setSavingPassword(false);
    if (ok) {
      setCurPassword('');
      setNewPassword('');
      setConfirmPassword('');
    }
  }

  async function doLogout(): Promise<void> {
    if (!window.confirm('确定要退出登录吗？本地未同步的改动会一并清除。')) return;
    await logout();
  }

  async function doLogoutAll(): Promise<void> {
    if (!window.confirm('在所有设备上退出登录？包括当前这台，其它设备需要重新输入密码。')) return;
    await logoutAll();
  }

  // ───────────────────────── 设备 ─────────────────────────
  const [renaming, setRenaming] = useState('');
  const [renameValue, setRenameValue] = useState('');

  function startRename(id: string, name: string): void {
    setRenaming(id);
    setRenameValue(name);
  }

  async function commitRename(): Promise<void> {
    const id = renaming;
    const name = renameValue.trim();
    setRenaming('');
    if (!id || !name) return;
    await renameDevice(id, name);
  }

  async function revoke(id: string, name: string): Promise<void> {
    if (!window.confirm(`让「${name}」退出登录？该设备上未同步的改动不会被上传。`)) return;
    await revokeDevice(id);
  }

  async function forget(id: string, name: string): Promise<void> {
    if (
      !window.confirm(
        `移除设备「${name}」？它记录的同步版本会一并删除，下次同步将重新拉取全量数据。`,
      )
    )
      return;
    await forgetDevice(id);
  }

  // ── 提权密码弹窗 ──
  const [elevateInput, setElevateInput] = useState('');

  function confirmElevate(): void {
    const pw = elevateInput;
    setElevateInput('');
    if (!pw) return;
    submitElevation(pw);
  }

  function dismissElevate(): void {
    setElevateInput('');
    cancelPassword();
  }

  // ───────────────────────── 同步与数据 ─────────────────────────
  const [conflicts, setConflicts] = useState<
    Array<{ recordId: string; kind: string; at: number; winner: string }>
  >([]);
  const [loadingConflicts, setLoadingConflicts] = useState(false);

  async function loadConflicts(): Promise<void> {
    setLoadingConflicts(true);
    try {
      const res = await api.conflicts(20);
      setConflicts(res.conflicts);
      if (res.conflicts.length === 0) {
        const { notify } = await import('@/stores/ui');
        notify.ok('没有冲突记录', '多端编辑尚未产生过并发修改');
      }
    } catch (err) {
      const { notify } = await import('@/stores/ui');
      notify.error('读取失败', err instanceof Error ? err.message : undefined);
    } finally {
      setLoadingConflicts(false);
    }
  }

  const [events, setEvents] = useState<
    Array<{ at: number; event: string; detail: string | null; ip: string | null }>
  >([]);
  const [loadingEvents, setLoadingEvents] = useState(false);

  async function loadEvents(): Promise<void> {
    setLoadingEvents(true);
    try {
      const res = await api.audit(20);
      setEvents(res.events);
    } catch (err) {
      notify.error('读取失败', err instanceof Error ? err.message : undefined);
    } finally {
      setLoadingEvents(false);
    }
  }

  const pending = useSessionStore.getState().countDirty();
  const recordCount = repo.records.size;

  const syncLabel = syncState.running
    ? '同步中…'
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
      notify.ok('同步完成', `上传 ${syncState.lastPushedCount} 条 · 获取 ${syncState.lastPulledCount} 条`);
      void refreshAccount();
    } else if (syncState.lastError) {
      notify.error('同步未完成', syncState.lastError);
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
    void refreshAccount();
    void refreshDevices();
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

  return (
    <>
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

          <p className="note faint">
            外观设置只保存在这台设备上，不会同步 ——
            手机与桌面的屏幕差异太大，强行一致只会让其中一边别扭。
          </p>
        </section>
      )}

      {/* ═══════════ 账户 ═══════════ */}
      {tab === 'account' && (
        <section className="pane enter">
          <div className="card group">
            <h2 className="group__title">账户信息</h2>
            <dl className="kv">
              <div className="kv__row">
                <dt>账户名</dt>
                <dd>{account?.username || '—'}</dd>
              </div>
              <div className="kv__row">
                <dt>初始化于</dt>
                <dd className="tnum">{formatDateTime(account?.createdAt)}</dd>
              </div>
              <div className="kv__row">
                <dt>密码更新于</dt>
                <dd className="tnum">{formatDateTime(account?.passwordUpdatedAt)}</dd>
              </div>
              <div className="kv__row">
                <dt>上次登录</dt>
                <dd className="tnum">{formatDateTime(account?.lastLoginAt)}</dd>
              </div>
              <div className="kv__row">
                <dt>哈希强度</dt>
                <dd className="tnum">bcrypt · {account?.passwordRounds ?? '—'} 轮</dd>
              </div>
            </dl>
          </div>

          <div className="card group">
            <h2 className="group__title">修改密码</h2>
            <p className="group__desc">修改后，其它设备的登录会话会立即失效，当前设备保持登录。</p>

            <form className="form" onSubmit={submitPassword}>
              <div className="field">
                <label htmlFor="pw-cur">当前密码</label>
                <input
                  id="pw-cur"
                  value={curPassword}
                  onChange={(e) => setCurPassword(e.target.value)}
                  type="password"
                  autoComplete="current-password"
                />
              </div>

              <div className="field">
                <label htmlFor="pw-new">新密码</label>
                <input
                  id="pw-new"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  type="password"
                  autoComplete="new-password"
                />
                {newPassword && (
                  <ul className="hints">
                    {passwordHints.map((h) => (
                      <li key={h.text} className={h.ok ? 'is-ok' : ''}>
                        <Icon name={h.ok ? 'check' : 'minus'} size={12} />
                        <span>{h.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="field">
                <label htmlFor="pw-cfm">确认新密码</label>
                <input
                  id="pw-cfm"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  type="password"
                  autoComplete="new-password"
                />
                {confirmPassword && confirmPassword !== newPassword && (
                  <p className="mismatch">两次输入不一致</p>
                )}
              </div>

              <button
                className="btn btn--primary"
                type="submit"
                disabled={!passwordReady || savingPassword}
              >
                <Icon name="lock" size={15} />
                {savingPassword ? '提交中…' : '更新密码'}
              </button>
            </form>
          </div>

          <div className="card group">
            <h2 className="group__title">会话</h2>
            <div className="actions">
              <button className="btn" type="button" onClick={() => void doLogout()}>
                <Icon name="log-out" size={15} />
                退出登录
              </button>
              <button className="btn btn--danger" type="button" onClick={() => void doLogoutAll()}>
                <Icon name="alert" size={15} />
                在所有设备退出
              </button>
            </div>
            <p className="group__foot faint">
              当前有 {stats?.activeSessions ?? 0} 个活跃会话。
            </p>
          </div>

          <div className="card group">
            <div className="group__head">
              <h2 className="group__title">最近账户事件</h2>
              <button
                className="btn btn--sm"
                type="button"
                disabled={loadingEvents}
                onClick={() => void loadEvents()}
              >
                <Icon name="history" size={14} />
                {loadingEvents ? '读取中…' : '读取'}
              </button>
            </div>
            {events.length > 0 ? (
              <ul className="events">
                {events.map((ev, i) => (
                  <li key={i} className="events__row">
                    <span className="events__at tnum">{formatDateTime(ev.at)}</span>
                    <span className="events__name">{ev.event}</span>
                    <span className="events__detail faint">{ev.detail || ev.ip || ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="group__foot faint">点击「读取」查看登录与密码变更记录。</p>
            )}
          </div>
        </section>
      )}

      {/* ═══════════ 设备 ═══════════ */}
      {tab === 'devices' && (
        <section className="pane enter">
          <div className="card group">
            <div className="group__head">
              <h2 className="group__title">已连接设备</h2>
              <button className="btn btn--sm" type="button" onClick={() => void refreshDevices()}>
                <Icon name="refresh" size={14} />
                刷新
              </button>
            </div>
            <p className="group__desc">
              每台设备用独立的向量时钟记录改动，因此可以在离线时各改各的，联网后自动合并。
            </p>

            <ul className="devices">
              {devices.map((d) => (
                <li key={d.id} className="dev">
                  <span className="dev__icon">
                    <Icon name="smartphone" size={16} />
                  </span>

                  <div className="dev__main">
                    <div className="dev__line">
                      {renaming === d.id ? (
                        <input
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="dev__input"
                          type="text"
                          maxLength={40}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void commitRename();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setRenaming('');
                            }
                          }}
                          onBlur={() => void commitRename()}
                        />
                      ) : (
                        <span className="dev__name">{d.name}</span>
                      )}
                      {d.current && <span className="dev__badge">当前设备</span>}
                      {d.activeSessions > 0 && !d.current && (
                        <span className="dev__badge dev__badge--quiet">
                          {d.activeSessions} 个会话
                        </span>
                      )}
                    </div>
                    <p className="dev__meta faint">
                      {d.platform || '未知平台'} · 最近活动 {formatRelative(d.lastSeenAt)}
                    </p>
                  </div>

                  <div className="dev__actions">
                    <button
                      className="act"
                      type="button"
                      title="重命名"
                      aria-label="重命名"
                      onClick={() => startRename(d.id, d.name)}
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    {!d.current && (
                      <button
                        className="act"
                        type="button"
                        title="让该设备退出登录"
                        aria-label="让该设备退出登录"
                        onClick={() => void revoke(d.id, d.name)}
                      >
                        <Icon name="log-out" size={15} />
                      </button>
                    )}
                    {!d.current && (
                      <button
                        className="act act--danger"
                        type="button"
                        title="移除该设备"
                        aria-label="移除该设备"
                        onClick={() => void forget(d.id, d.name)}
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <p className="group__foot faint mono">本机 ID：{deviceId.slice(0, 8)}…</p>
            <p className="group__foot faint">
              管理其它设备需要确认密码。刚刚登录过的话可以直接操作，超过 15 分钟会再问一次。
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
                <dt>同步游标</dt>
                <dd className="tnum">{repo.cursor}</dd>
              </div>
              <div className="kv__row">
                <dt>墓碑水位</dt>
                <dd className="tnum">{repo.floorSeq}</dd>
              </div>
              <div className="kv__row">
                <dt>累计冲突</dt>
                <dd className="tnum">{stats?.conflicts ?? 0}</dd>
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
              <button
                className="btn"
                type="button"
                disabled={loadingConflicts}
                onClick={() => void loadConflicts()}
              >
                <Icon name="layers" size={15} />
                查看冲突记录
              </button>
            </div>
          </div>

          {conflicts.length > 0 && (
            <div className="card group">
              <h2 className="group__title">冲突记录</h2>
              <p className="group__desc">
                同一记录在两台设备上被并发修改时，按"后写入者胜出"裁决；时钟会取并集，因此不会反复冲突。
              </p>
              <ul className="events">
                {conflicts.map((c) => (
                  <li key={c.recordId + c.at} className="events__row">
                    <span className="events__at tnum">{formatDateTime(c.at)}</span>
                    <span className="events__name">{c.kind}</span>
                    <span className="events__detail mono faint">{c.recordId.slice(0, 10)}…</span>
                    <span className="events__detail">胜出：{c.winner.slice(0, 8)}…</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
            <h2 className="group__title">数据导出</h2>
            <p className="group__desc">
              导出全部记录为 JSON（含向量时钟）。这是纯读取操作，不影响同步状态。
            </p>
            <div className="actions">
              <a className="btn" href={api.exportUrl} download>
                <Icon name="download" size={15} />
                下载 JSON
              </a>
            </div>
          </div>

          <div className="card group">
            <h2 className="group__title">关于</h2>
            <dl className="kv">
              <div className="kv__row">
                <dt>应用版本</dt>
                <dd className="tnum">{environment?.app || '—'}</dd>
              </div>
              <div className="kv__row">
                <dt>服务端版本</dt>
                <dd className="tnum">{serverVersion || '—'}</dd>
              </div>
              <div className="kv__row">
                <dt>运行时</dt>
                <dd className="tnum">{environment?.runtime || '—'}</dd>
              </div>
              <div className="kv__row">
                <dt>数据初始化于</dt>
                <dd className="tnum">{formatDateTime(initializedAt)}</dd>
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
          </div>
        </section>
      )}
      </div>

      {/* 提权确认：管理其它设备前的密码校验 */}
      <Sheet
      open={passwordPromptOpen}
      title="确认密码"
      subtitle={passwordPromptReason}
      width="420px"
      onClose={dismissElevate}
      footer={
        <>
          <button className="btn" type="button" onClick={dismissElevate}>
            取消
          </button>
          <button
            className="btn btn--primary"
            type="button"
            disabled={!elevateInput}
            onClick={confirmElevate}
          >
            确认
          </button>
        </>
      }
    >
      <form
        className="elevate"
        onSubmit={(e) => {
          e.preventDefault();
          confirmElevate();
        }}
      >
        <p className="group__desc">
          为安全起见，管理其它设备前需要重新确认你的密码。确认后 15 分钟内不必重复输入。
        </p>
        <input
          value={elevateInput}
          onChange={(e) => setElevateInput(e.target.value)}
          className="elevate__input mono"
          type="password"
          autoComplete="current-password"
          placeholder="当前密码"
          data-autofocus
        />
      </form>
    </Sheet>
    </>
  );
}

