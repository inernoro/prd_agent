import { Github, LogOut, Loader2, AlertTriangle } from 'lucide-react';
import { usePrReviewStore } from './usePrReviewStore';

/**
 * GitHub 连接卡片：已连接时展示 login + 断开按钮，未连接时展示连接按钮。
 * 连接动作是整页跳转（window.location.href），不是 fetch，确保 OAuth 回调能正常工作。
 */
export function GitHubConnectCard() {
  const authStatus = usePrReviewStore((s) => s.authStatus);
  const authLoading = usePrReviewStore((s) => s.authLoading);
  const connectGitHub = usePrReviewStore((s) => s.connectGitHub);
  const disconnectGitHub = usePrReviewStore((s) => s.disconnectGitHub);

  if (authLoading && !authStatus) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 flex items-center gap-3 text-white/60">
        <Loader2 size={18} className="animate-spin" />
        检查 GitHub 连接状态...
      </div>
    );
  }

  if (!authStatus) return null;

  if (!authStatus.oauthConfigured) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 flex items-start gap-3 text-sm text-amber-200">
        <AlertTriangle size={18} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold mb-1">尚未配置 GitHub OAuth App</div>
          <div className="text-amber-200/80 leading-relaxed">
            管理员需要先设置环境变量 <code className="px-1 rounded bg-black/40">GitHubOAuth__ClientId</code>{' '}
            和 <code className="px-1 rounded bg-black/40">GitHubOAuth__ClientSecret</code>。
            回调地址为 <code className="px-1 rounded bg-black/40">/api/pr-review/auth/callback</code>。
          </div>
        </div>
      </div>
    );
  }

  if (authStatus.connected) {
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5 flex items-center gap-4">
        {authStatus.avatarUrl ? (
          <img
            src={authStatus.avatarUrl}
            alt={authStatus.login}
            className="w-10 h-10 rounded-full border border-white/20"
          />
        ) : (
          <Github size={32} className="text-emerald-300" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white/60">已连接 GitHub 账号</div>
          <div className="text-base font-semibold text-white truncate">{authStatus.login}</div>
          {authStatus.scopes && (
            <div className="text-xs text-white/40 mt-0.5">scopes: {authStatus.scopes}</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            if (window.confirm('断开 GitHub 连接？已添加的 PR 记录不会被删除。')) {
              void disconnectGitHub();
            }
          }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-white/70 hover:text-white hover:bg-white/10 transition"
        >
          <LogOut size={16} />
          断开
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 flex items-center gap-4">
      <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center">
        <Github size={24} className="text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-base font-semibold text-white">连接 GitHub 账号</div>
        <div className="text-sm text-white/60 mt-0.5">
          授权后即可审查任意有访问权限的仓库 PR，token 安全存在服务端
        </div>
      </div>
      <button
        type="button"
        onClick={() => void connectGitHub()}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black text-sm font-semibold hover:bg-white/90 transition"
      >
        <Github size={16} />
        连接 GitHub
      </button>
    </div>
  );
}
