import { FileText, Globe, Image, Music, Paperclip, type LucideIcon } from 'lucide-react';
import type { AssetCategory, MobileAssetItem } from '@/services/contracts/mobile';

/** 桌面、移动资产页共用的分类展示注册表。 */
export const ASSET_CATEGORY_REGISTRY: Record<AssetCategory, {
  label: string;
  icon: LucideIcon;
  bg: string;
  text: string;
}> = {
  image: { label: '图片', icon: Image, bg: 'rgba(251,146,60,0.15)', text: 'var(--semantic-orange-text)' },
  audio: { label: '音频', icon: Music, bg: 'rgba(129,140,248,0.15)', text: 'var(--semantic-indigo-text)' },
  document: { label: '文档', icon: FileText, bg: 'rgba(129,140,248,0.15)', text: 'var(--semantic-indigo-text)' },
  attachment: { label: '附件', icon: Paperclip, bg: 'var(--bg-input)', text: 'var(--text-muted)' },
  webpage: { label: '网页', icon: Globe, bg: 'rgba(34,197,94,0.15)', text: 'var(--semantic-success-text)' },
};

export const ASSET_CATEGORIES = Object.keys(ASSET_CATEGORY_REGISTRY) as AssetCategory[];

export function isAudioAsset(asset: Pick<MobileAssetItem, 'type' | 'mime'>): boolean {
  return asset.type === 'audio' || !!asset.mime?.toLowerCase().startsWith('audio/');
}
