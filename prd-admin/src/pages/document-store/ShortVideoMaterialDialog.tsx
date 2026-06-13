import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Clock3, ExternalLink, FileText, Loader2, PackageCheck, RefreshCcw, Video, X } from 'lucide-react';
import {
  createShortVideoMaterialRun,
  type ShortVideoMaterialRunResponse,
  type ShortVideoMaterialStage,
} from '@/services';
import { toast } from '@/lib/toast';

const DEFAULT_STAGES: ShortVideoMaterialStage[] = [
  { key: 'parse', label: '解析素材来源', status: 'pending', message: '等待提交', at: '' },
  { key: 'source', label: '沉淀原始素材', status: 'pending', message: '等待提交', at: '' },
  { key: 'transcript', label: '沉淀字幕文案', status: 'pending', message: '等待提交', at: '' },
  { key: 'timeline', label: '沉淀时间轴片段', status: 'pending', message: '等待提交', at: '' },
  { key: 'ready', label: '交给知识库继续加工', status: 'pending', message: '等待提交', at: '' },
];

function stageClass(status: ShortVideoMaterialStage['status']) {
  if (status === 'done') return 'border-token-success bg-token-success-soft text-token-success';
  if (status === 'running') return 'border-token-accent bg-token-accent-soft text-token-accent';
  if (status === 'failed') return 'border-token-error bg-token-error-soft text-token-error';
  return 'border-token-subtle bg-token-card text-token-secondary';
}

function stageIcon(status: ShortVideoMaterialStage['status']) {
  if (status === 'done') return <Check size={12} />;
  if (status === 'running') return <Loader2 size={12} className="animate-spin" />;
  if (status === 'failed') return <RefreshCcw size={12} />;
  return <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />;
}

type Props = {
  storeId: string;
  storeName: string;
  onClose: () => void;
  onCreated: (result: ShortVideoMaterialRunResponse) => void | Promise<void>;
};

export function ShortVideoMaterialDialog({ storeId, storeName, onClose, onCreated }: Props) {
  const [videoUrl, setVideoUrl] = useState('');
  const [title, setTitle] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState(DEFAULT_STAGES);
  const [result, setResult] = useState<ShortVideoMaterialRunResponse | null>(null);

  const canSubmit = useMemo(() => videoUrl.trim().length > 8 && !running, [running, videoUrl]);

  const submit = async () => {
    if (!canSubmit) return;
    setRunning(true);
    setResult(null);
    setStages(DEFAULT_STAGES.map((stage, index) => index === 0
      ? { ...stage, status: 'running', message: '已提交到服务器，等待解析结果' }
      : stage));
    const ticker = window.setInterval(() => {
      setStages(prev => prev.map((stage, index) => {
        if (index !== 0 || stage.status !== 'running') return stage;
        return { ...stage, message: '服务器正在解析素材，产物以知识库条目为准' };
      }));
    }, 1800);

    try {
      const res = await createShortVideoMaterialRun({
        videoUrl: videoUrl.trim(),
        title: title.trim() || undefined,
        sourceText: sourceText.trim() || undefined,
        storeId,
      });
      if (!res.success || !res.data) {
        const message = res.error?.message || '解析失败';
        toast.error('解析失败', message);
        setStages(prev => prev.map((stage, index) => index === 0 ? { ...stage, status: 'failed', message } : stage));
        return;
      }
      setResult(res.data);
      setStages(res.data.run.stages);
      await onCreated(res.data);
      toast.success('短视频素材已入库');
    } finally {
      window.clearInterval(ticker);
      setRunning(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-[#03050a]/95 px-4 py-6 backdrop-blur-md">
      <div
        className="flex w-full max-w-[980px] min-h-0 flex-col overflow-hidden rounded-[10px] border border-token-subtle shadow-2xl"
        style={{
          height: 'min(740px, calc(100vh - 48px))',
          background: 'var(--bg-elevated)',
          boxShadow: '0 28px 90px rgba(0, 0, 0, 0.55)',
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-token-subtle px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-[8px] bg-token-accent-soft text-token-accent">
              <Video size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold tracking-normal">短视频素材包入库</h2>
              <p className="truncate text-[12px] text-token-muted">本次最终结果：1 个素材包，写入「{storeName}」</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="surface-action flex h-8 w-8 items-center justify-center rounded-[8px]"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(320px,420px)_minmax(0,1fr)] gap-4 overflow-auto p-5 max-lg:grid-cols-1">
          <section className="min-h-0">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
              <Video size={15} className="text-token-accent" />
              输入材料
            </div>
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-[12px] text-token-secondary">短视频链接或分享文本</span>
                <textarea
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  rows={3}
                  className="prd-field w-full resize-none rounded-[8px] px-3 py-2 text-[13px]"
                  placeholder="粘贴抖音、TikTok、快手、B 站等短视频链接"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[12px] text-token-secondary">素材标题</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="prd-field w-full rounded-[8px] px-3 py-2 text-[13px]"
                  placeholder="不填则由服务器生成"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-[12px] text-token-secondary">已有字幕、口播稿或要点</span>
                <textarea
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                  rows={8}
                  className="prd-field w-full resize-none rounded-[8px] px-3 py-2 text-[13px]"
                  placeholder="可选。没有时先生成待补充文稿和时间轴骨架，后续仍可在知识库里编辑。"
                />
              </label>

              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-[8px] bg-token-accent px-4 text-[13px] font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <Video size={16} />}
                {running ? '解析入库中' : '解析为知识库素材'}
              </button>
            </div>
          </section>

          <section className="min-h-0">
            <div className="rounded-[10px] border border-token-subtle bg-token-card p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <PackageCheck size={16} className="shrink-0 text-token-accent" />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold">本次最终结果：1 个素材包</div>
                    <div className="truncate text-[11px] text-token-muted">素材包由 3 个知识库条目组成</div>
                  </div>
                </div>
                <span className="shrink-0 rounded-[999px] border border-token-subtle px-2 py-1 text-[11px] text-token-secondary">
                  {result ? '已生成' : running ? '生成中' : '待生成'}
                </span>
              </div>
              <div className="grid gap-2">
                <OutcomeRow label="原始视频素材" desc="来源链接、平台、生成方式" href={result?.sourceUrl} />
                <OutcomeRow label="字幕文稿" desc="可编辑的口播文案" href={result?.transcriptUrl} />
                <OutcomeRow label="时间轴片段" desc="按片段继续加工" href={result?.timelineUrl} />
              </div>
            </div>

            <div className="mt-4">
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold">
                <FileText size={15} className="text-token-accent" />
                服务端入库过程
              </div>
              <div className="grid grid-cols-1 gap-2">
                {stages.map(stage => (
                  <div key={stage.key} className={`rounded-[8px] border px-3 py-2.5 ${stageClass(stage.status)}`}>
                    <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full border border-current">
                        {stageIcon(stage.status)}
                      </span>
                      {stage.label}
                    </div>
                    <p className="text-[11px] leading-relaxed text-current">{stage.message}</p>
                  </div>
                ))}
              </div>
            </div>

            {result && (
              <div className="mt-4 rounded-[8px] border border-token-subtle bg-token-nested px-3 py-2.5">
                <div className="text-[12px] font-semibold text-token-primary">下一步</div>
                <p className="mt-1 text-[11px] leading-relaxed text-token-secondary">
                  选中任一条目继续编辑，或交给智能体加工成教程、脚本、课程大纲、网页草稿。
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function OutcomeRow({ label, desc, href }: { label: string; desc: string; href?: string }) {
  const icon = href ? <Check size={13} /> : <Clock3 size={13} />;
  const content = (
    <>
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] ${href ? 'bg-token-success-soft text-token-success' : 'bg-token-nested text-token-muted'}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold text-token-primary">{label}</span>
        <span className="block truncate text-[11px] text-token-muted">{desc}</span>
      </span>
      {href && <ExternalLink size={14} className="shrink-0 text-token-muted" />}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="surface-row flex items-center gap-3 rounded-[8px] border border-token-subtle px-3 py-2"
      >
        {content}
      </a>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-[8px] border border-token-subtle bg-token-nested px-3 py-2">
      {content}
    </div>
  );
}
