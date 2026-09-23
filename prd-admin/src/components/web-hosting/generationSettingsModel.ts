import type {
  DesignGenerationRuntime,
  DesignGenerationSettings,
  DesignGenerationSettingsUpdate,
  DesignGenerationStyle,
  DesignPromptKind,
  DesignReviewMode,
} from '@/services/real/webPages';

/**
 * 网页生成设置页的纯逻辑：注册表文案 + 「改了什么」的差异计算。
 * 与界面分开，是为了让「只提交改过的字段」「恢复默认传空串」这两条契约能被单测直接断言。
 */

export const REVIEW_MODE_REGISTRY: Record<DesignReviewMode, { label: string; description: string }> = {
  off: { label: '关闭', description: '不做模型自查，最快；发布闸门的硬检查仍然照常把关。' },
  light: { label: '轻量', description: '写完后做一轮模型终审，发现问题当场修。' },
  strict: { label: '严格', description: '终审之后再加一轮视觉复查，最慢也最稳。' },
};

export const PROMPT_SECTION_REGISTRY: Record<DesignPromptKind, { label: string; hint: string }> = {
  generate: { label: '创作提示词', hint: '新建页面时交给执行器' },
  edit: { label: '修改提示词', hint: '「帮我修改」时交给执行器' },
  review: { label: '自查提示词', hint: '写完后自查那一轮使用' },
};

export interface GenerationSettingsDraft {
  defaultRuntime: DesignGenerationRuntime;
  reviewMode: DesignReviewMode;
  styles: DesignGenerationStyle[];
  prompts: Record<DesignPromptKind, string>;
}

const SWATCH_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidSwatch(value: string): boolean {
  return SWATCH_RE.test(value);
}

function styleFingerprint(style: DesignGenerationStyle): string {
  return JSON.stringify([
    style.id,
    style.name,
    style.description,
    style.designSystemId,
    style.swatches,
    style.enabled,
    style.isDefault,
  ]);
}

/**
 * 只提交改过的字段（后端 PUT 支持部分提交）。
 * 提示词等于默认稿时提交空串——那是契约里「恢复默认」的写法，也让指纹回到默认值。
 */
export function buildGenerationSettingsPatch(
  settings: DesignGenerationSettings,
  draft: GenerationSettingsDraft,
): DesignGenerationSettingsUpdate {
  const patch: DesignGenerationSettingsUpdate = {};
  if (draft.defaultRuntime !== settings.defaultRuntime) patch.defaultRuntime = draft.defaultRuntime;
  if (draft.reviewMode !== settings.reviewMode) patch.reviewMode = draft.reviewMode;

  const before = settings.styles.map(styleFingerprint).join('|');
  const after = draft.styles.map(styleFingerprint).join('|');
  if (before !== after) {
    patch.styles = draft.styles.map((style) => ({
      id: style.id,
      name: style.name.trim(),
      description: style.description.trim(),
      designSystemId: style.designSystemId.trim(),
      swatches: style.swatches.slice(0, 3),
      enabled: style.enabled,
      isDefault: style.isDefault,
    }));
  }

  const prompts: Partial<Record<DesignPromptKind, string>> = {};
  (Object.keys(PROMPT_SECTION_REGISTRY) as DesignPromptKind[]).forEach((kind) => {
    const current = settings.prompts[kind];
    const next = draft.prompts[kind];
    if (next === current.value) return;
    prompts[kind] = next === current.defaultValue || !next.trim() ? '' : next;
  });
  if (Object.keys(prompts).length > 0) patch.prompts = prompts;
  return patch;
}

/** 「复制全部」：按运行时的拼接顺序（平台契约在前，三段提示词在后）给出一整块文本。 */
export function composePromptBundle(
  platformContract: string,
  prompts: Record<DesignPromptKind, string>,
): string {
  const sections = [
    ['平台契约（只读）', platformContract],
    ...(Object.keys(PROMPT_SECTION_REGISTRY) as DesignPromptKind[])
      .map((kind) => [PROMPT_SECTION_REGISTRY[kind].label, prompts[kind]] as const),
  ];
  return sections
    .map(([label, text]) => `## ${label}\n\n${(text || '').trim()}`)
    .join('\n\n');
}
