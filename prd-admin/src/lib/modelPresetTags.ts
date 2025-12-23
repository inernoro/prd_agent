export type PresetTagKey =
  | 'reasoning'
  | 'vision'
  | 'websearch'
  | 'function_calling'
  | 'embedding'
  | 'rerank'
  | 'image_generation'
  | 'free';

import type { CherryAvailableTab } from '@/lib/cherryStudioModelTags';
import { getCherryPresetTags, matchCherryAvailableTab } from '@/lib/cherryStudioModelTags';

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * 预设标签（轻量启发式）：用于“可用模型列表”里给用户快速判断模型类型。
 * - 不做持久化；每次刷新/打开都会重新推断
 * - 只依赖 modelName/displayName/providerId（避免引入后端协议变更）
 *
 * 设计目标：
 * - 尽量贴近 Cherry Studio 的默认体验（regex 判定 + provider 特例）
 * - 不引入 capabilities（我们当前 available-models 接口没有该字段）
 */
export function inferPresetTagKeys(modelName: string, displayName?: string, providerId?: string, platformType?: string): PresetTagKey[] {
  // 统一走 Cherry Studio 的默认判定（仅依赖 id/name/providerId）
  // 注意：我们的 available-models 当前没有 capabilities，因此这里是“默认判定一致”，不含用户手动覆盖。
  const tags = getCherryPresetTags({
    id: modelName,
    name: displayName ?? modelName,
    providerId: providerId ?? '',
    platformType,
  });

  // 映射到我们 UI 的 tag key
  const out = tags.map((t) => (t === 'websearch' ? 'websearch' : t)) as PresetTagKey[];
  return uniq(out);
}

export type AvailableModelsTabKey = 'all' | 'reasoning' | 'vision' | 'web' | 'free' | 'embedding' | 'rerank' | 'tools';

/**
 * 用于“可用模型弹窗”的 Tab 过滤（允许一个模型同时出现在多个 Tab）。
 * - reasoning：默认兜底（除 embedding/rerank/t2i）
 * - web/tools 等：基于 tags 命中
 */
export function matchAvailableModelsTab(args: {
  tab: AvailableModelsTabKey;
  modelName: string;
  displayName?: string;
  providerId?: string;
  platformType?: string;
}): boolean {
  const { tab, modelName, displayName, providerId, platformType } = args;
  return matchCherryAvailableTab(tab as CherryAvailableTab, {
    id: modelName,
    name: displayName ?? modelName,
    providerId: providerId ?? '',
    platformType,
  });
}



