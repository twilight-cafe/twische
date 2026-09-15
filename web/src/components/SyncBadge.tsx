/**
 * 同步状态指示灯 + 手动同步。
 *
 * 需要表达五种状态，且必须让用户一眼分辨"在忙"与"出了问题"：
 *   同步中 / 有未上传改动 / 离线待重试 / 同步失败 / 已是最新
 */
import { syncState, syncNow } from '@/lib/sync';
import { state as repo } from '@/lib/localrepo';
import { formatRelative } from '@/lib/datetime';
import { useSyncTick } from '@/hooks/useSyncTick';
import { notify, useUiStore } from '@/stores/ui';
import Icon from './Icon';
import './SyncBadge.css';

export interface SyncBadgeProps {
  compact?: boolean;
}

export function SyncBadge({ compact = false }: SyncBadgeProps) {
  useSyncTick(); // 同步状态是 plain 对象，靠版本号驱动重渲染
  useUiStore((s) => s.online);

  let pending = 0;
  for (const r of repo.records.values()) if (r.dirty) pending++;

  let tone: 'ok' | 'busy' | 'warn' | 'error';
  if (syncState.running) tone = 'busy';
  else if (syncState.lastError) tone = 'error';
  else if (!syncState.online || pending > 0) tone = 'warn';
  else tone = 'ok';

  let label: string;
  if (syncState.running) {
    label =
      syncState.phase === 'rebuilding'
        ? '正在重建本地数据'
        : syncState.phase === 'pushing'
          ? '正在上传'
          : '正在获取更新';
  } else if (syncState.lastError) {
    label = '同步失败';
  } else if (!syncState.online) {
    label = '离线，稍后自动重试';
  } else if (pending > 0) {
    label = `${pending} 项待上传`;
  } else if (!repo.lastSyncAt) {
    label = '尚未同步';
  } else {
    label = `已同步 · ${formatRelative(repo.lastSyncAt)}`;
  }

  const iconName = syncState.running
    ? 'refresh'
    : !syncState.online || syncState.lastError
      ? 'wifi-off'
      : pending > 0
        ? 'layers'
        : 'check';

  async function manualSync() {
    if (syncState.running) return;
    const ok = await syncNow({ silent: false });
    if (ok) {
      notify.ok(
        syncState.lastConflictCount > 0
          ? `同步完成，处理了 ${syncState.lastConflictCount} 处冲突`
          : '同步完成',
        `上传 ${syncState.lastPushedCount} 条 · 获取 ${syncState.lastPulledCount} 条`,
      );
    } else if (syncState.lastError) {
      notify.error('同步未完成', syncState.lastError);
    }
  }

  return (
    <button
      className="syncer"
      data-tone={tone}
      type="button"
      title={`${label}（点击立即同步）`}
      disabled={syncState.running}
      onClick={() => void manualSync()}
    >
      <span className="syncer__icon">
        <Icon name={iconName} size={15} />
      </span>
      {!compact && <span className="syncer__label">{label}</span>}
    </button>
  );
}

export default SyncBadge;
