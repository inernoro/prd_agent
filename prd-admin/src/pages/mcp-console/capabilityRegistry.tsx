import { BookOpen, Globe, Image, PenLine, Store, type LucideIcon } from 'lucide-react';

/**
 * 能力卡的视觉登记表 —— 图标与配色按 `capability.key` 查，不在组件里写 switch。
 *
 * 这里**只管长相**。「有哪些能力、叫什么、我有没有权限」全部来自后端的
 * `McpCapabilityCatalog`（前端不维护第二份业务清单，见 frontend-architecture 规则）。
 * 后端加一块新能力时，这里查不到就落到 fallback，界面照常渲染，不会白屏也不会漏项。
 */
export interface CapabilityVisual {
  icon: LucideIcon;
  /** 文字色 token */
  text: string;
  /** 底色 token */
  soft: string;
  /** 描边 token */
  border: string;
}

export const CAPABILITY_VISUAL_REGISTRY: Record<string, CapabilityVisual> = {
  visual: {
    icon: Image,
    text: 'var(--semantic-purple-text)',
    soft: 'var(--semantic-purple-soft)',
    border: 'var(--semantic-purple-border)',
  },
  literary: {
    icon: PenLine,
    text: 'var(--semantic-indigo-text)',
    soft: 'var(--semantic-indigo-soft)',
    border: 'var(--semantic-indigo-border)',
  },
  knowledge: {
    icon: BookOpen,
    text: 'var(--semantic-cyan-text)',
    soft: 'var(--semantic-cyan-soft)',
    border: 'var(--semantic-cyan-border)',
  },
  web: {
    icon: Globe,
    text: 'var(--semantic-success-text)',
    soft: 'var(--semantic-success-soft)',
    border: 'var(--semantic-success-border)',
  },
  market: {
    icon: Store,
    text: 'var(--semantic-orange-text)',
    soft: 'var(--semantic-orange-soft)',
    border: 'var(--semantic-orange-border)',
  },
};

const FALLBACK: CapabilityVisual = {
  icon: Store,
  text: 'var(--semantic-neutral-text)',
  soft: 'var(--semantic-neutral-soft)',
  border: 'var(--semantic-neutral-border)',
};

export function capabilityVisual(key: string): CapabilityVisual {
  return CAPABILITY_VISUAL_REGISTRY[key] ?? FALLBACK;
}
