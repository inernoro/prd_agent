import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, Sparkles, Loader2, Upload, ClipboardPaste, FileText, X, Settings2, ChevronDown, ChevronUp, BookOpen,
} from 'lucide-react';
import { speechAgentApi } from '@/services/real/speechAgent';
import { apiRequest } from '@/services/real/apiClient';

const AUDIENCES = ['通识', '产品经理', '工程师', '管理层', '客户'];
const STYLES = ['专业', '故事化', '简洁', '幽默'];
const DEPTHS = [2, 3, 4];

const ACCEPTED_TEXT_EXT = '.md,.markdown,.txt,.text';
const MAX_BYTES = 1024 * 1024; // 1MB

const SAMPLE_TEXT = `演讲智能体 v1 — 把长文档转成可上台讲的思维导图

核心价值：
1. 输入零摩擦：粘贴文本 / 上传文件 / 从知识库选，三种方式都可以
2. 输出可演讲：每个节点都是一屏，标题简短可上屏，下面带 2-5 条要点
3. 复用现有砖块：LLM Gateway 调模型、视觉创作配图、网页托管出分享链

目标用户：
- 需要快速准备分享/汇报的产品经理与工程师
- 把长文档变成对外讲解材料的运营 / 售前

为什么不直接用 PPT 工具？
传统 PPT 是"白纸"，你要从头排版。我们做的是反向——你给一段文字，AI 帮你拆结构、配画面、写讲稿。`;

export default function SpeechAgentCreatePage() {
  const navigate = useNavigate();
  const [sourceText, setSourceText] = useState('');
  const [sourceFileName, setSourceFileName] = useState<string | null>(null);
  const [audience, setAudience] = useState(AUDIENCES[0]);
  const [style, setStyle] = useState(STYLES[0]);
  const [depth, setDepth] = useState(3);
  const [title, setTitle] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [kbPickerOpen, setKbPickerOpen] = useState(false);
  const [kbStores, setKbStores] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [kbActiveStoreId, setKbActiveStoreId] = useState<string | null>(null);
  const [kbEntries, setKbEntries] = useState<Array<{ id: string; title: string; summary?: string; sourceType?: string }>>([]);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbFetchingEntry, setKbFetchingEntry] = useState(false);

  const charCount = sourceText.trim().length;
  const canSubmit = useMemo(() => charCount >= 30 && !submitting, [charCount, submitting]);

  const ingestFile = useCallback(async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(`文件超过 1MB，请压缩或粘贴正文（当前 ${(file.size / 1024).toFixed(0)} KB）`);
      return;
    }
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    const isText = ['md', 'markdown', 'txt', 'text'].includes(ext) || file.type.startsWith('text/');
    if (!isText) {
      setError('仅支持 .md / .txt 纯文本文件；PDF / Word 解析将在下一版本接入');
      return;
    }
    try {
      const text = await file.text();
      setSourceText(text);
      setSourceFileName(file.name);
      const inferred = file.name.replace(/\.(md|markdown|txt|text)$/i, '').trim();
      if (!title && inferred) setTitle(inferred);
    } catch (e) {
      setError('读取文件失败：' + (e as Error).message);
    }
  }, [title]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) ingestFile(f);
    e.target.value = '';
  }, [ingestFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) ingestFile(f);
  }, [ingestFile]);

  const handleClearFile = useCallback(() => {
    setSourceFileName(null);
    setSourceText('');
  }, []);

  // E7 知识库选文档
  const openKbPicker = useCallback(async () => {
    setKbPickerOpen(true);
    if (kbStores.length === 0) {
      setKbLoading(true);
      try {
        const res = await apiRequest<{ items: Array<{ id: string; name: string; description?: string }> }>(
          '/api/document-store/stores?page=1&pageSize=50');
        if (res.success && res.data) setKbStores(res.data.items);
      } finally { setKbLoading(false); }
    }
  }, [kbStores.length]);

  const loadKbEntries = useCallback(async (storeId: string) => {
    setKbActiveStoreId(storeId);
    setKbLoading(true);
    try {
      const res = await apiRequest<{ items: Array<{ id: string; title: string; summary?: string; sourceType?: string; isFolder?: boolean }> }>(
        `/api/document-store/stores/${encodeURIComponent(storeId)}/entries?page=1&pageSize=200&all=true`);
      if (res.success && res.data) {
        setKbEntries(res.data.items.filter((e) => !e.isFolder));
      }
    } finally { setKbLoading(false); }
  }, []);

  const pickKbEntry = useCallback(async (entryId: string, entryTitle: string) => {
    setKbFetchingEntry(true);
    try {
      const res = await apiRequest<{ content: string; title: string }>(
        `/api/document-store/entries/${encodeURIComponent(entryId)}/content`);
      if (res.success && res.data) {
        const content = (res.data.content || '').trim();
        if (content.length < 30) { alert('该文档内容过短（< 30 字）'); return; }
        setSourceText(content);
        setSourceFileName(null);
        if (!title) setTitle(entryTitle);
        setKbPickerOpen(false);
      }
    } finally { setKbFetchingEntry(false); }
  }, [title]);

  // ESC 关弹窗
  useEffect(() => {
    if (!kbPickerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setKbPickerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kbPickerOpen]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await speechAgentApi.createDeck({
        title: title.trim() || undefined,
        sourceType: sourceFileName ? 'upload' : 'paste',
        sourceText: sourceText.trim(),
        audience,
        style,
        depth,
      });
      if (res.success && res.data) {
        navigate(`/speech-agent/${res.data.deck.id}?autoStart=1`);
      } else {
        setError(res.error?.message ?? '创建失败');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 px-6 py-4 border-b border-white/10 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/speech-agent')}
          className="p-1.5 rounded-md hover:bg-white/10 text-white/70"
          aria-label="返回"
        >
          <ChevronLeft size={18} />
        </button>
        <div className="flex-1">
          <h1 className="text-base font-medium text-white/90">新建演讲</h1>
          <p className="text-xs text-white/50 mt-0.5">拖个文件进来 或 粘贴一段文字，剩下交给 AI</p>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-6 py-6" style={{ overscrollBehavior: 'contain' }}>
        <div className="max-w-3xl mx-auto flex flex-col gap-4">

          {sourceFileName && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-violet-500/10 border border-violet-400/30">
              <FileText size={14} className="text-violet-300" />
              <span className="flex-1 text-sm text-violet-100 truncate">已读入文件：{sourceFileName}</span>
              <span className="text-xs text-violet-300/70">{charCount} 字</span>
              <button
                onClick={handleClearFile}
                className="p-1 rounded-md hover:bg-white/10 text-white/60"
                aria-label="清除文件"
              >
                <X size={13} />
              </button>
            </div>
          )}

          <label
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`relative block rounded-xl border-2 border-dashed transition-all cursor-pointer ${
              dragOver ? 'border-violet-400/80 bg-violet-500/10' : 'border-white/15 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/25'
            }`}
          >
            <input
              type="file"
              accept={ACCEPTED_TEXT_EXT}
              onChange={handleFileInput}
              className="absolute inset-0 opacity-0 cursor-pointer"
              aria-label="上传 .md 或 .txt 文件"
            />
            <div className="px-6 py-7 flex items-center gap-4 pointer-events-none">
              <Upload size={22} className="text-violet-200/80" />
              <div className="flex-1">
                <p className="text-sm text-white/85 font-medium">拖入 / 点击上传文件</p>
                <p className="text-xs text-white/45 mt-0.5">支持 .md / .txt 纯文本；上限 1 MB · PDF / Word 下一版本接入</p>
              </div>
            </div>
          </label>

          <div className="flex items-center gap-3 text-xs text-white/40">
            <span className="flex-1 h-px bg-white/10" />
            <span>或从知识库选</span>
            <span className="flex-1 h-px bg-white/10" />
          </div>

          <button
            type="button"
            onClick={openKbPicker}
            className="w-full px-4 py-3 rounded-xl border border-white/15 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/25 transition-all flex items-center gap-3"
          >
            <BookOpen size={20} className="text-emerald-300/80" />
            <div className="flex-1 text-left">
              <div className="text-sm text-white/85 font-medium">从知识库选文档</div>
              <div className="text-xs text-white/45">浏览你的知识库 → 选一篇文档作为输入</div>
            </div>
          </button>

          <div className="flex items-center gap-3 text-xs text-white/40">
            <span className="flex-1 h-px bg-white/10" />
            <span>或粘贴文本</span>
            <span className="flex-1 h-px bg-white/10" />
          </div>

          <div className="relative">
            <textarea
              value={sourceText}
              onChange={(e) => { setSourceText(e.target.value); if (sourceFileName) setSourceFileName(null); }}
              placeholder="粘贴文章 / 报告 / 会议纪要 / 课程笔记…"
              rows={10}
              className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-violet-400/60 font-mono text-[13px] leading-relaxed resize-y"
            />
            <div className="mt-1.5 flex items-center justify-between text-xs">
              <button
                type="button"
                onClick={() => setSourceText(SAMPLE_TEXT)}
                className="inline-flex items-center gap-1 text-violet-300/80 hover:text-violet-200"
              >
                <ClipboardPaste size={12} /> 填入示例
              </button>
              <span className={charCount >= 30 ? 'text-emerald-300/80' : 'text-white/45'}>
                {charCount} 字{charCount < 30 && ` · 还差 ${30 - charCount} 字开始生成`}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-white/55 hover:text-white/80 hover:bg-white/[0.04]"
          >
            <Settings2 size={12} />
            高级选项：受众 / 风格 / 深度
            {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {!showAdvanced && (
              <span className="text-white/35 ml-1">（默认 {audience} · {style} · 深度 {depth}）</span>
            )}
          </button>

          {showAdvanced && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 flex flex-col gap-4">
              <div>
                <label className="block text-xs text-white/60 mb-1.5">演讲标题（可选）</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="留空则自动从原文首句提取"
                  className="w-full px-2.5 py-1.5 rounded-md bg-white/[0.04] border border-white/10 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:border-violet-400/60"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <ChipPicker label="目标受众" value={audience} options={AUDIENCES} onChange={setAudience} />
                <ChipPicker label="演讲风格" value={style} options={STYLES} onChange={setStyle} />
                <ChipPicker
                  label="层级深度"
                  value={String(depth)}
                  options={DEPTHS.map(String)}
                  onChange={(v) => setDepth(Number(v))}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-lg border border-rose-400/40 bg-rose-500/10 text-sm text-rose-200">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => navigate('/speech-agent')}
              className="px-4 py-2 rounded-lg text-sm text-white/70 hover:bg-white/10"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-violet-500/90 hover:bg-violet-400 disabled:bg-white/10 disabled:text-white/40 text-white text-sm font-medium transition-colors shadow-lg shadow-violet-500/20 disabled:shadow-none"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {submitting ? '创建中…' : '开始生成'}
            </button>
          </div>
        </div>
      </main>

      {/* E7 知识库选文档弹窗 */}
      {kbPickerOpen && (
        <div
          className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center px-4"
          onClick={() => setKbPickerOpen(false)}
        >
          <div
            className="w-full max-w-3xl rounded-2xl border border-white/10 bg-[#13121a] shadow-2xl flex flex-col"
            style={{ height: '70vh', maxHeight: '70vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 px-5 py-4 border-b border-white/10 flex items-center gap-3">
              <BookOpen size={16} className="text-emerald-300" />
              <h2 className="text-base font-medium text-white/95">从知识库选文档</h2>
              <button
                type="button"
                onClick={() => setKbPickerOpen(false)}
                className="ml-auto p-1.5 rounded-md hover:bg-white/10 text-white/65"
                aria-label="关闭"
              >
                <X size={16} />
              </button>
            </header>
            <div className="flex-1 min-h-0 flex">
              {/* 左：知识库列表 */}
              <div className="shrink-0 w-[200px] border-r border-white/10 flex flex-col" style={{ minHeight: 0 }}>
                <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-white/40">知识库</div>
                <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2" style={{ overscrollBehavior: 'contain' }}>
                  {kbLoading && kbStores.length === 0 && (
                    <div className="text-xs text-white/45 px-2 py-3">
                      <Loader2 size={12} className="animate-spin inline mr-1.5" /> 加载中…
                    </div>
                  )}
                  {kbStores.length === 0 && !kbLoading && (
                    <div className="text-xs text-white/45 px-2 py-3">还没有知识库</div>
                  )}
                  {kbStores.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => loadKbEntries(s.id)}
                      className={`w-full px-2.5 py-2 rounded-md text-left text-sm transition-all ${
                        kbActiveStoreId === s.id
                          ? 'bg-emerald-500/20 text-emerald-100'
                          : 'text-white/75 hover:bg-white/[0.05]'
                      }`}
                    >
                      <div className="truncate">{s.name}</div>
                      {s.description && (
                        <div className="text-[10px] text-white/45 truncate mt-0.5">{s.description}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* 右：文档列表 */}
              <div className="flex-1 min-w-0 min-h-0 flex flex-col">
                <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-white/40">
                  文档 {kbEntries.length > 0 && `(${kbEntries.length})`}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3" style={{ overscrollBehavior: 'contain' }}>
                  {!kbActiveStoreId && (
                    <div className="text-xs text-white/45 py-6 text-center">先在左侧选一个知识库</div>
                  )}
                  {kbActiveStoreId && kbLoading && (
                    <div className="text-xs text-white/45 py-6 text-center">
                      <Loader2 size={14} className="animate-spin inline mr-1.5" />
                      加载文档…
                    </div>
                  )}
                  {kbActiveStoreId && !kbLoading && kbEntries.length === 0 && (
                    <div className="text-xs text-white/45 py-6 text-center">该知识库没有文档</div>
                  )}
                  {kbEntries.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => pickKbEntry(e.id, e.title)}
                      disabled={kbFetchingEntry}
                      className="w-full px-3 py-2.5 rounded-lg text-left mb-1.5 border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20 disabled:opacity-50"
                    >
                      <div className="text-sm text-white/90 font-medium truncate">{e.title}</div>
                      {e.summary && (
                        <div className="text-xs text-white/55 truncate mt-1 leading-relaxed">{e.summary}</div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChipPicker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-white/60 mb-2">{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all border ${
                active
                  ? 'bg-violet-500/30 border-violet-400/60 text-violet-100'
                  : 'bg-white/[0.04] border-white/10 text-white/65 hover:bg-white/[0.08]'
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}
