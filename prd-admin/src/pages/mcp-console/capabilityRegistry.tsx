import { BookOpen, Globe, Image, ListTodo, PenLine, Store, Volume2, type LucideIcon } from 'lucide-react';

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
  speech: {
    icon: Volume2,
    text: 'var(--text-secondary)',
    soft: 'var(--bg-sunken)',
    border: 'var(--border-subtle)',
  },
  visual: {
    icon: Image,
    text: 'var(--text-secondary)',
    soft: 'var(--bg-sunken)',
    border: 'var(--border-subtle)',
  },
  literary: {
    icon: PenLine,
    text: 'var(--text-secondary)',
    soft: 'var(--bg-sunken)',
    border: 'var(--border-subtle)',
  },
  knowledge: {
    icon: BookOpen,
    text: 'var(--text-secondary)',
    soft: 'var(--bg-sunken)',
    border: 'var(--border-subtle)',
  },
  web: {
    icon: Globe,
    text: 'var(--text-secondary)',
    soft: 'var(--bg-sunken)',
    border: 'var(--border-subtle)',
  },
  tasks: {
    icon: ListTodo,
    text: 'var(--text-secondary)',
    soft: 'var(--bg-sunken)',
    border: 'var(--border-subtle)',
  },
  market: {
    icon: Store,
    text: 'var(--text-secondary)',
    soft: 'var(--bg-sunken)',
    border: 'var(--border-subtle)',
  },
};

const FALLBACK: CapabilityVisual = {
  icon: Store,
  text: 'var(--text-secondary)',
  soft: 'var(--bg-sunken)',
  border: 'var(--border-subtle)',
};

export function capabilityVisual(key: string): CapabilityVisual {
  return CAPABILITY_VISUAL_REGISTRY[key] ?? FALLBACK;
}
