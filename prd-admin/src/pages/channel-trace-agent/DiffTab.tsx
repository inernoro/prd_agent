import { useState, useEffect, useCallback } from 'react';
import { GitCompare, Loader2, Trash2, History, Play } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import {
  listDiffs,
  getDiff,
  deleteDiff,
  diffCompareUrl,
  type ChannelTraceDiff,
} from '@/services/real/channelTraceAgent';

export function DiffTab() {
  const [title, setTitle] = useState('');
  const [businessRule, setBusinessRule] = useState('');
  const [codeContent, setCodeContent] = useState('');
  const [codeLocation, setCodeLocation] = useState('');
  const [model, setModel] = useState<{ model?: string; platform?: string } | null>(null);
  const [history, setHistory] = useState<ChannelTraceDiff[]>([]);
  const [viewing, setViewing] = useState<ChannelTraceDiff | null>(null);

  const { phase, phaseMessage, typing, isStreaming, start, reset } = useSseStream({
    url: diffCompareUrl,
    method: 'POST',
    onEvent: {
      model: (d) => setModel(d as { model?: string; platform?: string }),
    },
    onDone: () => {
      void loadHistory();
    },
  });

  const loadHistory = useCallback(async () => {
    const res = await listDiffs(1, 50);
    if (res.success && res.data) setHistory(res.data.items);
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const compare = () => {
    if (!businessRule.trim() || !codeContent.trim() || isStreaming) return;
    setModel(null);
    setViewing(null);
    void start({
      body: {
        title: title.trim() || undefined,
        businessRule: businessRule.trim(),
        codeContent: codeContent.trim(),
        codeLocation: codeLocation.trim() || undefined,
      },
    });
  };

  const openHistory = async (id: string) => {
    reset();
    const res = await getDiff(id);
    if (res.success && res.data) setViewing(res.data.item);
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('确定删除该对比记录？')) return;
    const res = await deleteDiff(id);
    if (res.success) {
      if (viewing?.id === id) setViewing(null);
      void loadHistory();
    }
  };

  const resultText = viewing ? viewing.diffReport ?? '' : typing;
  const resultModel = viewing
    ? viewing.model
      ? { model: viewing.model, platform: viewing.modelPlatform ?? undefined }
      : null
    : model;

  return (
    <div className="h-full min-h-0 flex">
      {/* 左：输入 + 结果 */}
      <div className="flex-1 min-w-0 flex flex-col border-r border-white/10">
        <div className="shrink-0 px-6 pt-5 pb-3 space-y-2.5">
          <div className="text-sm font-medium text-white/85 inline-flex items-center gap-1.5">
            <GitCompare className="w-4 h-4 text-emerald-400" />
            业务规则 vs 代码实现差异对比
          </div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="对比任务标题（可选），如：窜货判定规则一致性核对"
            className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
          />
          <div className="grid grid-cols-2 gap-2.5">
            <textarea
              value={businessRule}
              onChange={(e) => setBusinessRule(e.target.value)}
              rows={6}
              placeholder="防窜物流业务规则描述（期望行为）…"
              className="resize-y rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 leading-relaxed focus:outline-none focus:border-emerald-500/40"
            />
            <textarea
              value={codeContent}
              onChange={(e) => setCodeContent(e.target.value)}
              rows={6}
              placeholder="当前代码实现（粘贴相关代码片段 / 逻辑）…"
              className="resize-y rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 font-mono leading-relaxed focus:outline-none focus:border-emerald-500/40"
            />
          </div>
          <div className="flex items-center gap-2">
            <input
              value={codeLocation}
              onChange={(e) => setCodeLocation(e.target.value)}
              placeholder="代码位置标注（可选），如 prd-api/.../ChannelService.cs:120"
              className="flex-1 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
            />
            <button
              onClick={compare}
              disabled={isStreaming || !businessRule.trim() || !codeContent.trim()}
              className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-sm hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              开始对比
            </button>
          </div>
          {resultModel?.model && (
            <div className="text-[11px] text-white/40 font-mono">
              ● {resultModel.model}
              {resultModel.platform ? ` · ${resultModel.platform}` : ''}
            </div>
          )}
        </div>

        <div
          className="flex-1 px-6 pb-5"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {viewing && (
            <div className="text-xs text-white/45 mb-2">
              历史记录：{viewing.title} ·{' '}
              {new Date(viewing.createdAt).toLocaleString('zh-CN')}
            </div>
          )}
          {isStreaming && !typing && (
            <div className="flex items-center gap-2 text-sm text-white/50 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              {phaseMessage || 'AI 正在对比…'}
            </div>
          )}
          {resultText ? (
            <div className="rounded-xl bg-white/3 border border-white/10 px-4 py-3">
              <MarkdownContent content={resultText} variant="reading" />
            </div>
          ) : (
            !isStreaming && (
              <div className="text-sm text-white/35 py-10 text-center">
                填入业务规则与代码实现，AI 会给出「已实现 / 缺失 / 偏差 / 代码额外行为」的差异清单。
              </div>
            )
          )}
          {phase === 'error' && (
            <div className="text-sm text-rose-400 py-3">{phaseMessage || '请求失败'}</div>
          )}
        </div>
      </div>

      {/* 右：历史记录 */}
      <div className="w-[320px] shrink-0 flex flex-col">
        <div className="shrink-0 px-4 pt-5 pb-3 text-sm font-medium text-white/85 inline-flex items-center gap-1.5">
          <History className="w-4 h-4 text-white/50" />
          对比历史
        </div>
        <div
          className="flex-1 px-4 pb-4 space-y-2"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {history.length === 0 ? (
            <div className="text-sm text-white/35 py-10 text-center">暂无对比记录。</div>
          ) : (
            history.map((it) => (
              <div
                key={it.id}
                onClick={() => void openHistory(it.id)}
                className={`rounded-lg border px-3 py-2.5 cursor-pointer group transition-colors ${
                  viewing?.id === it.id
                    ? 'bg-emerald-500/10 border-emerald-500/30'
                    : 'bg-white/3 border-white/10 hover:bg-white/5'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white/90 font-medium truncate">{it.title}</div>
                    <div className="text-[11px] text-white/40 mt-1">
                      {it.status === 'Done'
                        ? new Date(it.createdAt).toLocaleString('zh-CN')
                        : it.status === 'Error'
                          ? '失败'
                          : '处理中…'}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDelete(it.id);
                    }}
                    className="shrink-0 p-1 rounded text-white/40 hover:text-rose-400 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="删除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
