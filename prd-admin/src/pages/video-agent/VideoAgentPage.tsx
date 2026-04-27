/**
 * 视频生成 Agent 页面（纯 OpenRouter 直出模式）
 *
 * 2026-04-27 重构：原本支持 Remotion 拆分镜路径（文章上传 → 分镜生成 → 逐镜编辑 →
 * 导出渲染），但 docker dev 模式下 Remotion + Chromium 部署反复踩坑。决定彻底砍掉
 * Remotion 路线，只保留 OpenRouter 视频大模型直出。
 *
 * 当前实现：
 *   - 主区：VideoGenDirectPanel（描述输入 + 模型/时长/宽高/分辨率参数 + 渲染状态）
 *   - 顶部：历史抽屉入口、新建任务按钮
 *   - 列表：HistoryDrawer 展示历史任务，点击恢复查看
 *   - 自动恢复：进入页面时若有未结束任务自动选中（服务器权威性原则）
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { History as HistoryIcon, Plus } from 'lucide-react';
import { listVideoGenRunsReal } from '@/services/real/videoAgent';
import type { VideoGenRunListItem } from '@/services/contracts/videoAgent';
import { VideoGenDirectPanel } from './VideoGenDirectPanel';
import { HistoryDrawer } from './HistoryDrawer';

const SELECTED_RUN_KEY = 'video-agent.selectedRunId';
const ACTIVE_STATUSES = new Set(['Queued', 'Rendering']);

export const VideoAgentPage: React.FC = () => {
  const [runs, setRuns] = useState<VideoGenRunListItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(SELECTED_RUN_KEY); } catch { return null; }
  });

  // 持久化 selectedRunId
  useEffect(() => {
    try {
      if (selectedRunId) sessionStorage.setItem(SELECTED_RUN_KEY, selectedRunId);
      else sessionStorage.removeItem(SELECTED_RUN_KEY);
    } catch { /* ignore */ }
  }, [selectedRunId]);

  // 加载历史
  const loadRuns = useCallback(async () => {
    try {
      const res = await listVideoGenRunsReal({ limit: 30 });
      if (res.success) setRuns(res.data.items);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // 自动恢复：runs 加载完后，若 sessionStorage 的 runId 不存在或无值，
  // 优先选未结束任务，其次最近一条。一次性，不打扰用户后续切换。
  const autoSelectAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoSelectAttemptedRef.current) return;
    if (runs.length === 0) return;

    if (selectedRunId && runs.some(r => r.id === selectedRunId)) {
      autoSelectAttemptedRef.current = true;
      return;
    }

    if (selectedRunId) setSelectedRunId(null); // stale id, clear

    const active = runs.find(r => ACTIVE_STATUSES.has(r.status));
    const target = active ?? runs[0];
    if (target) setSelectedRunId(target.id);
    autoSelectAttemptedRef.current = true;
  }, [runs, selectedRunId]);

  const handleNewTask = useCallback(() => {
    setSelectedRunId(null);
    autoSelectAttemptedRef.current = true; // 用户主动新建，不再自动恢复
  }, []);

  const handleSelectFromHistory = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setHistoryOpen(false);
  }, []);

  // 内嵌 panel 创建新 run 后回调：把 selectedRunId 切到新 run + 刷新历史列表
  // (Bugbot R3-1：原本 panel 创建后 parent 不知道，列表过期，selectedRunId 也没切)
  const handleRunCreated = useCallback((runId: string) => {
    setSelectedRunId(runId);
    autoSelectAttemptedRef.current = true;
    void loadRuns();
  }, [loadRuns]);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0 p-4">
      {/* 顶部工具条 */}
      <GlassCard variant="subtle" className="px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
            视频创作智能体
          </span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            · 纯大模型直出（Veo / Kling / Wan / Sora）
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={handleNewTask} title="开始新任务">
            <Plus size={14} />
            新任务
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { setHistoryOpen(true); loadRuns(); }}
            title="查看历史任务"
          >
            <HistoryIcon size={14} />
            历史 ({runs.length})
          </Button>
        </div>
      </GlassCard>

      {/* 主区：直出面板 */}
      <div className="flex-1 min-h-0 overflow-auto">
        <VideoGenDirectPanel
          externalRunId={selectedRunId ?? undefined}
          onReset={handleNewTask}
          onRunCreated={handleRunCreated}
        />
      </div>

      {/* 历史抽屉 */}
      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        runs={runs}
        selectedRunId={selectedRunId}
        onSelect={handleSelectFromHistory}
      />
    </div>
  );
};

export default VideoAgentPage;
