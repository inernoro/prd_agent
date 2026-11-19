import { useState } from 'react';
import { Heading1, Heading2, Image, MapPin, PenLine, Stamp, Wand2 } from 'lucide-react';
import { getAvatarUrlByModelName, useAvatarUpdates } from '@/assets/model-avatars';

const positionIcons = { auto: Wand2, 'user-anchor': MapPin, 'per-h1': Heading1, 'per-h2': Heading2 };

function ModelIcon({ name, label, fallback: Fallback }: { name?: string; label: string; fallback: typeof PenLine }) {
  const avatar = name ? getAvatarUrlByModelName(name) : null;
  const description = name ? `${label}：${name}` : label;
  return (
    <span className="lit-settings-summary-icon" role="img" aria-label={description} title={description}>
      {avatar ? <img src={avatar} alt="" /> : <Fallback size={15} aria-hidden />}
    </span>
  );
}

export function LiterarySettingsSummary({ writingModel, imageModel, watermarkName, watermarkPreview, position, positionLabel }: {
  writingModel?: string;
  imageModel?: string;
  watermarkName: string;
  watermarkPreview?: string | null;
  position: keyof typeof positionIcons;
  positionLabel: string;
}) {
  useAvatarUpdates();
  const [failedPreview, setFailedPreview] = useState<string | null>(null);
  const PositionIcon = positionIcons[position];
  const watermarkLabel = `水印：${watermarkName}`;
  return (
    <span className="lit-settings-summary-icons">
      <ModelIcon label="写作模型" name={writingModel} fallback={PenLine} />
      <ModelIcon label="配图模型" name={imageModel} fallback={Image} />
      <span className="lit-settings-summary-icon lit-settings-summary-optional lit-settings-summary-watermark"
        role="img" aria-label={watermarkLabel} title={watermarkLabel}>
        {watermarkPreview && watermarkPreview !== failedPreview
          ? <img src={watermarkPreview} alt="" loading="lazy" onError={() => setFailedPreview(watermarkPreview)} />
          : <Stamp size={15} aria-hidden />}
      </span>
      <span className="lit-settings-summary-icon lit-settings-summary-optional" aria-hidden="true" title={positionLabel}>
        <PositionIcon size={15} />
      </span>
    </span>
  );
}
