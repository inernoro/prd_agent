import { useEffect, useState } from 'react';

// 懒加载：不再 eager 加载全部 160+ 个头像文件
// 改为按需加载——仅当组件实际渲染某个头像时才请求对应的文件
const avatarLoaders = import.meta.glob('./*.{svg,png,jpg,jpeg}', { query: '?url', import: 'default' }) as Record<
  string,
  () => Promise<string>
>;

const extPriority = ['svg', 'png', 'jpg', 'jpeg'] as const;
type Ext = (typeof extPriority)[number];

const parseFile = (p: string): { key: string; ext: Ext | null } => {
  const file = p.replace(/^\.\//, '');
  const m = /^(.+)\.(svg|png|jpg|jpeg)$/i.exec(file);
  if (!m) return { key: '', ext: null };
  return { key: m[1].toLowerCase(), ext: m[2].toLowerCase() as Ext };
};

// 从 glob keys 同步构建可用头像索引（零 HTTP 请求）
// 每个 key 记录最佳格式的 loader 路径
const keyToEntry = new Map<string, { path: string; url: string | null; rank: number }>();

for (const path of Object.keys(avatarLoaders)) {
  const { key, ext } = parseFile(path);
  if (!key || !ext) continue;
  const rank = extPriority.indexOf(ext);
  const prev = keyToEntry.get(key);
  if (!prev || rank < prev.rank) {
    keyToEntry.set(key, { path, url: null, rank });
  }
}

const availableKeys = Array.from(keyToEntry.keys())
  .filter(Boolean)
  // 长 key 优先匹配（避免 "gpt" 抢占 "chatgpt"）
  .sort((a, b) => b.length - a.length);

// 头像加载完成通知（供 React 组件订阅以触发重渲染）
const listeners = new Set<() => void>();

/**
 * 在组件中调用以订阅头像加载事件，确保懒加载的头像显示后触发重渲染
 */
export function useAvatarUpdates() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
}

// 正在加载中的 key，避免重复触发
const loadingKeys = new Set<string>();

const getByKey = (key: string): string | null => {
  const k = (key || '').toLowerCase();
  const entry = keyToEntry.get(k);
  if (!entry) return null;

  // 已加载：直接返回
  if (entry.url) return entry.url;

  // 未加载：触发懒加载
  if (!loadingKeys.has(k)) {
    loadingKeys.add(k);
    const loader = avatarLoaders[entry.path];
    if (loader) {
      loader().then((url) => {
        entry.url = url;
        loadingKeys.delete(k);
        // 通知所有订阅组件重新渲染
        listeners.forEach((fn) => fn());
      });
    }
  }

  return null;
};

// 允许通过 JSON 进行"别名/重定向"配置（无需改代码即可新增规则）
// 例如：{ "google": "gemini", "gpt": "chatgpt" }
import avatarAliases from './avatar-aliases.json';
const aliases: Record<string, string> = (avatarAliases || {}) as Record<string, string>;

const splitTokens = (s: string) =>
  (s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);

const resolveAlias = (token: string) => {
  const t = (token || '').toLowerCase();
  if (!t) return t;
  const mapped = aliases[t];
  return (mapped || t).toLowerCase();
};

const pickByTokens = (raw: string): string | null => {
  const tokens = splitTokens(raw).map(resolveAlias);
  if (tokens.length === 0) return null;

  // 优先取"最后一个 token"（通常是模型家族，如 anthropic-claude -> claude）
  for (let i = tokens.length - 1; i >= 0; i--) {
    const k = tokens[i];
    const u = getByKey(k);
    if (u) return u;
  }

  // 再尝试：任意 token 命中
  for (const k of tokens) {
    const u = getByKey(k);
    if (u) return u;
  }

  return null;
};

/**
 * 分组->图标（动态）：你只需要把图标文件按"token"命名放进同一目录即可自动生效。
 * - token 规则：按非字母数字分隔（`openai-gpt` -> `openai`,`gpt`；`anthropic-claude` -> `anthropic`,`claude`）
 * - 优先级：默认优先使用"最后一个 token"（更像模型家族），不再依赖写死的 provider 规则
 * - 如需特殊映射（如 google->gemini / gpt->chatgpt），写到 `avatar-aliases.json` 即可
 */
export function getAvatarUrlByGroup(groupName: string): string | null {
  const g = (groupName || '').toLowerCase();
  if (!g) return null;

  // 1) token 优先匹配（动态）
  const byTokens = pickByTokens(g);
  if (byTokens) return byTokens;

  // 2) 通用：分组名包含 key
  for (const k of availableKeys) {
    if (g.includes(k)) return getByKey(k);
  }

  // 3) 兜底：使用分组第一个片段
  const first = splitTokens(g)[0];
  if (first) return getByKey(resolveAlias(first));

  return null;
}

/**
 * 平台类型 -> 图标（google 平台按 Gemini 处理）
 */
export function getAvatarUrlByPlatformType(platformType: string): string | null {
  const t = (platformType || '').toLowerCase();
  if (!t) return null;

  // 1) token 匹配（动态）
  const byTokens = pickByTokens(t);
  if (byTokens) return byTokens;

  // 2) 对"google->gemini"做一个通用兜底：如果存在 gemini 图标，则优先使用
  if (t.includes('google')) {
    const gemini = getByKey(resolveAlias('google')) || getByKey('gemini');
    if (gemini) return gemini;
  }

  return getAvatarUrlByGroup(t);
}

/**
 * 模型名 -> 图标
 * - 例外规则：优先按第一个 token（通常是厂商/前缀，如 doubao-xxx -> doubao）匹配
 * - 再退化为通用 token 策略（最后 token 优先，其次任意 token）
 */
export function getAvatarUrlByModelName(modelName: string): string | null {
  const raw = (modelName || '').toLowerCase();
  if (!raw) return null;

  const tokens = splitTokens(raw).map(resolveAlias);
  const first = tokens[0];
  if (first) {
    const u = getByKey(first);
    if (u) return u;
  }

  return pickByTokens(raw);
}
