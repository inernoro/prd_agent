import { useEffect } from 'react';
import { ArrowLeft, GitPullRequest, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { GitHubConnectCard } from './GitHubConnectCard';
import { AddPrForm } from './AddPrForm';
import { PrItemList } from './PrItemList';
import { usePrReviewStore } from './usePrReviewStore';

/**
 * PR Review V2 主页面 —— 单文件不超过 200 行。
 * 布局：顶部标题栏 + 左侧（OAuth 卡 + 添加表单）+ 右侧（PR 列表）
 *
 * Device Flow 不需要 URL 回调处理：连接成功后 Zustand 里的 authStatus 自动更新，
 * 页面自动切到已连接状态，无需解析 query string。
 */
export function PrReviewPage() {
  const navigate = useNavigate();
  const errorMessage = usePrReviewStore((s) => s.errorMessage);
  const clearError = usePrReviewStore((s) => s.clearError);
  const loadAuthStatus = usePrReviewStore((s) => s.loadAuthStatus);
  const loadItems = usePrReviewStore((s) => s.loadItems);
  const authStatus = usePrReviewStore((s) => s.authStatus);

  // 初始加载
  useEffect(() => {
    void loadAuthStatus();
  }, [loadAuthStatus]);

  // 连接态就绪后拉一次列表
  useEffect(() => {
    if (authStatus?.connected) {
      void loadItems(1);
    }
  }, [authStatus?.connected, loadItems]);

  return (
    <div className="min-h-full bg-[#0d0b16] text-white">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <button
            type="button"
            onClick={() => navigate('/admin')}
            className="p-2 rounded-lg bg-white/5 text-white/70 hover:bg-white/10 transition"
            aria-label="返回"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/15 border border-violet-500/20 flex items-center justify-center">
              <GitPullRequest size={20} className="text-violet-300" />
            </div>
            <div>
              <div className="text-xl font-bold">PR 审查工作台</div>
              <div className="text-xs text-white/50">
                用你自己的 GitHub 账号审查任意有权访问的 PR
              </div>
            </div>
          </div>
        </div>

        {/* Error banner */}
        {errorMessage && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-center gap-3 text-sm text-red-200">
            <div className="flex-1">{errorMessage}</div>
            <button
              type="button"
              onClick={clearError}
              className="p-1 rounded hover:bg-white/10 text-red-200"
              aria-label="关闭"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Body */}
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5">
          <div className="space-y-4">
            <GitHubConnectCard />
            <AddPrForm />
          </div>
          <div>
            <PrItemList />
          </div>
        </div>
      </div>
    </div>
  );
}

export default PrReviewPage;
