import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, GitPullRequest, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
 *
 * 深链自动发起审查（2026-04-20）：
 * 接收 `?prUrl=<encoded>` + 可选 `?autoStart=1` 查询参数，让 CDS 在
 * GitHub PR 评论里贴的 `{{prReviewUrl}}` 链接可以一键带到本页，自动
 * 把这个 PR 加进审查列表，免去用户手动粘贴。未登录场景由 App.tsx 的
 * RequireAuth 通过 returnUrl 自动回跳本页，登录后 query 参数仍在。
 */
export function PrReviewPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const errorMessage = usePrReviewStore((s) => s.errorMessage);
  const clearError = usePrReviewStore((s) => s.clearError);
  const loadAuthStatus = usePrReviewStore((s) => s.loadAuthStatus);
  const loadItems = usePrReviewStore((s) => s.loadItems);
  const addItem = usePrReviewStore((s) => s.addItem);
  const items = usePrReviewStore((s) => s.items);
  const authStatus = usePrReviewStore((s) => s.authStatus);
  const [autoStartNotice, setAutoStartNotice] = useState<string | null>(null);
  // 单次触发标志：首次成功/重复跳过后就认这个 prUrl 处理完了，
  // 避免 store.items 或 authStatus 变化导致的重复提交。
  const autoStartedForUrlRef = useRef<string | null>(null);
  // 列表是否已完成首次加载。没有这个 gate，深链 effect 会在
  // loadItems 返回之前就用空列表做去重，命中"未在列表里"分支 →
  // 重复调 addItem → 服务端以 duplicate 拒掉 → 用户看到"自动发起
  // 失败"，而不是"PR 已在审查列表中"。
  const [itemsLoadedOnce, setItemsLoadedOnce] = useState(false);

  // 初始加载
  useEffect(() => {
    void loadAuthStatus();
  }, [loadAuthStatus]);

  // 连接态就绪后拉一次列表
  useEffect(() => {
    if (!authStatus?.connected) return;
    let cancelled = false;
    loadItems(1).finally(() => {
      if (!cancelled) setItemsLoadedOnce(true);
    });
    return () => {
      cancelled = true;
    };
  }, [authStatus?.connected, loadItems]);

  // 深链自动发起审查：仅当 ①已连接 GitHub ②URL 里带 prUrl
  // ③首次列表加载已完成（否则 items 是空数组，去重永远 false）
  // ④此 prUrl 未被本次访问处理过。成功/重复后从 URL 里清掉
  // prUrl/autoStart，留 returnUrl 体验干净。
  useEffect(() => {
    const rawPrUrl = searchParams.get('prUrl');
    const autoStart = searchParams.get('autoStart');
    if (!rawPrUrl) return;
    if (!authStatus?.connected) return;
    if (!itemsLoadedOnce) return;
    if (autoStartedForUrlRef.current === rawPrUrl) return;

    const prUrl = rawPrUrl.trim();
    if (!prUrl) return;

    // 去重：列表里已有同一 PR 就不再重复添加。列表 item 记录的是 htmlUrl
    // （见 PrReviewItemDto），忽略尾部斜杠再比较。
    const normalizedPrUrl = prUrl.replace(/\/$/, '');
    const alreadyInList = items.some(
      (it) => it.htmlUrl?.replace(/\/$/, '') === normalizedPrUrl,
    );

    autoStartedForUrlRef.current = rawPrUrl;

    const cleanupParams = () => {
      const next = new URLSearchParams(searchParams);
      next.delete('prUrl');
      next.delete('autoStart');
      setSearchParams(next, { replace: true });
    };

    if (alreadyInList) {
      setAutoStartNotice(`PR 已在审查列表中：${prUrl}`);
      cleanupParams();
      return;
    }

    // autoStart=0 显式禁用时只填链接不提交，留给用户二次确认；
    // 缺省或 =1 都触发自动提交
    if (autoStart === '0') {
      setAutoStartNotice(`已跳转到 PR 审查页，请确认后手动添加：${prUrl}`);
      cleanupParams();
      return;
    }

    setAutoStartNotice(`正在从外部链接发起审查：${prUrl}`);
    void addItem(prUrl).then((ok) => {
      if (ok) {
        setAutoStartNotice(`PR 已加入审查列表：${prUrl}`);
      } else {
        setAutoStartNotice(`自动发起失败，请检查链接或手动重试：${prUrl}`);
      }
      cleanupParams();
    });
  }, [authStatus?.connected, itemsLoadedOnce, searchParams, setSearchParams, items, addItem]);

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

        {/* 深链自动发起审查提示 */}
        {autoStartNotice && (
          <div className="mb-4 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-3 flex items-center gap-3 text-sm text-violet-100">
            <GitPullRequest size={14} className="shrink-0" />
            <div className="flex-1 break-all">{autoStartNotice}</div>
            <button
              type="button"
              onClick={() => setAutoStartNotice(null)}
              className="p-1 rounded hover:bg-white/10"
              aria-label="关闭"
            >
              <X size={14} />
            </button>
          </div>
        )}

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
