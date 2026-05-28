import { createElement } from 'react';
import type { LucideIcon } from 'lucide-react';
import { PaSecretaryIcon } from '@/pages/ai-toolbox/components/PaSecretaryIcon';

/** 毒舌秘书在 toolbox / nav / launcher 中注册的图标名 */
export const PA_SECRETARY_ICON = 'PaSecretary' as const;

/** 兼容 LucideIcon 槽位（ICON_MAP / iconMap） */
export const PaSecretary = PaSecretaryIcon as unknown as LucideIcon;

export function isPaSecretaryIcon(name: string | undefined): boolean {
  return name === PA_SECRETARY_ICON;
}

/** 侧栏 / Cmd+K / 导航编辑器等动态 Lucide 查找前的自定义图标渲染 */
export function renderPaSecretaryIconNode(size: number) {
  return createElement(PaSecretaryIcon, { size });
}
