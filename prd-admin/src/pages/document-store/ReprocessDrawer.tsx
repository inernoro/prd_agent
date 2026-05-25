import { useCallback, useEffect, useState } from 'react';
import { Wand2, X, CheckCircle2, AlertCircle, Sparkle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming';
import SplitText from '@/components/reactbits/SplitText';
import CountUp from '@/components/reactbits/CountUp';
import BlurText from '@/components/reactbits/BlurText';
import { listReprocessTemplates, startReprocess } from '@/services';
import type { ReprocessTemplate } from '@/services/contracts/documentStore';
import { useReprocessRunStore } from '@/stores/reprocessRunStore';
import { toast } from '@/lib/toast';

export type ReprocessDrawerProps = {
  entryId: string;
  entryTitle: string;
  storeId: string;
  onClose: () => void;
};

/**
 * 文档再加工抽屉 —— 现在只负责「选模板 → 发起任务」和「展开查看进度」。
 *
 * SSE 订阅 + 完成副作用已上提到 reprocessRunStore + ReprocessRunHost，本抽屉
 * 退化为 store 的展开视图：开始后只读 store.runs[runId] 渲染进度/打字，关闭
 * 抽屉不再 abort 任务（Host 在页面层继续跑），刷新后再点开能直接续看。
 */
export function ReprocessDrawer({ entryId, entryTitle, storeId, onClose }: ReprocessDrawerProps) {
  // 'picking' = 选模板；'running' = 已发起，展示 store 里的进度
  const [stage, setStage] = useState<'picking' | 'running'>('picking');
  const [templates, setTemplates] = useState<ReprocessTemplate[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);
  // 防止「开始加工」请求在途时被二次点击 → 创建重复任务
  const [submitting, setSubmitting] = useState(false);

  const startRun = useReprocessRunStore((s) => s.startRun);
  const run = useReprocessRunStore((s) => (runId ? s.runs[runId] : undefined));

  // 复用：仅当该源文档有【进行中】任务时才直接展开续看（关抽屉又点开 / 刷新后重进）。
  // done / failed 不复用——否则重开抽屉会卡在旧结果页，无法再发起新的再加工。
  useEffect(() => {
    const existing = Object.values(useReprocessRunStore.getState().runs)
      .filter((r) => r.sourceEntryId === entryId && r.status === 'streaming')
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (existing) {
      setRunId(existing.runId);
      setStage('running');
    }
  }, [entryId]);

  // 加载模板列表
  useEffect(() => {
    (async () => {
      setLoadingTemplates(true);
      const res = await listReprocessTemplates();
      if (res.success) {
        setTemplates(res.data.items);
        if (res.data.items.length > 0) setSelectedKey(res.data.items[0].key);
      } else {
        toast.error('加载模板失败', res.error?.message);
        setTemplates([]);
      }
      setLoadingTemplates(false);
    })();
  }, []);

  const handleStart = useCallback(async () => {
    if (submitting) return;
    if (!selectedKey) return;
    if (selectedKey === 'custom' && !customPrompt.trim()) {
      toast.warning('请输入自定义提示词');
      return;
    }
    // 模板模式下：customPrompt 作为额外指令上送（后端会拼接到模板 systemPrompt 末尾）
    // 自定义模式下：customPrompt 是主 prompt
    const trimmed = customPrompt.trim();
    setSubmitting(true);
    const res = await startReprocess(entryId, {
      templateKey: selectedKey,
      customPrompt: trimmed || undefined,
    });
    if (!res.success) {
      setSubmitting(false);
      toast.error('启动任务失败', res.error?.message);
      return;
    }
    startRun({ runId: res.data.runId, storeId, sourceEntryId: entryId, sourceTitle: entryTitle });
    setRunId(res.data.runId);
    setStage('running');
  }, [submitting, entryId, entryTitle, storeId, selectedKey, customPrompt, startRun]);

  const selectedTemplate = templates?.find((t) => t.key === selectedKey);

  // 展示态（来自 store，关抽屉不影响真实任务）
  const status = run?.status ?? 'streaming';
  const phase = run?.phase ?? '排队中';
  const progress = run?.progress ?? 0;
  const streamedText = run?.streamedText ?? '';
  const errorMessage = run?.errorMessage;

  return (
    <motion.div
      className="surface-backdrop fixed inset-0 z-50 flex justify-end"
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.2 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <motion.div
        className="surface-popover flex h-full w-[560px] max-w-[92vw] flex-col border-l border-token-subtle"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}>

        {/* Header */}
        <div className="surface-panel-header flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
              <Wand2 size={15} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">
                文档再加工
              </p>
              <p className="truncate text-[10px] text-token-muted">
                {entryTitle}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {stage === 'picking' ? (
            loadingTemplates ? (
              <MapSectionLoader text="加载模板中…" />
            ) : (
              <div className="space-y-4">
                <p className="text-[12px] text-token-muted">
                  选择一个模板，或用自定义提示词指导 AI 如何改写内容。
                </p>

                {/* 模板卡片 — stagger 入场 + hover 微缩放（Wave 2 微交互） */}
                <motion.div
                  className="grid grid-cols-2 gap-2"
                  initial="hidden"
                  animate="visible"
                  variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
                >
                  {templates?.map((t) => {
                    const active = selectedKey === t.key;
                    return (
                      <motion.button
                        key={t.key}
                        onClick={() => setSelectedKey(t.key)}
                        variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
                        whileHover={{ y: -2, scale: 1.015 }}
                        whileTap={{ scale: 0.985 }}
                        transition={{ type: 'spring', stiffness: 320, damping: 24 }}
                        className={`cursor-pointer rounded-[10px] p-3 text-left ${active ? 'surface-action-accent' : 'surface-row'}`}
                      >
                        <p className="mb-1 text-[12px] font-semibold text-token-primary">
                          {t.label}
                        </p>
                        <p className="text-[10px] leading-snug text-token-muted">
                          {t.description}
                        </p>
                      </motion.button>
                    );
                  })}

                  {/* 自定义 */}
                  <motion.button
                    onClick={() => setSelectedKey('custom')}
                    variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
                    whileHover={{ y: -2, scale: 1.015 }}
                    whileTap={{ scale: 0.985 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 24 }}
                    className={`cursor-pointer rounded-[10px] p-3 text-left ${selectedKey === 'custom' ? 'surface-action-accent' : 'surface-row'}`}
                  >
                    <p className="mb-1 flex items-center gap-1 text-[12px] font-semibold text-token-primary">
                      <Sparkle size={11} /> 自定义
                    </p>
                    <p className="text-[10px] leading-snug text-token-muted">
                      自己输入提示词指导 AI 改写
                    </p>
                  </motion.button>
                </motion.div>

                {/* 提示词输入框 — 永远可见
                    - selectedKey === 'custom':  这就是主 prompt，必填
                    - selectedKey === 模板:      作为模板的「额外指令」附加（可选），后端会拼到 systemPrompt 末尾
                */}
                <div>
                  <label className="mb-1.5 flex items-baseline gap-1 text-[11px] font-semibold text-token-muted">
                    {selectedKey === 'custom' ? (
                      <>自定义提示词 <span className="text-[10px] font-normal" style={{ color: 'rgba(248,113,113,0.85)' }}>必填</span></>
                    ) : (
                      <>补充指令 <span className="text-[10px] font-normal text-token-muted">（可选，在模板基础上叠加要求）</span></>
                    )}
                  </label>
                  <textarea
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    placeholder={
                      selectedKey === 'custom'
                        ? '例如：把这篇内容改写成面向产品经理的一页纸摘要，用 bullet list 列出 5 个核心结论...'
                        : '例如：用产品经理视角 / 控制在 500 字内 / 加一节"风险清单"...'
                    }
                    rows={selectedKey === 'custom' ? 6 : 4}
                    className="prd-field w-full resize-y rounded-[10px] px-3 py-2 text-[12px] outline-none"
                  />
                </div>

                {/* 当前选择的描述 */}
                {selectedTemplate && (
                  <div className="surface-action-accent rounded-[8px] p-3 text-[11px]">
                    即将使用「{selectedTemplate.label}」模板处理这篇文档
                    {customPrompt.trim() && '（叠加上方补充指令）'}
                    ，结果会保存为新的 .md 文档。
                  </div>
                )}
              </div>
            )
          ) : (
            <div className="space-y-3">
              {/* 阶段状态 */}
              <div className="flex items-center justify-between">
                <BlurText
                  key={phase}
                  text={phase}
                  className="text-[12px] font-semibold text-token-primary"
                  delay={20}
                />
                <AnimatePresence mode="wait">
                  {status === 'done' ? (
                    <motion.span
                      key="done"
                      initial={{ scale: 0.7, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 360, damping: 18 }}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(74,222,128,0.95)', border: '1px solid rgba(34,197,94,0.25)' }}>
                      <CheckCircle2 size={10} />
                      <SplitText text="完成" tag="span" delay={40} duration={0.4} from={{ opacity: 0, y: 8 }} to={{ opacity: 1, y: 0 }} />
                    </motion.span>
                  ) : status === 'failed' ? (
                    <motion.span
                      key="failed"
                      initial={{ scale: 0.9, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(239,68,68,0.12)', color: 'rgba(248,113,113,0.95)', border: '1px solid rgba(239,68,68,0.25)' }}>
                      <AlertCircle size={10} /> 失败
                    </motion.span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: 'rgba(59,130,246,0.12)', color: 'rgba(96,165,250,0.95)', border: '1px solid rgba(59,130,246,0.25)' }}>
                      <MapSpinner size={10} /> 生成中
                    </span>
                  )}
                </AnimatePresence>
              </div>

              {/* 进度条 — done 时短暂流光 */}
              <div className="bg-token-nested h-1.5 overflow-hidden rounded-full relative">
                <motion.div
                  className="h-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ type: 'spring', stiffness: 80, damping: 20 }}
                  style={{
                    background: status === 'failed'
                      ? 'linear-gradient(90deg, rgba(239,68,68,0.6), rgba(248,113,113,0.9))'
                      : 'linear-gradient(90deg, rgba(59,130,246,0.6), rgba(96,165,250,0.9))',
                  }}/>
                {status === 'done' && (
                  <motion.div
                    className="absolute inset-y-0 w-12 pointer-events-none"
                    initial={{ x: '-100%' }}
                    animate={{ x: '450%' }}
                    transition={{ duration: 1.2, ease: 'easeInOut' }}
                    style={{
                      background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)',
                      mixBlendMode: 'overlay',
                    }} />
                )}
              </div>
              <div className="text-right">
                <span className="text-[10px] text-token-muted tabular-nums">
                  <CountUp to={progress} from={0} duration={0.8} suffix="%" />
                </span>
              </div>

              {/* 实时打字区 */}
              <div className="surface-code mt-2 max-h-[50vh] min-h-[280px] overflow-y-auto rounded-[10px] p-4 font-mono text-[12px] leading-relaxed text-token-primary whitespace-pre-wrap">
                {streamedText ? (
                  <StreamingText text={streamedText} streaming={status === 'streaming'} mode="blur" />
                ) : (
                  <span className="text-token-muted">等待 LLM 输出…</span>
                )}
                {status === 'streaming' && !streamedText && (
                  <span className="inline-block w-1 h-3 ml-0.5 align-middle"
                    style={{ background: 'rgba(96,165,250,0.8)', animation: 'pulse 1s ease-in-out infinite' }} />
                )}
              </div>

              {status === 'failed' && errorMessage && (
                <div className="p-3 rounded-[10px] text-[11px] break-all"
                  style={{
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.2)',
                    color: 'rgba(248,113,113,0.95)',
                  }}>
                  {errorMessage}
                </div>
              )}

              {status === 'done' && run?.outputEntryId && (
                <div className="p-3 rounded-[10px] text-[11px]"
                  style={{
                    background: 'rgba(34,197,94,0.06)',
                    border: '1px solid rgba(34,197,94,0.15)',
                    color: 'rgba(74,222,128,0.95)',
                  }}>
                  已保存为新文档，你可以在文件树中找到它。
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer
            paddingBottom 加大 + 主按钮 size="md" 让"开始加工"按钮：
              1) 不被屏幕右下角的全局通知图标 / 帮助气泡遮挡
              2) 体量更醒目，符合主操作的视觉权重
        */}
        <div className="surface-panel-footer flex items-center justify-between gap-2 px-5 pt-4 pb-20">
          {stage === 'picking' ? (
            <>
              <Button variant="primary" size="md"
                disabled={submitting || !selectedKey || (selectedKey === 'custom' && !customPrompt.trim())}
                onClick={handleStart}>
                <Wand2 size={14} /> {submitting ? '提交中…' : '开始加工'}
              </Button>
              <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
            </>
          ) : (
            <>
              <span className="text-[11px] text-token-muted">
                {status === 'streaming' ? '正在加工，可关闭抽屉后台继续' : ''}
              </span>
              <Button variant="ghost" size="sm" onClick={onClose}>
                {status === 'done' || status === 'failed' ? '关闭' : '后台运行'}
              </Button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
