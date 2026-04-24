import { useState } from 'react';
import { Check, Clock, Copy, Lock, RefreshCw } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { createTeamWeekShare } from '@/services';

function genPassword(len = 6) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map((b) => chars[b % chars.length])
    .join('');
}

interface ShareTeamWeekDialogProps {
  open: boolean;
  teamId: string;
  teamName?: string;
  weekYear: number;
  weekNumber: number;
  onClose: () => void;
}

/**
 * 团队周报「快速分享」弹窗。
 *
 * 交互参考 WebPagesPage 的 ShareDialog —— 密码保护（可选、可自动生成）+ 过期时间下拉框 +
 * 一键分享按钮。生成后自动复制链接+密码到剪贴板。
 *
 * 访问规则（由后端强制）：
 * - 必须登录才能打开
 * - 团队成员免输密码
 * - 非团队成员需要输入密码（如果设置了密码）
 * - 链接过期后自动失效
 */
export function ShareTeamWeekDialog({
  open,
  teamId,
  teamName,
  weekYear,
  weekNumber,
  onClose,
}: ShareTeamWeekDialogProps) {
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<{ shareUrl: string; token: string; password?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(7);

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-sunken)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
  };

  const handleCreate = async () => {
    setCreating(true);
    const pwd = usePassword ? (password.trim() || undefined) : undefined;
    const res = await createTeamWeekShare({
      teamId,
      weekYear,
      weekNumber,
      password: pwd,
      expiresInDays,
    });
    setCreating(false);
    if (!res.success) {
      toast.error(res.error?.message || '生成分享链接失败');
      return;
    }
    const shareResult = { shareUrl: res.data.shareUrl, token: res.data.token, password: pwd };
    setResult(shareResult);
    let text = `${window.location.origin}${shareResult.shareUrl}`;
    if (shareResult.password) text += `\n访问密码：${shareResult.password}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failure
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    let text = `${window.location.origin}${result.shareUrl}`;
    if (result.password) text += `\n访问密码：${result.password}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败，请手动选中复制');
    }
  };

  const handleClose = () => {
    setResult(null);
    setPassword('');
    setUsePassword(false);
    setCopied(false);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
      title={result ? '分享链接已创建' : '快速分享'}
      description={
        result
          ? undefined
          : `将「${teamName || '团队'}」${weekYear} 年第 ${weekNumber} 周的团队周报分享给他人`
      }
      maxWidth={480}
      content={
        result ? (
          <div className="flex flex-col gap-4">
            <div
              className="flex items-center gap-2 p-3 rounded-lg"
              style={{ background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)' }}
            >
              <Check size={16} style={{ color: '#22c55e' }} />
              <span className="text-sm" style={{ color: '#22c55e' }}>
                分享链接已生成，已复制到剪贴板
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={`${window.location.origin}${result.shareUrl}`}
                readOnly
                className="flex-1 px-3 py-2 rounded-lg text-sm outline-none"
                style={inputStyle}
              />
              <Button size="sm" onClick={handleCopy}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </Button>
            </div>
            {result.password && (
              <div
                className="flex items-center gap-2 p-3 rounded-lg"
                style={{ background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.25)' }}
              >
                <Lock size={16} style={{ color: 'rgba(59, 130, 246, 0.9)', flexShrink: 0 }} />
                <div className="flex-1">
                  <div className="text-xs mb-1" style={{ color: 'rgba(59, 130, 246, 0.8)' }}>
                    访问密码
                  </div>
                  <code
                    className="text-sm font-mono font-bold tracking-wider"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {result.password}
                  </code>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(result.password!);
                  }}
                >
                  <Copy size={14} />
                </Button>
              </div>
            )}
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {result.password
                ? '非团队成员需要输入密码才能访问；团队成员直接打开即可。'
                : '登录用户可直接访问。团队成员看到完整内容，非成员可浏览本周已提交周报。'}
            </p>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={handleClose}>
                关闭
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              点击下方按钮即可一键生成成员周报的分享链接；收件人必须登录本系统才能打开。
            </p>

            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={usePassword}
                  onChange={(e) => {
                    setUsePassword(e.target.checked);
                    if (e.target.checked) {
                      setPassword(genPassword());
                    } else {
                      setPassword('');
                    }
                  }}
                />
                <Lock size={12} style={{ color: 'var(--text-muted)' }} />
                <span style={{ color: 'var(--text-secondary)' }}>密码保护（非团队成员需输入）</span>
              </label>
              {usePassword && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="输入密码"
                      className="flex-1 px-3 py-1.5 rounded-lg text-sm outline-none"
                      style={inputStyle}
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setPassword(genPassword())}
                      title="随机生成密码"
                    >
                      <RefreshCw size={12} />
                    </Button>
                  </div>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    可修改密码或点击右侧按钮重新生成
                  </span>
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  <Clock size={12} className="inline mr-1" />
                  过期时间
                </span>
                <select
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(Number(e.target.value))}
                  className="px-3 py-1.5 rounded-lg text-sm outline-none cursor-pointer"
                  style={inputStyle}
                >
                  <option value={0}>永不过期</option>
                  <option value={1}>1 天</option>
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                </select>
              </label>
            </div>

            <div className="flex justify-end gap-2 mt-2">
              <Button variant="ghost" onClick={handleClose}>
                取消
              </Button>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? '生成中...' : '一键分享'}
              </Button>
            </div>
          </div>
        )
      }
    />
  );
}
