/**
 * 登录页。
 *
 * 单账户自托管场景下没有"用户名"，所以只需要一个密码框。
 * 但要把三件事说清楚：设备名（用于多端识别）、锁定倒计时、以及"数据存在你自己的服务器上"。
 */
import { useEffect, useState } from 'react';
import { useSessionStore } from '@/stores/session';
import { state as repo, setDeviceName } from '@/lib/localrepo';
import Icon from '@/components/Icon';
import './LoginView.css';

export default function LoginView() {
  const login = useSessionStore((s) => s.login);
  const retryAfterSec = useSessionStore((s) => s.retryAfterSec);

  const [password, setPassword] = useState('');
  const [deviceNameInput, setDeviceNameInput] = useState(repo.deviceName);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const canSubmit = password.length > 0 && !submitting && cooldown === 0;

  useEffect(() => {
    setDeviceNameInput(repo.deviceName);
    const timer = setInterval(() => {
      setCooldown((c) => (c > 0 ? c - 1 : c));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);

    const name = deviceNameInput.trim();
    if (name && name !== repo.deviceName) setDeviceName(name.slice(0, 60));

    const ok = await login(password);
    setSubmitting(false);

    if (!ok) {
      setPassword('');
      // 被锁定/限流时用服务端给出的真实秒数倒计时。
      // 写死一个数字会让用户在第 61 秒继续失败，反而加重失败计数。
      if (retryAfterSec > 0) {
        setCooldown(retryAfterSec);
      }
    }
  }

  return (
    <div className="auth">
      <div className="auth__card enter">
        <div className="auth__mark">
          <span className="auth__t">T</span>
          <span className="auth__dot" />
        </div>

        <h1 className="auth__title">Twische</h1>
        <p className="auth__sub">以代码为笔，以时间为墨</p>

        <form className="auth__form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="login-password">访问密码</label>
            <div className="pw-wrap">
              <input
                id="login-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={showPassword ? 'text' : 'password'}
                className="pw-input"
                autoComplete="current-password"
                placeholder="请输入密码"
                disabled={submitting}
                data-autofocus
              />
              <button
                className="pw-toggle"
                type="button"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                title={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword(!showPassword)}
              >
                <Icon name={showPassword ? 'eye-off' : 'eye'} size={15} />
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="device-name">本设备名称</label>
            <input
              id="device-name"
              value={deviceNameInput}
              onChange={(e) => setDeviceNameInput(e.target.value)}
              type="text"
              maxLength={60}
              placeholder="例如：我的笔记本"
              disabled={submitting}
            />
            <p className="hint">用于在设置里分辨多台设备，只在本地与你的服务器之间使用。</p>
          </div>

          <button className="btn btn--primary btn--block" type="submit" disabled={!canSubmit}>
            {!submitting && <Icon name="log-out" size={16} />}
            <span>{cooldown > 0 ? `请等待 ${cooldown} 秒` : submitting ? '正在验证…' : '进入'}</span>
          </button>
        </form>

        <p className="auth__note">所有日程数据都保存在你自己的服务器上，不经过任何第三方。</p>
      </div>
    </div>
  );
}
