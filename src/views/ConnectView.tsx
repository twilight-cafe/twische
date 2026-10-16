/**
 * 连接向导（替代 v1 的登录页与「未初始化」页）。
 *
 * 两种模式共用一套界面：
 * - `setup`    —— 从未配置过：填 WebDAV 地址、用户名、密码
 * - `password` —— 地址还在但密码没记住 / 认证失败：只补一个密码
 *
 * 失败时显示的是**结构化诊断**而不是一句"连接失败"，因为跨域被拒、地址写错、
 * 密码不对这三种情况在浏览器里长得一模一样，只有我们能替用户区分开。
 */
import { useEffect, useState } from 'react';
import { useSessionStore } from '@/stores/session';
import Icon from '@/components/Icon';
import './ConnectView.css';

interface Props {
  mode: 'setup' | 'password';
}

export default function ConnectView({ mode }: Props) {
  const profile = useSessionStore((s) => s.profile);
  const connect = useSessionStore((s) => s.connect);
  const submitPassword = useSessionStore((s) => s.submitPassword);
  const connectError = useSessionStore((s) => s.connectError);
  const connecting = useSessionStore((s) => s.connecting);

  const [url, setUrl] = useState(profile.url);
  const [username, setUsername] = useState(profile.username);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(profile.remember);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    setUrl(profile.url);
    setUsername(profile.username);
    setRemember(profile.remember);
  }, [profile.url, profile.username, profile.remember]);

  const canSubmit = password.length > 0 && !connecting && (mode === 'password' || (url.trim() && username.trim()));

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    const ok =
      mode === 'password'
        ? await submitPassword(password)
        : await connect({ url, username, password, remember });
    if (!ok) setPassword('');
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
          {mode === 'setup' ? (
            <>
              <div className="field">
                <label htmlFor="dav-url">WebDAV 地址</label>
                <input
                  id="dav-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://dav.example.com/dav/files/用户名/twische/"
                  disabled={connecting}
                  data-autofocus
                />
                <p className="hint">
                  指向一个目录即可，不存在会自动创建。填到父目录一级，别填到具体文件。
                </p>
              </div>

              <div className="field">
                <label htmlFor="dav-user">用户名</label>
                <input
                  id="dav-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  type="text"
                  autoComplete="username"
                  spellCheck={false}
                  placeholder="WebDAV 账号"
                  disabled={connecting}
                />
              </div>
            </>
          ) : (
            <div className="field">
              <label>连接的服务器</label>
              <p className="hint" style={{ marginBottom: 8 }}>
                {profile.url}
                {profile.username ? ` · ${profile.username}` : ''}
              </p>
            </div>
          )}

          <div className="field">
            <label htmlFor="dav-password">密码</label>
            <div className="pw-wrap">
              <input
                id="dav-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type={showPassword ? 'text' : 'password'}
                className="pw-input"
                autoComplete="current-password"
                placeholder="建议使用应用专用密码"
                disabled={connecting}
                data-autofocus={mode === 'password' ? true : undefined}
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

          {mode === 'setup' && (
            <label className="remember">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                disabled={connecting}
              />
              <span>在这台设备上记住密码</span>
            </label>
          )}

          <button className="btn btn--primary btn--block" type="submit" disabled={!canSubmit}>
            {!connecting && <Icon name="log-out" size={16} />}
            <span>{connecting ? '正在连接…' : mode === 'password' ? '继续' : '连接'}</span>
          </button>
        </form>

        {connectError && (
          <div className="auth__error" role="alert">
            <strong>{connectError.title}</strong>
            {connectError.hint && <p>{connectError.hint}</p>}
            {connectError.detail && <code>{connectError.detail}</code>}
          </div>
        )}

        {mode === 'setup' && (
          <p className="auth__note">
            数据直接存在你自己的 WebDAV 服务器上，不经过任何第三方。
            浏览器要求服务器允许跨域访问（CORS），失败时上面的提示会说明要补哪些响应头。
          </p>
        )}
      </div>
    </div>
  );
}
