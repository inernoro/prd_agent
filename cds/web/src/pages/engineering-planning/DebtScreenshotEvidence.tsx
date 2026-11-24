import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ImagePlus, ZoomIn } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import type { PlanningEvidence, PlanningProofMark, PlanningRepaymentProof } from '../../../../src/shared/engineering-planning';
import './planning-screenshots.css';

type Stage = PlanningRepaymentProof['stage'];
type Mark = PlanningProofMark;
type Point = Pick<Mark, 'x' | 'y'>;
type StoredScreenshot = PlanningEvidence & Required<Pick<PlanningEvidence, 'image'>>;
type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';
type Dimensions = { width: number; height: number };
type ScreenshotDraft = {
  image?: Dimensions & { dataUrl: string; fileName: string };
  label: string;
  mark?: Mark;
  loading?: boolean;
  error?: string;
};

const stages: Stage[] = ['before', 'after'];
const stageLabels = { before: '还前', after: '还后' };
const maxProofBytes = 600 * 1024;
const minMarkSize = 0.02;
const defaultMark: Mark = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
const emptyDraft: ScreenshotDraft = { label: '' };

async function screenshotType(file: File): Promise<ImageType> {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if ([0xff, 0xd8, 0xff].every((byte, index) => header[index] === byte)) return 'image/jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => header[index] === byte)) return 'image/png';
  const signature = String.fromCharCode(...header);
  if (signature.startsWith('RIFF') && signature.slice(8) === 'WEBP') return 'image/webp';
  throw new Error('请选择 JPEG、PNG 或 WebP 图片。');
}

function asDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('无法读取这张截图，请重新选择。'));
    reader.readAsDataURL(blob);
  });
}

async function prepareScreenshot(file: File) {
  const type = await screenshotType(file);
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('无法打开这张图片，请换一张截图。');
  });
  try {
    const fileName = file.name;
    if (file.size <= maxProofBytes) {
      return { fileName, width: bitmap.width, height: bitmap.height, dataUrl: await asDataUrl(new Blob([file], { type })) };
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法压缩图片，请选择 600 KiB 以内的截图。');
    const longest = Math.max(bitmap.width, bitmap.height);
    const outputType = type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    let scale = Math.min(1, 1920 / longest);
    for (let attempt = 0; attempt < 8; attempt++, scale *= 0.78) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.74, 0.59, 0.44]) {
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, outputType, quality));
        if (!blob) break;
        if (blob.size <= maxProofBytes) {
          return { fileName, width: canvas.width, height: canvas.height, dataUrl: await asDataUrl(blob) };
        }
        if (blob.type !== outputType) break;
      }
    }
    throw new Error('这张图片无法压缩至 600 KiB，请裁剪后重新选择。');
  } finally {
    bitmap.close();
  }
}

function proofDimensions({ width, height }: Dimensions) {
  return { '--ep-proof-width': width + 'px', '--ep-proof-aspect': width / height } as CSSProperties;
}

function MarkBox({ mark }: { mark?: Mark }) {
  if (!mark) return null;
  return <span className="ep-proof-mark" aria-hidden="true" data-proof-mark
    style={{ left: mark.x * 100 + '%', top: mark.y * 100 + '%', width: mark.width * 100 + '%', height: mark.height * 100 + '%' }} />;
}

const markAxes = [
  { key: 'x', label: '横向位置', other: 'width', min: 0 },
  { key: 'y', label: '纵向位置', other: 'height', min: 0 },
  { key: 'width', label: '框宽', other: 'x', min: 2 },
  { key: 'height', label: '框高', other: 'y', min: 2 },
] as const;

function KeyboardMark({ stageLabel, mark, onChange }: {
  stageLabel: string;
  mark?: Mark;
  onChange: (mark: Mark) => void;
}) {
  const horizontal = useRef<HTMLInputElement>(null);
  const box = mark ?? defaultMark;
  return <details className="ep-proof-keyboard">
    <summary>用键盘标注</summary>
    <div className="ep-proof-keyboard-controls">
      {!mark && <button type="button" className="ep-button" onClick={() => {
        onChange(defaultMark);
        horizontal.current?.focus();
      }}>添加标注框</button>}
      {markAxes.map(axis => {
        const max = Math.max(axis.min, Math.floor((1 - box[axis.other]) * 100 + 1e-8));
        const value = Math.min(max, Math.round(box[axis.key] * 100));
        return <label key={axis.key} className="ep-proof-axis">
          <span>{axis.label} <output aria-hidden="true">{value}%</output></span>
          <input type="range" ref={axis.key === 'x' ? horizontal : undefined} aria-label={stageLabel + '截图' + axis.label}
            min={axis.min} max={max} value={value} aria-valuetext={value + '%'}
            onChange={event => onChange({ ...box, [axis.key]: Number(event.currentTarget.value) / 100 })} />
        </label>;
      })}
    </div>
  </details>;
}

const clamp = (number: number) => Math.max(0, Math.min(1, number));
function pointOnImage(event: PointerEvent<HTMLElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
}
function markBetween(start: Point, end: Point): Mark {
  return {
    x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y),
  };
}

function ScreenshotField({ stage, draft, update }: {
  stage: Stage;
  draft: ScreenshotDraft;
  update: (change: (current: ScreenshotDraft) => ScreenshotDraft) => void;
}) {
  const stageLabel = stageLabels[stage];
  const upload = useRef<HTMLInputElement>(null);
  const preparation = useRef(0);
  const drag = useRef<{ pointerId: number; start: Point }>();
  const [drawing, setDrawing] = useState<Mark>();
  const [dropActive, setDropActive] = useState(false);
  const descriptionId = useId();
  const messageId = useId();
  const submittable = !draft.loading && !draft.error && (draft.image ? Boolean(draft.mark) : stage === 'before');
  useLayoutEffect(() => {
    const problem = draft.loading ? '请等待图片处理完成。' : draft.error || (stage === 'after' && !draft.image
      ? '请上传还后截图。' : '请在图片上框出关键位置。');
    upload.current?.setCustomValidity(submittable ? '' : problem);
  }, [draft.error, draft.image, draft.loading, stage, submittable]);
  useLayoutEffect(() => () => { preparation.current++; }, []);

  async function load(file: File) {
    const sequence = ++preparation.current;
    drag.current = undefined;
    setDrawing(undefined);
    update(current => ({ ...current, loading: true, error: undefined }));
    try {
      const image = await prepareScreenshot(file);
      if (sequence === preparation.current) update(() => ({ label: '', image }));
    } catch (failure) {
      const error = failure instanceof Error ? failure.message : '无法读取这张截图，请重新选择。';
      if (sequence === preparation.current) update(current => ({ ...current, loading: false, error }));
    }
  }

  function remove() {
    preparation.current++;
    drag.current = undefined;
    setDrawing(undefined);
    update(() => emptyDraft);
    upload.current?.focus({ preventScroll: true });
  }

  function updateMark(mark: Mark | undefined) {
    update(current => ({ ...current, mark }));
  }

  function finishMark(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const mark = markBetween(drag.current.start, pointOnImage(event));
    drag.current = undefined;
    setDrawing(undefined);
    if (mark.width >= minMarkSize && mark.height >= minMarkSize) updateMark(mark);
  }

  const description = !draft.image ? 'JPEG、PNG 或 WebP' : draft.image.fileName;
  return <section className="ep-proof-card" data-stage={stage} aria-label={stageLabel + '截图'}>
    <div className="ep-proof-card-head"><strong>{stageLabel}截图</strong>
      <span>{stage === 'before' ? '选填' : '必填'}</span></div>
    <label className="ep-proof-upload" data-has-image={Boolean(draft.image)} data-drop-active={dropActive}
      onDragOver={event => { event.preventDefault(); setDropActive(true); }}
      onDragLeave={() => setDropActive(false)}
      onDrop={event => {
        event.preventDefault();
        setDropActive(false);
        const file = event.dataTransfer.files[0];
        if (file) void load(file);
      }}>
      <input className="sr-only" type="file" aria-label={'上传' + stageLabel + '截图'} ref={upload}
        aria-required={stage === 'after'} aria-describedby={descriptionId + ' ' + messageId}
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void load(file);
        }} />
      <ImagePlus aria-hidden="true" /><span>{draft.image ? '更换图片' : '上传' + stageLabel + '截图'}</span>
      {!draft.image && <small id={descriptionId}>{description}</small>}
    </label>
    <div id={messageId}>
      {draft.loading && <ContentLoading variant="inline" label="正在处理图片" />}
      {draft.error && <p className="ep-proof-error" role="alert">{draft.error}</p>}
      {draft.image && <p className="ep-proof-filename" id={descriptionId} title={draft.image.fileName}>{description}</p>}
    </div>
    {draft.image && <div className="ep-proof-edit" aria-busy={draft.loading || undefined}>
      <div className="ep-proof-preview">
        <div className="ep-proof-frame ep-proof-canvas" data-proof-canvas style={proofDimensions(draft.image)}
          onPointerDown={event => {
            if (draft.loading || !event.isPrimary || event.button !== 0) return;
            event.preventDefault();
            const start = pointOnImage(event);
            drag.current = { pointerId: event.pointerId, start };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            if (drag.current?.pointerId === event.pointerId) setDrawing(markBetween(drag.current.start, pointOnImage(event)));
          }}
          onPointerUp={finishMark}
          onLostPointerCapture={() => { drag.current = undefined; setDrawing(undefined); }}>
          <img src={draft.image.dataUrl} alt={stageLabel + '截图预览'} draggable={false} />
          <MarkBox mark={drawing ?? draft.mark} />
        </div>
      </div>
      <p className="ep-caption">{draft.mark ? '已标注关键位置，可拖动重画。' : '在图上拖动，框出需要核对的位置。'}</p>
      <label className="ep-field"><span>{stageLabel}截图说明</span>
        <input type="text" required maxLength={500} value={draft.label}
          placeholder={stage === 'after' ? '变化在哪里，验证结果是什么' : '处理前的问题出现在哪里'}
          onChange={event => {
            const label = event.currentTarget.value;
            event.currentTarget.setCustomValidity(label && !label.trim() ? '请填写截图说明。' : '');
            update(current => ({ ...current, label }));
          }} /></label>
      <KeyboardMark stageLabel={stageLabel} mark={draft.mark} onChange={updateMark} />
    </div>}
    <div className="ep-proof-actions">
      {draft.mark && <button type="button" className="ep-button" onClick={() => updateMark(undefined)}>清除标注</button>}
      {(draft.image || draft.loading || draft.error) && <button type="button" className="ep-button" onClick={remove}>
        {draft.image ? '移除截图' : '清除选择'}</button>}
    </div>
  </section>;
}

export function DebtScreenshotFields({ onReadyChange }: { onReadyChange?: (ready: boolean) => void } = {}) {
  const [drafts, setDrafts] = useState({ before: emptyDraft, after: emptyDraft });
  const ready = Boolean(drafts.after.image) && stages.every(stage => {
    const draft = drafts[stage];
    return !draft.loading && !draft.error && (!draft.image || (Boolean(draft.label.trim()) && Boolean(draft.mark)));
  });
  useLayoutEffect(() => { onReadyChange?.(ready); }, [onReadyChange, ready]);
  const proofs = stages.flatMap(stage => {
    const draft = drafts[stage];
    return draft.image ? [{ stage, label: draft.label.trim(), dataUrl: draft.image.dataUrl, mark: draft.mark }] : [];
  });
  return <fieldset className="ep-proof-fields">
    <legend>截图证明</legend>
    <p className="ep-caption">附上还后截图。每张截图都要写明它证明了什么，并框出关键位置。</p>
    <div className="ep-proof-grid">
      {stages.map(stage => <ScreenshotField key={stage} stage={stage} draft={drafts[stage]}
        update={change => setDrafts(current => ({ ...current, [stage]: change(current[stage]) }))} />)}
    </div>
    <input type="hidden" name="repaymentProofs" value={JSON.stringify(proofs)} />
  </fieldset>;
}

function ProofImage({ src, alt, mark }: { src: string; alt: string; mark?: Mark }) {
  const [failed, setFailed] = useState(false);
  const [dimensions, setDimensions] = useState<Dimensions>();
  if (failed) return <span className="ep-proof-missing">暂时无法读取截图</span>;
  return <span className="ep-proof-frame" style={dimensions ? proofDimensions(dimensions) : undefined}>
    <img src={src} alt={alt} draggable={false}
      onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
      onError={() => setFailed(true)} />
    {dimensions && <MarkBox mark={mark} />}
  </span>;
}

function screenshotPath(projectId: string, id: string) {
  return '/api/projects/' + encodeURIComponent(projectId) + '/planning/evidence/' + encodeURIComponent(id);
}

export function DebtScreenshotGallery({ items, projectId }: { items?: PlanningEvidence[]; projectId: string }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [zoomed, setZoomed] = useState(false);
  const zoomImage = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement>();
  const screenshots = (items ?? []).filter((item): item is StoredScreenshot => item.image !== undefined);
  const selected = screenshots.find(({ image }) => image.id === selectedId);
  useLayoutEffect(() => {
    if (zoomed) zoomImage.current?.querySelector('[data-proof-mark]')?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [selectedId, zoomed]);
  if (!screenshots.length) return null;
  function show(id: string, trigger?: HTMLButtonElement) {
    if (trigger) returnFocus.current = trigger;
    setZoomed(false);
    setSelectedId(id);
  }

  return <>
    <div className="ep-proof-grid ep-proof-gallery" role="group" aria-label="偿还截图">
      {stages.flatMap(stage => screenshots.filter(row => row.image.stage === stage)).map(({ image, label }) =>
        <figure className="ep-proof-figure" key={image.id} data-stage={image.stage}>
          <button type="button" className="ep-proof-preview ep-proof-thumbnail" onClick={event => show(image.id, event.currentTarget)}
            aria-label={'放大查看' + stageLabels[image.stage] + '截图 · ' + label}>
            <ProofImage key={projectId} src={screenshotPath(projectId, image.id)} alt="" mark={image.mark} />
            <ZoomIn aria-hidden="true" />
          </button>
          <figcaption><strong>{stageLabels[image.stage]}</strong><span>{label}</span></figcaption>
        </figure>)}
    </div>
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) setSelectedId(undefined); }}>
      {selected && <DialogContent frame className="ep-dialog ep-proof-zoom" overlayClassName="ep-dialog-overlay ep-proof-zoom-overlay"
        style={{ width: '61rem', maxWidth: 'none', maxHeight: '92dvh' }}
        onCloseAutoFocus={event => {
          const trigger = returnFocus.current;
          returnFocus.current = undefined;
          if (!trigger?.isConnected || !trigger.getClientRects().length) return;
          event.preventDefault();
          trigger.focus({ preventScroll: true });
        }}>
        <DialogHeader className="ep-dialog-head">
          <DialogTitle>{stageLabels[selected.image.stage]}截图</DialogTitle>
          <DialogDescription>{selected.label}</DialogDescription>
        </DialogHeader>
        <div className="ep-proof-zoom-actions">
          {screenshots.filter(row => row.image.id !== selectedId).map(row =>
            <button type="button" className="ep-button" key={row.image.id} onClick={() => show(row.image.id)}>
              查看{stageLabels[row.image.stage]}截图
            </button>)}
          <button type="button" className="ep-button" aria-pressed={zoomed}
            onClick={() => setZoomed(value => !value)}>{zoomed ? '适合窗口' : '放大'}</button>
        </div>
        <DialogBody className="ep-proof-zoom-body" data-zoomed={zoomed} style={{ minHeight: 0, overflow: 'auto' }}
          tabIndex={zoomed ? 0 : undefined} role="region" aria-label="截图预览">
          <div ref={zoomImage}>
            <ProofImage key={projectId + '/' + selected.image.id} src={screenshotPath(projectId, selected.image.id)}
              alt={selected.label} mark={selected.image.mark} />
          </div>
        </DialogBody>
      </DialogContent>}
    </Dialog>
  </>;
}
