import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Sparkles, Loader2, Save, Play, AlertTriangle, RotateCcw, Brain, Share2, Image as ImageIcon, ScrollText, Wand2, Copy, Check } from 'lucide-react';
import { speechAgentApi } from '@/services/real/speechAgent';
import type { SpeechDeck, SpeechNode } from '@/services/contracts/speechAgent';
import { useSseStream } from '@/lib/useSseStream';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { SpeechMindmapView } from './SpeechMindmapView';

export default function SpeechAgentEditorPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [deck, setDeck] = useState<SpeechDeck | null>(null);
  const [nodes, setNodes] = useState<SpeechNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [model, setModel] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBullets, setDraftBullets] = useState('');
  const [saving, setSaving] = useState(false);
  const [thinking, setThinking] = useState('');
  const [typing, setTyping] = useState('');
  const [aiNodeBusy, setAiNodeBusy] = useState<{ action: 'image' | 'notes' | 'rewrite'; nodeId: string } | null>(null);
  const [rewriteStyleOpen, setRewriteStyleOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [shareInfo, setShareInfo] = useState<{ url: string; token: string } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  const autoStarted = useRef(false);
  const shouldAutoStart = searchParams.get('autoStart') === '1';
  const loadFetchIdRef = useRef(0);
  // 重新生成时延迟清节点:首个 node 事件到达时 true → 清空 + 写入第一条;
  // 若并发拒绝/HTTP 失败/SSE 早炸,该 ref 一直为 true 但永远不触发,保留上一轮 mindmap
  const pendingClearRef = useRef(false);

  const load = useCallback(async () => {
    const fetchId = ++loadFetchIdRef.current;
    setLoading(true);
    try {
      const res = await speechAgentApi.getDeck(deckId);
      // stale-response guard: 路由切换或快速重复 load 时,旧请求不能覆盖新数据 (Bugbot Low)
      if (fetchId !== loadFetchIdRef.current) return;
      if (res.success && res.data) {
        setDeck(res.data.deck);
        setNodes(res.data.nodes);
        setModel(res.data.deck.model ?? null);
        setPlatform(res.data.deck.platform ?? null);
      }
    } finally {
      if (fetchId === loadFetchIdRef.current) setLoading(false);
    }
  }, [deckId]);

  useEffect(() => { if (deckId) load(); }, [deckId, load]);

  const stream = useSseStream({
    url: `/api/speech-agent/decks/${deckId}/generate`,
    method: 'POST',
    body: {},
    typingEvent: 'typing',
    onTyping: (text) => setTyping((prev) => prev + text),
    onPhase: () => {},
    onEvent: {
      model: (data) => {
        const d = data as { model?: string; platform?: string };
        if (d.model) setModel(d.model);
        if (d.platform) setPlatform(d.platform);
      },
      thinking: (data) => {
        const d = data as { text?: string };
        if (d.text) setThinking((prev) => prev + d.text);
      },
      node: (data) => {
        const d = data as { node: SpeechNode };
        setNodes((prev) => {
          // 首个 node 事件到达时才清理旧节点(Bugbot Medium "Regenerate clears nodes without restore"):
          // 并发拒绝/HTTP 失败/SSE 早炸 → 没有 node 事件 → 本地保留上一轮 mindmap 直到 load() 拿到权威态
          if (pendingClearRef.current) {
            pendingClearRef.current = false;
            return [d.node];
          }
          if (prev.some((n) => n.id === d.node.id)) return prev;
          return [...prev, d.node];
        });
      },
      done: () => {
        load();
      },
      error: (data) => {
        // SSE error 不能盲目本地置 status='failed' (Bugbot Medium "SSE error marks failed wrongly"):
        //   - 并发拒绝 (concurrencyRejected) 时后端仍在 generating,本地标失败 + 刷新后又跳回 generating
        //   - 临时网络错误也不应永久污染状态
        // 改成:① 展示 errorMessage(banner 给用户看)② 拉一次 deck 让 status 跟后端保持一致
        const d = data as { message?: string; concurrencyRejected?: boolean };
        setDeck((prev) => (prev ? { ...prev, errorMessage: d.message ?? null } : prev));
        // 并发拒绝时不动 status；其他错误让 backend 写入终态后 load 回来覆盖
        if (!d.concurrencyRejected) {
          // 给 backend 一点时间写入 failed status 再 refetch
          window.setTimeout(() => load(), 500);
        }
      },
    },
  });

  const handleStart = useCallback(async () => {
    // 不立刻清节点,等首个 node 事件到才清,避免并发拒绝/HTTP 错误时
    // 上一轮 mindmap 被永久抹掉 (Bugbot Medium "Regenerate clears nodes without restore")
    pendingClearRef.current = true;
    setSelectedNodeId(null);
    setThinking('');
    setTyping('');
    await stream.start();
  }, [stream]);

  useEffect(() => {
    if (!loading && deck && shouldAutoStart && !autoStarted.current) {
      autoStarted.current = true;
      searchParams.delete('autoStart');
      setSearchParams(searchParams, { replace: true });
      handleStart();
    }
  }, [loading, deck, shouldAutoStart, handleStart, searchParams, setSearchParams]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  useEffect(() => {
    if (selectedNode) {
      setDraftTitle(selectedNode.title);
      setDraftBullets(selectedNode.bulletPoints.join('\n'));
    } else {
      setDraftTitle('');
      setDraftBullets('');
    }
  }, [selectedNode]);

  const handleSaveNode = useCallback(async () => {
    if (!selectedNode) return;
    setSaving(true);
    try {
      const bulletPoints = draftBullets.split('\n').map((s) => s.trim()).filter(Boolean);
      const res = await speechAgentApi.updateNode(deckId, selectedNode.id, {
        title: draftTitle.trim(),
        bulletPoints,
      });
      if (res.success) {
        setNodes((prev) =>
          prev.map((n) =>
            n.id === selectedNode.id ? { ...n, title: draftTitle.trim(), bulletPoints } : n,
          ),
        );
      }
    } finally {
      setSaving(false);
    }
  }, [selectedNode, draftTitle, draftBullets, deckId]);

  // E1 节点 AI 配图
  const handleGenImage = useCallback(async () => {
    if (!selectedNode) return;
    setAiNodeBusy({ action: 'image', nodeId: selectedNode.id });
    try {
      const res = await speechAgentApi.generateNodeImage(deckId, selectedNode.id);
      if (res.success && res.data) {
        setNodes((prev) => prev.map((n) => n.id === selectedNode.id ? { ...n, imageAssetId: res.data!.imageAssetId, imageUrl: res.data!.url } : n));
      } else {
        alert('配图生成失败: ' + (res.error?.message ?? '未知错误'));
      }
    } finally { setAiNodeBusy(null); }
  }, [selectedNode, deckId]);

  // E3 节点 AI 备注（单节点）
  const handleGenNotes = useCallback(async () => {
    if (!selectedNode) return;
    setAiNodeBusy({ action: 'notes', nodeId: selectedNode.id });
    try {
      const res = await speechAgentApi.generateNodeNotes(deckId, selectedNode.id);
      if (res.success && res.data) {
        const notes = res.data.speakerNotes;
        setNodes((prev) => prev.map((n) => n.id === selectedNode.id ? { ...n, speakerNotes: notes } : n));
      } else {
        alert('备注生成失败: ' + (res.error?.message ?? '未知错误'));
      }
    } finally { setAiNodeBusy(null); }
  }, [selectedNode, deckId]);

  // E10/E11 节点 AI 重写
  const handleRewrite = useCallback(async (style: string) => {
    if (!selectedNode) return;
    setRewriteStyleOpen(false);
    setAiNodeBusy({ action: 'rewrite', nodeId: selectedNode.id });
    try {
      const res = await speechAgentApi.rewriteNode(deckId, selectedNode.id, style);
      if (res.success && res.data) {
        const { title, bulletPoints } = res.data;
        setNodes((prev) => prev.map((n) => n.id === selectedNode.id ? { ...n, title, bulletPoints } : n));
        setDraftTitle(title);
        setDraftBullets(bulletPoints.join('\n'));
      } else {
        alert('重写失败: ' + (res.error?.message ?? '未知错误'));
      }
    } finally { setAiNodeBusy(null); }
  }, [selectedNode, deckId]);

  // E2 一键发布
  const handlePublish = useCallback(async () => {
    setPublishing(true);
    try {
      const res = await speechAgentApi.publishDeck(deckId);
      if (res.success && res.data) {
        const url = window.location.origin + res.data.shareUrl;
        setShareInfo({ url, token: res.data.shareToken });
      } else {
        alert('发布失败: ' + (res.error?.message ?? '未知错误'));
      }
    } finally { setPublishing(false); }
  }, [deckId]);

  if (loading) {
    return <div className="h-full"><MapSectionLoader text="加载中…" /></div>;
  }

  if (!deck) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <AlertTriangle size={32} className="text-amber-300 mb-3" />
        <p className="text-white/75">演讲不存在或已被删除</p>
        <button
          onClick={() => navigate('/speech-agent')}
          className="mt-4 px-4 py-2 rounded-lg bg-violet-500/90 hover:bg-violet-400 text-white text-sm"
        >
          返回列表
        </button>
      </div>
    );
  }

  // 仅看本会话的 SSE 流状态。后端 deck.status === 'generating' 是持久化字段，
  // 刷新或返回页面时若上一次 SSE 已断而后端还没写回终态，会让 UI 永远卡在「生成中」
  // 锁住「重新生成 / 发布」(Bugbot High)。所以只信 stream 状态。
  const isGenerating = stream.isStreaming || stream.phase === 'connecting';

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 px-5 py-3 border-b border-white/10 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/speech-agent')}
          className="p-1.5 rounded-md hover:bg-white/10 text-white/70"
          aria-label="返回"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-medium text-white/90 truncate">{deck.title}</h1>
          <p className="text-xs text-white/45 truncate">
            {deck.audience} · {deck.style} · 深度 {deck.depth} · {nodes.length} 节点
          </p>
        </div>
        {model && (
          <div className="hidden md:flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/[0.04] border border-white/10">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[11px] font-mono text-white/55">{model}{platform ? ` · ${platform}` : ''}</span>
          </div>
        )}
        <button
          type="button"
          onClick={handleStart}
          disabled={isGenerating}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/90 hover:bg-violet-400 disabled:bg-white/10 disabled:text-white/40 text-white text-xs font-medium"
        >
          {isGenerating ? (
            <Loader2 size={13} className="animate-spin" />
          ) : nodes.length > 0 ? (
            <RotateCcw size={13} />
          ) : (
            <Sparkles size={13} />
          )}
          {isGenerating ? '生成中…' : nodes.length > 0 ? '重新生成' : '开始生成'}
        </button>
        <button
          type="button"
          onClick={() => navigate(`/speech-agent/${deckId}/play`)}
          disabled={nodes.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-40 text-white/85 text-xs font-medium border border-white/10"
          aria-label="播放演讲"
        >
          <Play size={13} />
          播放
        </button>
        <button
          type="button"
          onClick={handlePublish}
          disabled={nodes.length === 0 || publishing || isGenerating}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/90 hover:bg-emerald-400 disabled:bg-white/10 disabled:text-white/40 text-white text-xs font-medium"
          aria-label="发布为可分享 HTML 站点"
        >
          {publishing ? <Loader2 size={13} className="animate-spin" /> : <Share2 size={13} />}
          {publishing ? '发布中…' : '一键发布'}
        </button>
      </header>

      {/* 发布成功 toast */}
      {shareInfo && (
        <div
          className="fixed top-16 right-6 z-50 max-w-md rounded-xl border border-emerald-400/40 bg-emerald-500/10 backdrop-blur-xl shadow-2xl p-4 flex flex-col gap-3 animate-in slide-in-from-top-2"
          role="status"
        >
          <div className="flex items-center gap-2">
            <Check size={16} className="text-emerald-300" />
            <span className="text-sm font-medium text-emerald-100">发布成功</span>
            <button
              type="button"
              onClick={() => setShareInfo(null)}
              className="ml-auto text-white/55 hover:text-white/90 text-xs"
            >
              关闭
            </button>
          </div>
          <div className="text-xs text-white/65 leading-relaxed">
            演讲已渲染为静态 HTML 并发布到网页托管。任何人凭分享链可直接观看。
          </div>
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/30 border border-white/10">
            <code className="flex-1 text-xs text-emerald-200 truncate font-mono">{shareInfo.url}</code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(shareInfo.url);
                setShareCopied(true);
                setTimeout(() => setShareCopied(false), 2000);
              }}
              className="shrink-0 p-1.5 rounded-md hover:bg-white/10 text-white/75"
              aria-label="复制分享链"
            >
              {shareCopied ? <Check size={13} className="text-emerald-300" /> : <Copy size={13} />}
            </button>
            <a
              href={shareInfo.url}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 px-2.5 py-1 rounded-md bg-emerald-500/90 hover:bg-emerald-400 text-white text-xs"
            >
              打开
            </a>
          </div>
        </div>
      )}

      {isGenerating && (
        <div className="shrink-0 px-5 py-2 border-b border-white/10 bg-violet-500/[0.06] flex items-center gap-2">
          <Loader2 size={12} className="animate-spin text-violet-300" />
          <span className="text-xs text-violet-100/85">
            {stream.phaseMessage || 'AI 正在拆解演讲结构…'}
          </span>
          <span className="ml-auto text-[10px] text-white/40 font-mono">
            {thinking.length > 0 && `推理 ${thinking.length} 字`}
            {typing.length > 0 && ` · 输出 ${typing.length} 字`}
            {nodes.length > 0 && ` · 已落 ${nodes.length} 节点`}
          </span>
        </div>
      )}

      {deck.status === 'failed' && deck.errorMessage && (
        <div className="shrink-0 px-5 py-2 border-b border-white/10 bg-rose-500/[0.08] flex items-center gap-2">
          <AlertTriangle size={12} className="text-rose-300" />
          <span className="text-xs text-rose-100">生成失败：{deck.errorMessage}</span>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0 relative">
          {isGenerating && nodes.length === 0 && (thinking || typing) && (
            <div className="absolute inset-0 z-20 flex items-start justify-center px-6 py-8 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              <div className="w-full max-w-3xl flex flex-col gap-4">
                {thinking && (
                  <div className="rounded-xl border border-violet-400/30 bg-violet-500/[0.05] p-5">
                    <div className="flex items-center gap-2 mb-3 text-[11px] uppercase tracking-wider text-violet-300/80">
                      <Brain size={13} className="text-violet-300" />
                      模型思考过程
                      <span className="ml-auto font-mono text-white/40">{thinking.length} 字</span>
                    </div>
                    <div className="text-[13px] text-white/65 leading-relaxed font-mono whitespace-pre-wrap max-h-[200px] overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                      <StreamingText
                        text={thinking}
                        streaming={true}
                        mode="blur"
                        cursor={false}
                      />
                    </div>
                  </div>
                )}
                {typing && (
                  <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.05] p-5">
                    <div className="flex items-center gap-2 mb-3 text-[11px] uppercase tracking-wider text-emerald-300/80">
                      <Sparkles size={13} className="text-emerald-300" />
                      正在生成大纲 JSON
                      <span className="ml-auto font-mono text-white/40">{typing.length} 字</span>
                    </div>
                    <div className="text-[13px] text-white/85 leading-relaxed font-mono whitespace-pre-wrap max-h-[320px] overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                      <StreamingText
                        text={typing}
                        streaming={true}
                        mode="blur"
                        cursor={true}
                        cursorContent="map"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          <SpeechMindmapView
            nodes={nodes}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
          />
        </div>

        <aside className="shrink-0 w-[320px] border-l border-white/10 bg-white/[0.02] flex flex-col">
          {selectedNode ? (
            <>
              <div className="px-4 py-3 border-b border-white/10">
                <div className="text-[11px] uppercase tracking-wider text-white/40">节点编辑</div>
                <div className="text-xs text-white/55 mt-0.5">
                  Level {selectedNode.depth} · 第 {selectedNode.order + 1} 位
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3" style={{ overscrollBehavior: 'contain' }}>
                {/* AI 工具栏 */}
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 flex flex-col gap-2">
                  <div className="text-[10px] uppercase tracking-wider text-white/40 px-1">AI 工具</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={handleGenImage}
                      disabled={!!aiNodeBusy}
                      className="inline-flex flex-col items-center gap-1 px-2 py-2 rounded-md bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-40 text-white/75 text-[10px]"
                      title="生成 AI 配图"
                    >
                      {aiNodeBusy?.action === 'image' && aiNodeBusy?.nodeId === selectedNode.id ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} className="text-amber-300" />}
                      AI 配图
                    </button>
                    <button
                      type="button"
                      onClick={handleGenNotes}
                      disabled={!!aiNodeBusy}
                      className="inline-flex flex-col items-center gap-1 px-2 py-2 rounded-md bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-40 text-white/75 text-[10px]"
                      title="生成口播稿"
                    >
                      {aiNodeBusy?.action === 'notes' && aiNodeBusy?.nodeId === selectedNode.id ? <Loader2 size={14} className="animate-spin" /> : <ScrollText size={14} className="text-emerald-300" />}
                      AI 备注
                    </button>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setRewriteStyleOpen((v) => !v)}
                        disabled={!!aiNodeBusy}
                        className="w-full inline-flex flex-col items-center gap-1 px-2 py-2 rounded-md bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-40 text-white/75 text-[10px]"
                        title="按风格 AI 重写"
                      >
                        {aiNodeBusy?.action === 'rewrite' && aiNodeBusy?.nodeId === selectedNode.id ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} className="text-violet-300" />}
                        AI 重写
                      </button>
                      {rewriteStyleOpen && (
                        <div className="absolute right-0 top-full mt-1 z-30 min-w-[140px] rounded-lg border border-white/15 bg-[#13121a] shadow-2xl py-1">
                          {[
                            { id: 'concise', label: '精简' },
                            { id: 'story', label: '故事化' },
                            { id: 'data', label: '数据化' },
                            { id: 'question', label: '反问开场' },
                            { id: 'leijun', label: '雷军风' },
                            { id: 'ted', label: 'TED 风' },
                          ].map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => handleRewrite(s.id)}
                              className="w-full px-3 py-1.5 text-left text-xs text-white/85 hover:bg-white/[0.08]"
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-white/60 mb-1.5">标题</label>
                  <input
                    type="text"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-md bg-white/[0.04] border border-white/10 text-sm text-white/90 focus:outline-none focus:border-violet-400/60"
                  />
                </div>
                <div>
                  <label className="block text-xs text-white/60 mb-1.5">要点（每行一条）</label>
                  <textarea
                    value={draftBullets}
                    onChange={(e) => setDraftBullets(e.target.value)}
                    rows={6}
                    className="w-full px-2.5 py-2 rounded-md bg-white/[0.04] border border-white/10 text-sm text-white/85 focus:outline-none focus:border-violet-400/60 leading-relaxed"
                  />
                </div>

                {/* 节点配图预览 */}
                {selectedNode.imageUrl && (
                  <div>
                    <label className="block text-xs text-white/60 mb-1.5">节点配图</label>
                    <div className="rounded-lg overflow-hidden border border-white/10 bg-white/[0.02]">
                      <img src={selectedNode.imageUrl} alt={selectedNode.title} className="w-full h-auto object-cover" />
                    </div>
                  </div>
                )}

                {/* 演讲备注 */}
                {selectedNode.speakerNotes && (
                  <div>
                    <label className="block text-xs text-white/60 mb-1.5">口播稿（演讲备注）</label>
                    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-[13px] text-white/85 leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                      {selectedNode.speakerNotes}
                    </div>
                  </div>
                )}
              </div>
              <div className="shrink-0 px-4 py-3 border-t border-white/10 flex items-center justify-end gap-2">
                <button
                  onClick={handleSaveNode}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-500/90 hover:bg-violet-400 disabled:opacity-50 text-white text-xs font-medium"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                  保存
                </button>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-center px-6 text-xs text-white/45 leading-relaxed">
              点击左侧任一节点查看 / 编辑要点与备注。
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
