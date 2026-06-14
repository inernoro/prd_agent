import { useState, useEffect, useCallback } from 'react';
import { GitCompare, Loader2, Trash2, History, Play, Github, AlertTriangle, FileCode } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import {
  listDiffs,
  getDiff,
  deleteDiff,
  getCodeScanRepos,
  diffCompareUrl,
  type ChannelTraceDiff,
  type ChannelTraceCodeHit,
  type ChannelTraceCodeScanRepo,
} from '@/services/real/channelTraceAgent';

interface RepoStatus {
  name: string;
  branch: string;
  ok: boolean;
  error?: string | null;
}

export function DiffTab() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState<{ model?: string; platform?: string } | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [repoStatus, setRepoStatus] = useState<RepoStatus[]>([]);
  const [codeHits, setCodeHits] = useState<ChannelTraceCodeHit[]>([]);
  const [history, setHistory] = useState<ChannelTraceDiff[]>([]);
  const [viewing, setViewing] = useState<ChannelTraceDiff | null>(null);
  const [builtinRepos, setBuiltinRepos] = useState<ChannelTraceCodeScanRepo[]>([]);
  const [tokenConfigured, setTokenConfigured] = useState(true);

  const { phase, phaseMessage, typing, isStreaming, start, reset } = useSseStream({
    url: diffCompareUrl,
    method: 'POST',
    onEvent: {
      model: (d) => setModel(d as { model?: string; platform?: string }),
      keywords: (d) => setKeywords((d as { keywords: string[] }).keywords ?? []),
      repos: (d) => setRepoStatus((d as { items: RepoStatus[] }).items ?? []),
      codeHits: (d) =>
        setCodeHits(
          ((d as { items: { repo: string; path: string; score: number }[] }).items ?? []).map((h) => ({
            ...h,
            snippet: '',
          })),
        ),
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
    void (async () => {
      const res = await getCodeScanRepos();
      if (res.success && res.data) {
        setBuiltinRepos(res.data.repos);
        setTokenConfigured(res.data.tokenConfigured);
      }
    })();
  }, [loadHistory]);

  const compare = () => {
    if (!description.trim() || isStreaming) return;
    setModel(null);
    setKeywords([]);
    setRepoStatus([]);
    setCodeHits([]);
    setViewing(null);
    void start({
      body: {
        title: title.trim() || undefined,
        featureDescription: description.trim(),
      },
    });
  };

  const openHistory = async (id: string) => {
    reset();
    setKeywords([]);
    setRepoStatus([]);
    setCodeHits([]);
    const res = await getDiff(id);
    if (res.success && res.data) {
      setViewing(res.data.item);
      setKeywords(res.data.item.keywords ?? []);
      setCodeHits(res.data.item.codeHits ?? []);
    }
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
  const shownHits = codeHits;

  return (
    <div className="h-full min-h-0 flex">
      {/* 左：描述输入 + 结果 */}
      <div className="flex-1 min-w-0 flex flex-col border-r border-white/10">
        <div className="shrink-0 px-6 pt-5 pb-3 space-y-2.5">
          <div className="text-sm font-medium text-white/85 inline-flex items-center gap-1.5">
            <GitCompare className="w-4 h-4 text-emerald-400" />
            功能描述 vs 代码实现异同分析
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-white/45">
            <Github className="w-3.5 h-3.5" />
            内置扫描仓库：
            {builtinRepos.length === 0 ? (
              <span>加载中…</span>
            ) : (
              builtinRepos.map((r) => (
                <span key={r.name} className="px-1.5 py-0.5 rounded bg-white/5 text-white/70">
                  {r.name}@{r.branch}
                </span>
              ))
            )}
          </div>
          {!tokenConfigured && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                未检测到服务级 GitHub PAT，私有仓库将无法克隆。请在部署环境注入密钥{' '}
                <code className="font-mono">ChannelTrace__GitHubToken</code>。
              </span>
            </div>
          )}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="对比任务标题（可选），如：窜货判定逻辑核对"
            className="w-full rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-emerald-500/40"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) compare();
            }}
            rows={4}
            placeholder="具体描述要核对的功能/业务规则，越具体越好（涉及的实体、流程、边界、状态流转）。子 agent 会按描述去两个仓库里找相关代码再做异同分析。（Ctrl/⌘+Enter 开始）"
            className="w-full resize-y rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30 leading-relaxed focus:outline-none focus:border-emerald-500/40"
          />
          <div className="flex items-center justify-between">
            <div className="text-[11px] text-white/40 font-mono">
              {resultModel?.model ? `● ${resultModel.model}${resultModel.platform ? ` · ${resultModel.platform}` : ''}` : ''}
            </div>
            <button
              onClick={compare}
              disabled={isStreaming || !description.trim()}
              className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-sm hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              开始分析
            </button>
          </div>
        </div>

        <div
          className="flex-1 px-6 pb-5"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {viewing && (
            <div className="text-xs text-white/45 mb-2">
              历史记录：{viewing.title} · {new Date(viewing.createdAt).toLocaleString('zh-CN')}
              {viewing.scannedRepos?.length > 0 && ` · 扫描：${viewing.scannedRepos.join(', ')}`}
            </div>
          )}

          {keywords.length > 0 && (
            <div className="mb-2">
              <span className="text-[11px] text-white/45">检索关键词：</span>
              {keywords.map((k) => (
                <span key={k} className="ml-1 text-[11px] px-1.5 py-0.5 rounded bg-white/5 text-white/70">
                  {k}
                </span>
              ))}
            </div>
          )}

          {repoStatus.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5 text-[11px]">
              {repoStatus.map((r) => (
                <span
                  key={r.name}
                  className={`px-1.5 py-0.5 rounded ${
                    r.ok ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'
                  }`}
                  title={r.error ?? ''}
                >
                  {r.ok ? '克隆成功' : '克隆失败'}：{r.name}
                </span>
              ))}
            </div>
          )}

          {shownHits.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-white/50 mb-1.5 inline-flex items-center gap-1">
                <FileCode className="w-3.5 h-3.5" />
                命中代码（{shownHits.length}）
              </div>
              <div className="space-y-1">
                {shownHits.map((h, i) => (
                  <div key={`${h.repo}-${h.path}-${i}`} className="text-[11px] text-white/60 font-mono truncate">
                    <span className="text-emerald-300/80">[{h.repo}]</span> {h.path}
                  </div>
                ))}
              </div>
            </div>
          )}

          {isStreaming && !typing && (
            <div className="flex items-center gap-2 text-sm text-white/50 py-4">
              <Loader2 className="w-4 h-4 animate-spin" />
              {phaseMessage || '子 agent 处理中…'}
            </div>
          )}
          {resultText ? (
            <div className="rounded-xl bg-white/3 border border-white/10 px-4 py-3">
              <MarkdownContent content={resultText} variant="reading" />
            </div>
          ) : (
            !isStreaming &&
            keywords.length === 0 && (
              <div className="text-sm text-white/35 py-10 text-center">
                描述要核对的功能，子 agent 会扫描内置两个仓库的相关代码，给出与你描述的异同分析。
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
          分析历史
        </div>
        <div
          className="flex-1 px-4 pb-4 space-y-2"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {history.length === 0 ? (
            <div className="text-sm text-white/35 py-10 text-center">暂无分析记录。</div>
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
