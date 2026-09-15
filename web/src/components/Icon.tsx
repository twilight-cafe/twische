/**
 * 极简描边图标集（React 版）。
 *
 * 保留自绘而不是换 ink-design 的 Icon：应用需要的 wifi-off / sun / moon /
 * sparkle / layers / panel-left / archive / repeat / sliders / log-out 等
 * 约 20 个语义图标不在 ink-design 的 56 个图标词汇表里（已作为上游限制上报）。
 * 自绘统一 1.6 描边、圆头圆角，与 4px 圆角的整体调性一致，且 PWA 离线零成本。
 */
import { useMemo } from 'react';

export interface IconProps {
  name: string;
  size?: number | string;
  /** 线宽，默认 1.6；小尺寸图标可调粗一点以免发虚 */
  stroke?: number;
  filled?: boolean;
  className?: string;
}

const PATHS: Record<string, string[]> = {
  sun: [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-up': ['M18 15l-6-6-6 6'],
  'arrow-left': ['M19 12H5', 'M12 19l-7-7 7-7'],
  'arrow-right': ['M5 12h14', 'M12 5l7 7-7 7'],
  calendar: ['M3 5h18v16H3z', 'M8 3v4M16 3v4', 'M3 10h18'],
  'calendar-check': ['M3 5h18v16H3z', 'M8 3v4M16 3v4', 'M3 10h18', 'M9 15.5l2 2 4-4'],
  columns: ['M3 4h18v16H3z', 'M9 4v16', 'M15 4v16'],
  grid: ['M3 4h18v16H3z', 'M3 9.3h18', 'M3 14.7h18', 'M9 4v16', 'M15 4v16'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
  sliders: [
    'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3',
    'M1.5 14h5M9.5 8h5M17.5 16h5',
  ],
  refresh: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'],
  'wifi-off': [
    'M2 8.8a16 16 0 0 1 20 0',
    'M5.5 12.6a11.5 11.5 0 0 1 13 0',
    'M9 16.3a6.5 6.5 0 0 1 6 0',
    'M12 20h.01',
    'M2 2l20 20',
  ],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 15H6L5 6', 'M10 11v6M14 11v6'],
  edit: ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z'],
  archive: ['M3 4h18v4H3z', 'M5 8v13h14V8', 'M10 12h4'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1'],
  smartphone: ['M6 2h12v20H6z', 'M12 18h.01'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  eye: ['M2 12s3.7-7 10-7 10 7 10 7-3.7 7-10 7-10-7-10-7z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  'eye-off': [
    'M10.6 5.1A10.9 10.9 0 0 1 12 5c6.3 0 10 7 10 7a18.5 18.5 0 0 1-2.8 3.8',
    'M6.6 6.6A18.6 18.6 0 0 0 2 12s3.7 7 10 7a10.9 10.9 0 0 0 4.2-.8',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
    'M2 2l20 20',
  ],
  tag: ['M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
  lock: ['M3 11h18v11H3z', 'M7 11V7a5 5 0 0 1 10 0v4'],
  copy: ['M9 9h13v13H9z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  'log-out': ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  repeat: ['M17 1l4 4-4 4', 'M3 11V9a4 4 0 0 1 4-4h14', 'M7 23l-4-4 4-4', 'M21 13v2a4 4 0 0 1-4 4H3'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  chart: ['M18 20V10', 'M12 20V4', 'M6 20v-6'],
  inbox: [
    'M22 12h-6l-2 3h-4l-2-3H2',
    'M5.4 5.6 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.4-6.4A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.8 1.6z',
  ],
  layers: ['M12 2 2 7l10 5 10-5-10-5z', 'M2 12l10 5 10-5', 'M2 17l10 5 10-5'],
  'panel-left': ['M3 4h18v16H3z', 'M9 4v16'],
  history: ['M3 12a9 9 0 1 0 2.6-6.4', 'M3 3v6h6', 'M12 8v4l3 2'],
  sparkle: ['M12 3v4M12 17v4M3 12h4M17 12h4', 'M12 9.5 13.4 12 12 14.5 10.6 12z'],
};

/**
 * 未定义的图标名会静默回退成时钟 —— 那是个很难发现的坑（页面上出现一个
 * 语义完全不搭的图标，却没有任何报错）。开发时至少要说一声。
 */
export function Icon({ name, size = 18, stroke = 1.6, filled = false, className }: IconProps) {
  const paths = useMemo(() => {
    const p = PATHS[name];
    if (!p) {
      if (import.meta.env.DEV) console.warn(`[twische] 未定义的图标：${name}`);
      return PATHS.clock;
    }
    return p;
  }, [name]);

  const px = typeof size === 'number' ? `${size}px` : size;

  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`icon${className ? ` ${className}` : ''}`}
      style={{ display: 'block', flex: 'none', vectorEffect: 'non-scaling-stroke' }}
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export default Icon;
