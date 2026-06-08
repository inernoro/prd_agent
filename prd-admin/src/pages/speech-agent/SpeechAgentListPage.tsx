import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Plus, Trash2, Sparkles, FileText, Loader2 } from 'lucide-react';
import { speechAgentApi } from '@/services/real/speechAgent';
import type { SpeechDeck } from '@/services/contracts/speechAgent';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

const STATUS_LABEL: Record<SpeechDeck['status'], { label: string; color: string }> = {
  draft: { label: '草稿', color: 'text-white/60' },
  generating: { label: '生成中', color: 'text-amber-300' },
  ready: { label: '已就绪', color: 'text-emerald-300' },
  failed: { label: '失败', color: 'text-rose-400' },
};

export default function SpeechAgentListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<SpeechDeck[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await speechAgentApi.listDecks(1, 50);
      if (res.success && res.data) setItems(res.data.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(async (deckId: string, title: string) => {
    if (!confirm(`确认删除「${title}」？此操作不可撤销。`)) return;
    const res = await speechAgentApi.deleteDeck(deckId);
    if (res.success) {
      setItems((prev) => prev.filter((it) => it.id !== deckId));
    }
  }, []);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 px-6 py-5 border-b border-white/10 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white/95 flex items-center gap-2">
            <Mic size={20} className="text-violet-300" />
            演讲智能体
          </h1>
          <p className="mt-1 text-sm text-white/55">
            把一段长文/文档转成可演讲的思维导图——首期模式：导图演讲（mindmap）
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/speech-agent/new')}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-violet-500/90 hover:bg-violet-400 text-white text-sm font-medium transition-colors shadow-lg shadow-violet-500/20"
        >
          <Plus size={16} />
          新建演讲
        </button>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-6 py-5" style={{ overscrollBehavior: 'contain' }}>
        {loading ? (
          <MapSectionLoader text="加载中…" />
        ) : items.length === 0 ? (
          <EmptyState onCreate={() => navigate('/speech-agent/new')} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {items.map((d) => (
              <DeckCard
                key={d.id}
                deck={d}
                onOpen={() => navigate(`/speech-agent/${d.id}`)}
                onDelete={() => handleDelete(d.id, d.title)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="h-full min-h-[400px] flex flex-col items-center justify-center text-center px-6">
      <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-violet-500/30 to-fuchsia-500/20 border border-white/10 flex items-center justify-center mb-5">
        <Sparkles size={36} className="text-violet-200" />
      </div>
      <h2 className="text-lg font-medium text-white/90">还没有演讲</h2>
      <p className="mt-2 max-w-md text-sm text-white/55 leading-relaxed">
        粘贴一段文章 / 报告 / 笔记，AI 会把它拆成
        <span className="text-violet-200 mx-1">思维导图风格</span>
        的演讲大纲——一节一图，可以直接上台讲。
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-6 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-violet-500/90 hover:bg-violet-400 text-white text-sm font-medium transition-colors shadow-lg shadow-violet-500/20"
      >
        <Plus size={16} />
        创建第一个演讲
      </button>
    </div>
  );
}

function DeckCard({
  deck,
  onOpen,
  onDelete,
}: {
  deck: SpeechDeck;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const meta = STATUS_LABEL[deck.status] ?? STATUS_LABEL.draft;
  return (
    <div
      onClick={onOpen}
      className="group relative rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/20 transition-all cursor-pointer p-4 flex flex-col gap-3"
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500/30 to-fuchsia-500/20 border border-white/10 flex items-center justify-center">
          <FileText size={18} className="text-violet-200" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-white/90 truncate">{deck.title || '未命名'}</h3>
          <p className="mt-0.5 text-xs text-white/45 truncate">
            受众：{deck.audience} · 风格：{deck.style} · 深度：{deck.depth}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className={`inline-flex items-center gap-1 ${meta.color}`}>
          {deck.status === 'generating' && <Loader2 size={11} className="animate-spin" />}
          {meta.label} · {deck.nodeCount} 节点
        </span>
        <span className="text-white/35">
          {new Date(deck.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
        </span>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-rose-500/20 text-white/50 hover:text-rose-300"
        aria-label="删除"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
