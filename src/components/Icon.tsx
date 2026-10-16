/**
 * 图标适配层。
 *
 * 应用侧保留短语义名（`calendar-check` / `wifi-off` 等），实际绘制全部交给
 * ink-design 的 Icon 组件。这样图标描边、尺寸、颜色与设计系统保持一致，
 * 不再维护一套应用私有的 SVG path。
 */
import { Icon as InkIcon, type IconName as InkIconName } from 'ink-design';

export interface IconProps {
  name: string;
  size?: number | string;
  /** 线宽，默认 1.6；小尺寸图标可调粗一点以免发虚 */
  stroke?: number;
  filled?: boolean;
  className?: string;
}

/**
 * 语义名 → InkUI 图标名。
 *
 * InkUI 的图标词汇表是刻意克制的，这里做的是“同义/近义”映射：
 * 找不到完全同名图标时，选择视觉与语义最接近的一个，而不是继续自绘。
 */
const NAME_MAP: Record<string, InkIconName> = {
  alert: 'exclamationCircle',
  archive: 'folder',
  'arrow-left': 'left',
  'arrow-right': 'right',
  'calendar-check': 'calendar',
  calendar: 'calendar',
  check: 'check',
  'chevron-left': 'chevronLeft',
  'chevron-right': 'chevronRight',
  clock: 'clock',
  copy: 'copy',
  download: 'download',
  edit: 'edit',
  history: 'clock',
  inbox: 'file',
  layers: 'copy',
  lock: 'lock',
  'log-out': 'right',
  minus: 'minus',
  moon: 'star',
  'panel-left': 'menu',
  plus: 'plus',
  refresh: 'reload',
  reload: 'reload',
  repeat: 'sync',
  search: 'search',
  smartphone: 'file',
  sparkle: 'star',
  sun: 'star',
  trash: 'trash',
  'wifi-off': 'warning',
  x: 'close',
  eye: 'eye',
  'eye-off': 'eyeSlash',
  columns: 'grid',
  chart: 'list',
  grid: 'grid',
  list: 'list',
  sliders: 'settings',
  user: 'user',
};

export function Icon({
  name,
  size = 18,
  stroke = 1.6,
  filled = false,
  className,
}: IconProps) {
  const inkName = NAME_MAP[name] ?? 'infoCircle';
  const classes = ['icon', className].filter(Boolean).join(' ');

  return (
    <InkIcon
      name={inkName}
      size={size}
      className={classes}
      strokeWidth={filled ? undefined : stroke}
      {...(filled ? { fill: 'currentColor', stroke: 'none' } : {})}
    />
  );
}

export default Icon;
