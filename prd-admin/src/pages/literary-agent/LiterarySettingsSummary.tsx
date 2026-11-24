import { useEffect, useState, type ReactNode } from 'react';
import { createLucideIcon, Heading1, Heading2, Image, MapPin, PenLine, Stamp, Wand2 } from 'lucide-react';
import { getAvatarUrlByModelName, useAvatarUpdates } from '@/assets/model-avatars';
import { computeAlphaBounds } from '@/lib/layerTrim';
import { getWatermarkPreview } from '@/services/real/watermark';

const ParagraphBookmark = createLucideIcon('ParagraphBookmark', [
  ['path', { d: 'M3 5h18M3 10h9M3 15h8M3 20h5', key: 'paragraph' }],
  ['path', { d: 'M15 10h6v10l-3-2-3 2z', stroke: 'var(--accent-primary)', key: 'bookmark' }],
]);

const positionIcons = { auto: Wand2, 'user-anchor': ParagraphBookmark, 'per-h1': Heading1, 'per-h2': Heading2 };

export function LiteraryPositionIcon({ position }: { position: keyof typeof positionIcons }) {
  const Icon = positionIcons[position];
  return <Icon size={15} aria-hidden />;
}

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

export function useLiteraryWatermarkPreview(id?: string, updatedAt?: string) {
  const [preview, setPreview] = useState<{ id: string; updatedAt?: string; url: string }>();
  useEffect(() => {
    if (!id) return;
    let active = true;
    let previewUrl: string | undefined;
    void getWatermarkPreview(id, updatedAt).then(cropWatermarkPreview).then(blob => {
      if (!active) return;
      previewUrl = URL.createObjectURL(blob);
      setPreview({ id, updatedAt, url: previewUrl });
    }).catch(() => {});
    return () => {
      active = false;
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreview(current => current?.url === previewUrl ? undefined : current);
      }
    };
  }, [id, updatedAt]);

  return preview && preview.id === id && preview.updatedAt === updatedAt ? preview.url : undefined;
}

export function LiterarySettingImage({ src, className, loading, fallback = null }: {
  src?: string | null; className?: string; loading?: 'lazy'; fallback?: ReactNode;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return src && src !== failedSrc
    ? <img src={src} className={className} alt="" loading={loading} decoding="async" onError={() => setFailedSrc(src)} />
    : fallback;
}

export function LiteraryWatermarkOptionPreview({ id, updatedAt }: { id: string; updatedAt?: string }) {
  const src = useLiteraryWatermarkPreview(id, updatedAt);
  return <LiterarySettingImage src={src} className="lit-settings-watermark-preview" />;
}

export function LiteraryModelIcon({ name, fallback }: { name?: string; fallback: ReactNode }) {
  const avatar = name ? getAvatarUrlByModelName(name) : null;
  return avatar ? <img src={avatar} alt="" /> : fallback;
}

function ModelIcon({ name, label, fallback }: { name?: string; label: string; fallback: ReactNode }) {
  const description = name ? `${label}：${name}` : label;
  return (
    <span className="lit-settings-summary-icon" role="img" aria-label={description} title={description}>
      <LiteraryModelIcon name={name} fallback={fallback} />
    </span>
  );
}

export function LiterarySettingsSummary({ writingModel, imageModel, watermarkName, watermarkPreview, position, positionLabel }: {
  writingModel?: string;
  imageModel?: string;
  watermarkName: string;
  watermarkPreview?: string;
  position: keyof typeof positionIcons;
  positionLabel: string;
}) {
  useAvatarUpdates();
  const watermarkLabel = `水印：${watermarkName}`;
  return (
    <span className="lit-settings-summary-icons">
      <ModelIcon label="写作模型" name={writingModel} fallback={<PenLine size={16} aria-hidden />} />
      <ModelIcon label="配图模型" name={imageModel} fallback={<Image size={16} aria-hidden />} />
      <span className="lit-settings-summary-icon lit-settings-summary-watermark" role="img" aria-label={watermarkLabel} title={watermarkLabel}>
        <LiterarySettingImage src={watermarkPreview} fallback={<Stamp size={15} aria-hidden />} />
      </span>
      <span className="lit-settings-summary-icon lit-settings-summary-position" role="img" aria-label={positionLabel} title={positionLabel}>
        {position === 'user-anchor' ? <MapPin size={16} aria-hidden /> : <LiteraryPositionIcon position={position} />}
      </span>
    </span>
  );
}
