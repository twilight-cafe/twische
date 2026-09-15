/** 提示消息。手机端浮在底部标签栏之上，桌面端浮在右下角。 */
import { useUiStore, type ToastKind } from '@/stores/ui';
import Icon from './Icon';
import './ToastHost.css';

const ICONS: Record<ToastKind, string> = {
  info: 'sparkle',
  ok: 'check',
  warn: 'alert',
  error: 'alert',
};

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismiss);

  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind}>
          <span className="toast__icon">
            <Icon name={ICONS[t.kind] || 'sparkle'} size={16} />
          </span>
          <div className="toast__text">
            <p className="toast__msg">{t.message}</p>
            {t.detail && <p className="toast__detail">{t.detail}</p>}
          </div>
          {t.action && (
            <button
              className="toast__action"
              type="button"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast__close" type="button" aria-label="关闭提示" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default ToastHost;
