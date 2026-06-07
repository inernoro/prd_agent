import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Sparkles, Loader2, Save, Play, AlertTriangle, RotateCcw, Brain } from 'lucide-react';
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

  const autoStarted = useRef(false);
  const shouldAutoStart = searchParams.get('autoStart') === '1';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await speechAgentApi.getDeck(deckId);
      if (res.success && res.data) {
        setDeck(res.data.deck);
        setNodes(res.data.nodes);
        setModel(res.data.deck.model ?? null);
        setPlatform(res.data.deck.platform ?? null);
      }
    } finally {
      setLoading(false);
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
          if (prev.some((n) => n.id === d.node.id)) return prev;
          return [...prev, d.node];
        });
      },
      done: () => {
        load();
      },
      error: (data) => {
        const d = data as { message?: string };
        setDeck((prev) => (prev ? { ...prev, status: 'failed', errorMessage: d.message } : prev));
      },
    },
  });

  const handleStart = useCallback(async () => {
    setNodes([]);
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

  const isGenerating = stream.isStreaming || stream.phase === 'connecting' || deck.status === 'generating';

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
      </header>

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
                    rows={10}
                    className="w-full px-2.5 py-2 rounded-md bg-white/[0.04] border border-white/10 text-sm text-white/85 focus:outline-none focus:border-violet-400/60 leading-relaxed"
                  />
                </div>
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
