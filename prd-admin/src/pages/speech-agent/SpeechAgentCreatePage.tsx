import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Sparkles, Loader2 } from 'lucide-react';
import { speechAgentApi } from '@/services/real/speechAgent';

const AUDIENCES = ['通识', '产品经理', '工程师', '管理层', '客户'];
const STYLES = ['专业', '故事化', '简洁', '幽默'];
const DEPTHS = [2, 3, 4];

const SAMPLE_TEXT = `演讲智能体 v1 — 把长文档转成可上台讲的思维导图

核心价值：
1. 输入零摩擦：粘贴文本 / 上传文档 / 从知识库选，三种方式都可以
2. 输出可演讲：每个节点都是一屏，标题简短可上屏，下面带 2-5 条要点
3. 复用现有砖块：LLM Gateway 调模型、VisualAgent 配图、网页托管出分享链

目标用户：
- 需要快速准备分享/汇报的产品经理与工程师
- 把长文档变成对外讲解材料的运营 / 售前

为什么不直接用 PPT 工具？
传统 PPT 是"白纸"，你要从头排版。我们做的是反向——你给一段文字，AI 帮你拆结构、配画面、写讲稿。`;

export default function SpeechAgentCreatePage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [audience, setAudience] = useState(AUDIENCES[0]);
  const [style, setStyle] = useState(STYLES[0]);
  const [depth, setDepth] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const charCount = sourceText.trim().length;
  const canSubmit = useMemo(() => charCount >= 30 && !submitting, [charCount, submitting]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await speechAgentApi.createDeck({
        title: title.trim() || undefined,
        sourceType: 'paste',
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
          <p className="text-xs text-white/50 mt-0.5">粘贴一段长文 / 报告 / 笔记，AI 会拆成思维导图演讲</p>
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-6 py-5" style={{ overscrollBehavior: 'contain' }}>
        <div className="max-w-3xl mx-auto flex flex-col gap-5">
          <div>
            <label className="block text-sm text-white/75 mb-2">标题（可选，留空自动取首句）</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：演讲智能体产品发布"
              className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-violet-400/60"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm text-white/75">原始材料 *</label>
              <div className="flex items-center gap-3 text-xs text-white/45">
                <button
                  type="button"
                  onClick={() => setSourceText(SAMPLE_TEXT)}
                  className="text-violet-300/80 hover:text-violet-200"
                >
                  填入示例
                </button>
                <span>{charCount} 字（≥30）</span>
              </div>
            </div>
            <textarea
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="粘贴文章 / 报告 / 会议纪要 / 课程笔记 …"
              rows={14}
              className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/90 placeholder:text-white/30 focus:outline-none focus:border-violet-400/60 font-mono text-[13px] leading-relaxed"
            />
            <p className="mt-1.5 text-xs text-white/40">
              首期只支持粘贴；从知识库选 / 上传文件将在下一版本接入。
            </p>
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

          {error && (
            <div className="px-3 py-2 rounded-lg border border-rose-400/40 bg-rose-500/10 text-sm text-rose-200">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
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
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-violet-500/90 hover:bg-violet-400 disabled:bg-white/10 disabled:text-white/40 text-white text-sm font-medium transition-colors"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {submitting ? '创建中…' : '创建并开始生成'}
            </button>
          </div>
        </div>
      </main>
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
      <label className="block text-sm text-white/75 mb-2">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const active = opt === value;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all border ${
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
