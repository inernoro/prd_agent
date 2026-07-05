// 协议 chip 注册表（协议保真观测）：把网关解析出的 protocol 渲染成可瞥见的着色标签。
// 注册表模式（frontend-architecture.md）：类型→样式映射集中一处，禁止组件内 switch 硬编码。

export interface ProtocolMeta {
  /** 展示标签 */
  label: string;
  /** 文字色 */
  color: string;
  /** 底色（低饱和，暗/亮主题都可读） */
  bg: string;
}

const PROTOCOL_REGISTRY: Record<string, ProtocolMeta> = {
  openai: { label: 'OpenAI', color: '#34d399', bg: 'rgba(52,211,153,0.14)' },
  claude: { label: 'Claude', color: '#c084fc', bg: 'rgba(192,132,252,0.16)' },
  exchange: { label: 'Exchange', color: '#fbbf24', bg: 'rgba(251,191,36,0.16)' },
  gemini: { label: 'Gemini', color: '#60a5fa', bg: 'rgba(96,165,250,0.16)' },
  'gemini-native': { label: 'Gemini', color: '#60a5fa', bg: 'rgba(96,165,250,0.16)' },
};

const FALLBACK: ProtocolMeta = { label: '', color: '#94a3b8', bg: 'rgba(148,163,184,0.16)' };

/**
 * 取协议元信息。未知协议原样显示（label=原值），存量 null/空返回 null（不渲染 chip）。
 */
export function getProtocolMeta(protocol?: string | null): ProtocolMeta | null {
  if (!protocol || !protocol.trim()) return null;
  const key = protocol.trim().toLowerCase();
  const hit = PROTOCOL_REGISTRY[key];
  if (hit) return hit;
  return { ...FALLBACK, label: protocol.trim() };
}
