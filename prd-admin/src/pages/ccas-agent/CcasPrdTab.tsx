import { useCallback, useRef, useState } from 'react';
import {
  Sparkles, RefreshCw, StopCircle, FileDown, CheckCircle2, AlertCircle, Loader2,
  Upload, BookOpen, X,
} from 'lucide-react';
import { connectSse } from '@/lib/useSseStream';
import { CCAS_PRD_STREAM_URL } from '@/services';
import type { CcasMeta } from '@/services';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { CcasKnowledgePickerDrawer, type SelectedEntrySnapshot } from './CcasKnowledgePickerDrawer';

interface Props {
  meta: CcasMeta;
}

type Phase = 'idle' | 'A-streaming' | 'A-done' | 'B-streaming' | 'B-done' | 'error';

interface ReferenceInfo {
  requested: number;
  included: number;
  totalChars: number;
  budget: number;
  skipped: string[];
}

/**
 * CCAS PRD 文档生成 Tab
 * 工作流：
 *   1) 选模板 → 填表 → （可选）上传 .md/.txt 或粘贴 → （可选）从知识库勾选参考资料
 *   2) 生成 Part A → 用户确认 → 生成 Part B
 *   3) 下载完整 markdown
 */
export function CcasPrdTab({ meta }: Props) {
  const [templateKey, setTemplateKey] = useState<string>(meta.templates[0]?.key ?? 'engineering-main');
  const [input, setInput] = useState('');
  const [existingMarkdown, setExistingMarkdown] = useState('');
  const [partA, setPartA] = useState('');
  const [partB, setPartB] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [phaseMsg, setPhaseMsg] = useState('');
  const [model, setModel] = useState<{ name?: string; platform?: string }>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 知识库引用
  const [pickerOpen, setPickerOpen] = useState(false);
  const [referenceSelected, setReferenceSelected] = useState<SelectedEntrySnapshot[]>([]);
  const [referenceInfo, setReferenceInfo] = useState<ReferenceInfo | null>(null);

  // 关联模式标签（透传给抽屉做高亮提示）
  const associationModeLabel = (() => {
    // 简单从 input 文本中嗅探，不做强解析；找到第一个匹配的 mode label 即返回
    for (const m of meta.associationModes) {
      if (input.includes(m.label)) return m.label;
    }
    return undefined;
  })();

  // 上传 .md / .txt 文件填到 existingMarkdown
  const onFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // 允许重选同名文件

    const name = file.name.toLowerCase();
    const supported = name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt');
    if (!supported) {
      toast.error('仅支持 .md / .txt（其他格式可在「知识库」上传后引用）');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('文件超过 2MB，建议拆分或在「知识库」上传');
      return;
    }

    try {
      const text = await file.text();
      setExistingMarkdown((prev) => {
        if (prev.trim()) {
          return `${prev}\n\n---\n\n${text}`;
        }
        return text;
      });
      toast.success(`已读入 ${file.name}（${text.length.toLocaleString()} 字符）`);
    } catch (err) {
      toast.error('文件读取失败：' + (err instanceof Error ? err.message : String(err)));
    }
  }, []);

  const streamPart = useCallback(
    async (target: 'A' | 'B') => {
      if (target === 'A' && !input.trim()) {
        toast.error('请填写产品/项目的基本描述');
        return;
      }

      setErrorMsg(null);
      const ac = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ac;

      if (target === 'A') {
        setPartA('');
        setPartB('');
        setModel({});
        setReferenceInfo(null);
      } else {
        setPartB('');
      }
      setPhase(target === 'A' ? 'A-streaming' : 'B-streaming');
      setPhaseMsg('连接中…');

      const referenceEntryIds = referenceSelected
        .filter((s) => s.kind === 'entry' && !!s.entryId)
        .map((s) => s.entryId!);
      const referenceStoreIds = referenceSelected
        .filter((s) => s.kind === 'store')
        .map((s) => s.storeId);
      const body = {
        templateKey,
        phase: target,
        input,
        existingMarkdown: existingMarkdown.trim() || undefined,
        confirmedPartA: target === 'B' ? partA : undefined,
        referenceEntryIds: referenceEntryIds.length > 0 ? referenceEntryIds : undefined,
        referenceStoreIds: referenceStoreIds.length > 0 ? referenceStoreIds : undefined,
      };

      const setText = target === 'A' ? setPartA : setPartB;

      const { success, errorMessage } = await connectSse({
        url: CCAS_PRD_STREAM_URL,
        method: 'POST',
        body,
        signal: ac.signal,
        onEvent: (evt) => {
          const data = evt.data ? safeJson(evt.data) : null;
          if (!data) return;
          switch (evt.event) {
            case 'phase':
              setPhaseMsg(typeof data.message === 'string' ? data.message : '');
              break;
            case 'model':
              setModel({
                name: typeof data.model === 'string' ? data.model : undefined,
                platform: typeof data.platform === 'string' ? data.platform : undefined,
              });
              break;
            case 'reference':
              setReferenceInfo({
                requested: typeof data.requested === 'number' ? data.requested : 0,
                included: typeof data.included === 'number' ? data.included : 0,
                totalChars: typeof data.totalChars === 'number' ? data.totalChars : 0,
                budget: typeof data.budget === 'number' ? data.budget : 24000,
                skipped: Array.isArray(data.skipped) ? (data.skipped as string[]) : [],
              });
              break;
            case 'thinking':
              break;
            case 'typing':
              if (typeof data.text === 'string') {
                setText((prev) => prev + data.text);
              }
              break;
            case 'done':
              setPhase(target === 'A' ? 'A-done' : 'B-done');
              setPhaseMsg('完成');
              break;
            case 'error':
              setPhase('error');
              setErrorMsg(typeof data.message === 'string' ? data.message : '生成失败');
              break;
          }
        },
      });

      if (!success && phase !== 'error') {
        setPhase('error');
        setErrorMsg(errorMessage || '连接失败');
      }
    },
    [templateKey, input, existingMarkdown, partA, phase, referenceSelected]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setPhase('idle');
    setPhaseMsg('已中止');
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setPartA('');
    setPartB('');
    setPhase('idle');
    setPhaseMsg('');
    setErrorMsg(null);
    setModel({});
    setReferenceInfo(null);
  }, []);

  const downloadMarkdown = useCallback(() => {
    const merged = [partA, partB].filter(Boolean).join('\n\n---\n\n');
    if (!merged.trim()) {
      toast.error('暂无内容可下载');
      return;
    }
    const blob = new Blob([merged], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ccas-prd-${templateKey}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [partA, partB, templateKey]);

  const isStreaming = phase === 'A-streaming' || phase === 'B-streaming';

  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-4 overflow-hidden">
      {/* 左：表单 + 控制 */}
      <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1" style={{ overscrollBehavior: 'contain' }}>
        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-3">1. 选择文档模板</h2>
          <div className="grid grid-cols-1 gap-2">
            {meta.templates.map((t) => (
              <label
                key={t.key}
                className={`block cursor-pointer rounded-md border px-3 py-2 transition ${
                  templateKey === t.key
                    ? 'border-amber-400/60 bg-amber-500/10'
                    : 'border-white/10 bg-white/5 hover:bg-white/10'
                }`}
              >
                <input
                  type="radio"
                  name="ccas-template"
                  value={t.key}
                  checked={templateKey === t.key}
                  onChange={() => setTemplateKey(t.key)}
                  className="hidden"
                />
                <div className="text-sm text-white">{t.label}</div>
                <div className="text-xs text-white/55 mt-0.5">{t.description}</div>
              </label>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <h2 className="text-sm font-medium text-white mb-3">2. 填写产品/项目描述</h2>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="例：产品母体「品牌商后台基础」T6.12.0；本次新增「赋码采集关联系统」模块；产线设备：裹包机、龙门架、工业相机×4、工控机、共享屏幕、箱码垛工位；关联模式：瓶箱垛；目标：实现 NC 剔除 + 实时关联校验…"
            rows={8}
            className="w-full rounded-md bg-black/30 border border-white/15 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60"
          />
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-white">
              3. 已有 Markdown（可选，AI 会在此基础上补全/优化）
            </h2>
            <Button
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              className="!h-7 !px-2 !text-[11px]"
              title="支持 .md / .txt，单文件 ≤ 2MB；其他格式（docx/pdf）请在「知识库」上传后引用"
            >
              <Upload className="w-3 h-3 mr-1" /> 上传 .md/.txt
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              onChange={onFileUpload}
              className="hidden"
            />
          </div>
          <textarea
            value={existingMarkdown}
            onChange={(e) => setExistingMarkdown(e.target.value)}
            placeholder="把已有 PRD/设计文档粘贴在这里，或点上方「上传 .md/.txt」直接读入。AI 会保留关键信息、补全缺失章节、优化表达。"
            rows={6}
            className="w-full rounded-md bg-black/30 border border-white/15 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-amber-400/60 font-mono"
          />
          {existingMarkdown && (
            <div className="mt-1 text-[10px] text-white/40 flex items-center justify-between">
              <span>已读入 {existingMarkdown.length.toLocaleString()} 字符</span>
              <button
                type="button"
                onClick={() => setExistingMarkdown('')}
                className="text-white/45 hover:text-white/70"
              >
                清空
              </button>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-white flex items-center gap-1.5">
              <BookOpen className="w-4 h-4 text-amber-300" />
              4. 引用知识库（可选）
            </h2>
            <Button variant="ghost" onClick={() => setPickerOpen(true)} className="!h-7 !px-2 !text-[11px]">
              {referenceSelected.length > 0 ? `已选 ${referenceSelected.length} 个来源 · 编辑` : '选择知识库'}
            </Button>
          </div>
          <p className="text-[11px] text-white/45 mb-2">
            从「左侧导航 → 知识库」中选择整个知识库或单篇资料，AI 生成时会作为事实依据注入。
            多知识库会按模型上下文预算自动裁剪。
          </p>
          {referenceSelected.length > 0 && (
            <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              {referenceSelected.map((s) => (
                <div
                  key={referenceKey(s)}
                  className="flex items-center gap-2 text-[11px] bg-amber-500/8 border border-amber-400/15 rounded px-2 py-1"
                >
                  <span className="text-amber-200/85 flex-1 min-w-0 truncate">
                    <span className="opacity-60">{s.storeName}</span>
                    <span className="opacity-40 mx-1">/</span>
                    {s.kind === 'store' ? `整库：${s.title}` : s.title}
                  </span>
                  <span className="text-white/45 shrink-0">~{Math.round(s.approxChars / 1000)}k 字</span>
                  <button
                    type="button"
                    onClick={() => setReferenceSelected((arr) => arr.filter((x) => referenceKey(x) !== referenceKey(s)))}
                    className="text-white/35 hover:text-white/70"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {referenceInfo && (referenceInfo.requested > 0) && (
            <div className="mt-2 text-[10px] text-white/45">
              本次生成已实际注入 <span className="text-amber-300/85">{referenceInfo.included}</span>{' '}
              条文档 · 共 {referenceInfo.totalChars.toLocaleString()} 字符
              {referenceInfo.skipped.length > 0 && (
                <span className="text-orange-300/65 ml-1">（{referenceInfo.skipped.length} 条被跳过）</span>
              )}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-white/10 bg-white/5 p-4 flex flex-col gap-2">
          <h2 className="text-sm font-medium text-white">5. 生成</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => streamPart('A')}
              disabled={isStreaming || !input.trim()}
              className="!h-9 !px-3 !text-xs"
            >
              {phase === 'A-streaming' ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Sparkles className="w-3.5 h-3.5 mr-1" />}
              生成 Part A（价值层）
            </Button>
            <Button
              variant="primary"
              onClick={() => streamPart('B')}
              disabled={isStreaming || phase !== 'A-done' || !partA.trim()}
              className="!h-9 !px-3 !text-xs"
              title={phase !== 'A-done' ? '先完成并确认 Part A' : '继续生成 Part B'}
            >
              {phase === 'B-streaming' ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1" />}
              确认并生成 Part B（设计层）
            </Button>
            {isStreaming && (
              <Button variant="ghost" onClick={abort} className="!h-9 !px-3 !text-xs">
                <StopCircle className="w-3.5 h-3.5 mr-1" />
                中止
              </Button>
            )}
            <Button variant="ghost" onClick={reset} className="!h-9 !px-3 !text-xs">
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              重置
            </Button>
            <Button
              variant="ghost"
              onClick={downloadMarkdown}
              disabled={!partA && !partB}
              className="!h-9 !px-3 !text-xs"
            >
              <FileDown className="w-3.5 h-3.5 mr-1" />
              下载 Markdown
            </Button>
          </div>
          {(phaseMsg || model.name) && (
            <div className="mt-1 text-[11px] text-white/45 flex items-center gap-2">
              {phaseMsg && <span>{phaseMsg}</span>}
              {model.name && (
                <span className="font-mono opacity-70">
                  ● {model.name}
                  {model.platform ? ` · ${model.platform}` : ''}
                </span>
              )}
            </div>
          )}
          {errorMsg && (
            <div className="mt-1 text-xs text-red-300/90 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5" /> {errorMsg}
            </div>
          )}
        </section>
      </div>

      {/* 右：输出 */}
      <div className="flex flex-col gap-3 min-h-0">
        <section className="flex-1 min-h-0 flex flex-col rounded-lg border border-white/10 bg-black/30">
          <div className="shrink-0 px-4 py-2 border-b border-white/10 flex items-center justify-between">
            <h2 className="text-sm font-medium text-white">Part A · 价值层</h2>
            <div className="text-[11px] text-white/45">
              {phase === 'A-streaming' && '生成中…'}
              {phase === 'A-done' && '✓ 完成'}
            </div>
          </div>
          <div
            className="flex-1 px-4 py-3 text-sm text-white/85 font-mono leading-relaxed whitespace-pre-wrap"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {partA || <span className="text-white/30">点击左侧"生成 Part A"开始</span>}
          </div>
        </section>
        <section className="flex-1 min-h-0 flex flex-col rounded-lg border border-white/10 bg-black/30">
          <div className="shrink-0 px-4 py-2 border-b border-white/10 flex items-center justify-between">
            <h2 className="text-sm font-medium text-white">Part B · 设计层 / 全局规范层</h2>
            <div className="text-[11px] text-white/45">
              {phase === 'B-streaming' && '生成中…'}
              {phase === 'B-done' && '✓ 完成'}
            </div>
          </div>
          <div
            className="flex-1 px-4 py-3 text-sm text-white/85 font-mono leading-relaxed whitespace-pre-wrap"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {partB || <span className="text-white/30">Part A 完成并确认后生成</span>}
          </div>
        </section>
      </div>

      <CcasKnowledgePickerDrawer
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedSnapshot={referenceSelected}
        onConfirm={(arr) => setReferenceSelected(arr)}
        associationModeLabel={associationModeLabel}
      />
    </div>
  );
}

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function referenceKey(ref: SelectedEntrySnapshot) {
  return ref.kind === 'store' ? `store:${ref.storeId}` : `entry:${ref.entryId ?? ref.storeId}`;
}
