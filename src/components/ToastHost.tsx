/** 提示消息。手机端浮在底部标签栏之上，桌面端浮在右下角。 */
import { Alert, Button } from 'ink-design';
import { useUiStore, type ToastKind } from '@/stores/ui';
import './ToastHost.css';

const ALERT_TYPE: Record<ToastKind, 'success' | 'info' | 'warning' | 'error'> = {
  info: 'info',
  ok: 'success',
  warn: 'warning',
  error: 'error',
};

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismiss);

  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <Alert
          key={t.id}
          className="toast"
          type={ALERT_TYPE[t.kind]}
          message={t.message}
          description={t.detail}
          closable
          onClose={() => dismiss(t.id)}
          action={
            t.action ? (
              <Button
                small
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </Button>
            ) : undefined
          }
        />
      ))}
    </div>
  );
}

export default ToastHost;
