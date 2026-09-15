/**
 * 服务端未初始化。
 *
 * 这是唯一一个"前端帮不上忙"的状态：密码哈希必须由服务端写入 SQLite。
 * 所以页面唯一有价值的产出就是**能直接复制走的那条命令** ——
 * 不给模糊的"请联系管理员"，也不假装能用界面初始化。
 */
import { useMemo, useState } from 'react';
import Icon from '@/components/Icon';
import './NotInitializedView.css';

export interface NotInitializedViewProps {
  version?: string;
}

export default function NotInitializedView({ version }: NotInitializedViewProps) {
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const [revealPassword, setRevealPassword] = useState(false);

  /**
   * 命令里的密码需要加引号转义：shell 里带空格或特殊字符的密码
   * 不加引号会被拆成多个参数，用户会收到一个莫名其妙的错误。
   */
  const command = useMemo(() => {
    const pw = password;
    if (!pw) return 'twische init --password-stdin < 密码文件';
    const escaped = pw.includes("'") ? `'${pw.replace(/'/g, `'\\''`)}'` : `'${pw}'`;
    return `twische init --password ${escaped}`;
  }, [password]);

  const useStdin = password.length === 0;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 非安全上下文下剪贴板不可用，用户可手动选中 */
    }
  }

  return (
    <div className="init">
      <div className="init__card enter">
        <div className="init__head">
          <span className="init__badge">
            <Icon name="lock" size={18} />
          </span>
          <div>
            <h1 className="init__title">实例尚未初始化</h1>
            <p className="init__sub">
              Twische 的密码必须由服务端写入本地数据库，因此需要你在服务器上执行一次初始化。
            </p>
          </div>
        </div>

        <ol className="steps">
          <li className="step">
            <span className="step__no">1</span>
            <div className="step__body">
              <p className="step__title">在项目目录执行初始化命令</p>
              <p className="step__desc">
                密码会以 bcrypt 哈希（代价因子 12）存入 SQLite，明文不落盘、不写日志。
                未完成这一步，服务端口会拒绝启动。
              </p>

              <div className="cmd">
                <code className="cmd__text mono">{command}</code>
                <button
                  className="cmd__copy"
                  type="button"
                  title={copied ? '已复制' : '复制命令'}
                  onClick={() => void copy()}
                >
                  <Icon name={copied ? 'check' : 'copy'} size={15} />
                </button>
              </div>

              <div className="init__pw">
                <label className="init__pw-label" htmlFor="init-pw">
                  在此填入你打算设置的密码（仅用于生成本页命令，不会被发送到任何地方）
                </label>
                <div className="init__pw-row">
                  <input
                    id="init-pw"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type={revealPassword ? 'text' : 'password'}
                    placeholder="留空则生成 --password-stdin 形式"
                    autoComplete="new-password"
                  />
                  <button
                    className="btn btn--sm"
                    type="button"
                    onClick={() => setRevealPassword(!revealPassword)}
                  >
                    {revealPassword ? '隐藏' : '显示'}
                  </button>
                </div>
                {!useStdin && (
                  <p className="init__warn">
                    <Icon name="alert" size={13} />
                    <span>
                      用 <code className="mono">--password</code> 传参会留在 shell 历史与进程列表里。
                      更安全的做法是把密码写进文件后用{' '}
                      <code className="mono">--password-stdin</code> 传入。
                    </span>
                  </p>
                )}
              </div>
            </div>
          </li>

          <li className="step">
            <span className="step__no">2</span>
            <div className="step__body">
              <p className="step__title">启动服务</p>
              <div className="cmd">
                <code className="cmd__text mono">twische serve</code>
              </div>
              <p className="step__desc">启动后刷新本页即可登录。</p>
            </div>
          </li>

          <li className="step">
            <span className="step__no">3</span>
            <div className="step__body">
              <p className="step__title">在这台设备上登录</p>
              <p className="step__desc">
                登录后可以在设置里把 Twische 安装到桌面或主屏，作为独立应用使用，并支持离线查看。
              </p>
            </div>
          </li>
        </ol>

        <div className="init__foot">
          <button className="btn" type="button" onClick={() => window.location.reload()}>
            <Icon name="refresh" size={16} />
            我已完成，重新检测
          </button>
          <span className="init__ver">服务端版本 {version || '—'}</span>
        </div>
      </div>
    </div>
  );
}
