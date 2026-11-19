import { useEffect, useState } from 'react';
import { createLucideIcon, Heading1, Heading2, Image, PenLine, Stamp, Wand2 } from 'lucide-react';
import { getAvatarUrlByModelName, useAvatarUpdates } from '@/assets/model-avatars';
import { computeAlphaBounds } from '@/lib/layerTrim';
import { getWatermarkPreview } from '@/services/real/watermark';

const ParagraphBookmark = createLucideIcon('ParagraphBookmark', [
  ['path', { d: 'M3 5h18M3 10h9M3 15h8M3 20h5', key: 'paragraph' }],
  ['path', { d: 'M15 10h6v10l-3-2-3 2z', stroke: 'var(--accent-primary)', key: 'bookmark' }],
]);

const positionIcons = { auto: Wand2, 'user-anchor': ParagraphBookmark, 'per-h1': Heading1, 'per-h2': Heading2 };

async function cropWatermarkPreview(blob: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    try {
      if (!context) return blob;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const bounds = computeAlphaBounds(data, canvas.width, canvas.height, 0);
    if (!bounds || (bounds.width === canvas.width && bounds.height === canvas.height)) return blob;
    const cropped = context.getImageData(bounds.left, bounds.top, bounds.width, bounds.height);
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    context.putImageData(cropped, 0, 0);
    return await new Promise(resolve => canvas.toBlob(result => resolve(result ?? blob)));
  } catch {
    return blob;
  }
}

function WatermarkIcon({ id, updatedAt }: { id?: string; updatedAt?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let active = true;
    let previewUrl: string | undefined;
    void getWatermarkPreview(id, updatedAt).then(cropWatermarkPreview).then(blob => {
      if (!active) return;
      previewUrl = URL.createObjectURL(blob);
      setSrc(previewUrl);
    }).catch(() => {});
    return () => {
      active = false;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [id, updatedAt]);

  return src ? <img src={src} alt="" onError={() => setSrc(null)} /> : <Stamp size={15} aria-hidden />;
}

function ModelIcon({ name, label, fallback: Fallback }: { name?: string; label: string; fallback: typeof PenLine }) {
  const avatar = name ? getAvatarUrlByModelName(name) : null;
  const description = name ? `${label}：${name}` : label;
  return (
    <span className="lit-settings-summary-icon" role="img" aria-label={description} title={description}>
      {avatar ? <img src={avatar} alt="" /> : <Fallback size={15} aria-hidden />}
    </span>
  );
}

export function LiterarySettingsSummary({ writingModel, imageModel, watermarkName, watermarkId, watermarkUpdatedAt, position, positionLabel }: {
  writingModel?: string;
  imageModel?: string;
  watermarkName: string;
  watermarkId?: string;
  watermarkUpdatedAt?: string;
  position: keyof typeof positionIcons;
  positionLabel: string;
}) {
  useAvatarUpdates();
  const PositionIcon = positionIcons[position];
  const watermarkLabel = `水印：${watermarkName}`;
  return (
    <>
      <span className="lit-settings-summary-watermark" role="img" aria-label={watermarkLabel} title={watermarkLabel}>
        <WatermarkIcon key={JSON.stringify([watermarkId, watermarkUpdatedAt])} id={watermarkId} updatedAt={watermarkUpdatedAt} />
      </span>
      <span className="lit-settings-value">{positionLabel}</span>
      <span className="lit-settings-summary-icons">
        <ModelIcon label="写作模型" name={writingModel} fallback={PenLine} />
        <ModelIcon label="配图模型" name={imageModel} fallback={Image} />
        <span className="lit-settings-summary-icon lit-settings-summary-optional" aria-hidden="true" title={positionLabel}>
          <PositionIcon size={15} />
        </span>
      </span>
    </>
  );
}
