import { useEffect, useState } from 'react';
import {
  Github,
  LogOut,
  AlertTriangle,
  Copy,
  ExternalLink,
  CheckCircle2,
  X,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { usePrReviewStore } from './usePrReviewStore';

/**
 * GitHub 连接卡片（Device Flow）
 *
 * 三种态：
 * - 未配置 OAuth App → 红色提示
 * - 已连接 → 显示 avatar/login/scopes + 断开按钮
 * - 未连接 + 无进行中 flow → "连接 GitHub" 按钮
 * - 未连接 + 有进行中 flow → 授权进度卡片（user code + 打开按钮 + 倒计时 + 取消）
 */
export function GitHubConnectCard() {
  const authStatus = usePrReviewStore((s) => s.authStatus);
  const authLoading = usePrReviewStore((s) => s.authLoading);
  const deviceFlow = usePrReviewStore((s) => s.deviceFlow);
  const startConnect = usePrReviewStore((s) => s.startConnect);
  const cancelDeviceFlow = usePrReviewStore((s) => s.cancelDeviceFlow);
  const disconnectGitHub = usePrReviewStore((s) => s.disconnectGitHub);

  if (authLoading && !authStatus) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 flex items-center gap-3 text-white/60">
        <MapSpinner size={18} />
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
            管理员需要先在 GitHub 创建 OAuth App，勾选{' '}
            <code className="px-1 rounded bg-black/40">Enable Device Flow</code>，然后在宿主机（运行
            docker compose 的机器）设置环境变量{' '}
            <code className="px-1 rounded bg-black/40">GitHubOAuth__ClientId</code>
            （和可选 <code className="px-1 rounded bg-black/40">GitHubOAuth__ClientSecret</code>），
            推荐写入项目根目录的 <code className="px-1 rounded bg-black/40">.env</code> 文件，
            docker compose 会自动加载；或写入 <code className="px-1 rounded bg-black/40">.bashrc</code>
            后重开终端，再执行 <code className="px-1 rounded bg-black/40">./exec_dep.sh</code>
            重启 api 容器使之生效。Device Flow 不需要 Callback URL，本地/CDS/生产共用一套配置。
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

  // Device Flow 进行中
  if (deviceFlow) {
    return <DeviceFlowProgress deviceFlow={deviceFlow} onCancel={cancelDeviceFlow} />;
  }

  // 初始：未连接，未开始 flow
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-5 flex items-center gap-4">
      <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center">
        <Github size={24} className="text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-base font-semibold text-white">连接 GitHub 账号</div>
        <div className="text-sm text-white/60 mt-0.5">
          授权后即可审查任意有访问权限的仓库 PR
        </div>
      </div>
      <button
        type="button"
        onClick={() => void startConnect()}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black text-sm font-semibold hover:bg-white/90 transition"
      >
        <Github size={16} />
        连接 GitHub
      </button>
    </div>
  );
}

interface DeviceFlowProgressProps {
  deviceFlow: NonNullable<ReturnType<typeof usePrReviewStore.getState>['deviceFlow']>;
  onCancel: () => void;
}

function DeviceFlowProgress({ deviceFlow, onCancel }: DeviceFlowProgressProps) {
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // 倒计时 tick
  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - deviceFlow.startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deviceFlow.startedAt]);

  const remaining = Math.max(0, deviceFlow.expiresInSeconds - elapsed);
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  const progressPct = Math.min(100, (elapsed / deviceFlow.expiresInSeconds) * 100);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(deviceFlow.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略：用户仍可手动复制
    }
  };

  const openVerification = () => {
    window.open(deviceFlow.verificationUriComplete, '_blank', 'noopener,noreferrer');
  };

  const isPolling = deviceFlow.status === 'polling';

  return (
    <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {isPolling ? (
            <MapSpinner size={22} color="#c4b5fd" />
          ) : (
            <Github size={22} className="text-violet-300" />
          )}
          <div>
            <div className="text-base font-semibold text-white">
              {isPolling ? '等待你在 GitHub 上授权...' : '授权中断'}
            </div>
            <div className="text-xs text-white/50 mt-0.5">
              GitHub Device Flow · 无需 callback URL
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="p-1.5 rounded hover:bg-white/10 text-white/50 hover:text-white transition"
          aria-label="取消授权"
        >
          <X size={16} />
        </button>
      </div>

      {/* User code */}
      <div className="rounded-lg border border-white/10 bg-black/30 p-4">
        <div className="text-xs text-white/50 mb-2">授权码（GitHub 页面需要输入）</div>
        <div className="flex items-center gap-3">
          <div className="flex-1 font-mono text-2xl font-bold text-white tracking-[0.2em] text-center py-2 bg-white/5 rounded-lg">
            {deviceFlow.userCode}
          </div>
          <button
            type="button"
            onClick={() => void copyCode()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 transition shrink-0"
          >
            {copied ? <CheckCircle2 size={14} className="text-emerald-300" /> : <Copy size={14} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </div>

      {/* 打开 GitHub 授权页按钮 */}
      <button
        type="button"
        onClick={openVerification}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-white text-black font-semibold text-sm hover:bg-white/90 transition"
      >
        <ExternalLink size={16} />
        打开 GitHub 授权页
      </button>

      {/* 倒计时 + 进度条 */}
      {isPolling && (
        <div>
          <div className="flex items-center justify-between text-xs text-white/50 mb-1.5">
            <span>剩余 {minutes}:{seconds.toString().padStart(2, '0')}</span>
            <span>每 {deviceFlow.intervalSeconds} 秒自动检测</span>
          </div>
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-400 transition-all duration-1000"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* 终态错误 */}
      {!isPolling && deviceFlow.status === 'expired' && (
        <div className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          授权已超时，请点击取消后重新发起。
        </div>
      )}
      {!isPolling && deviceFlow.status === 'denied' && (
        <div className="text-xs text-red-200 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          你在 GitHub 页面拒绝了授权。
        </div>
      )}
      {!isPolling && deviceFlow.status === 'failed' && (
        <div className="text-xs text-red-200 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          授权轮询失败：{deviceFlow.errorDetail ?? '未知错误'}
        </div>
      )}

      {/* 引导文案 */}
      <div className="text-xs text-white/40 leading-relaxed">
        步骤：① 点击"打开 GitHub 授权页" → ② 确认页面上显示的授权码 → ③ 点 Authorize
        完成后本页面会自动进入已连接状态，无需手动刷新。
      </div>
    </div>
  );
}
