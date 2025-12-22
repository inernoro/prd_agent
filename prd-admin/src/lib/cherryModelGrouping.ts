// Cherry Studio 兼容：分组规则（getDefaultGroupName + dashscope 的 groupQwenModels 前缀细分）

const strongSeparatorProviders = new Set(['aihubmix', 'silicon', 'ocoolai', 'o3', 'dmxapi']);

export function getLowerBaseModelName(modelId: string): string {
  let s = (modelId ?? '').trim().toLowerCase();
  const slash = s.lastIndexOf('/');
  if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);
  const colon = s.lastIndexOf(':');
  if (colon >= 0 && colon < s.length - 1) s = s.slice(colon + 1);
  return s;
}

export function getDefaultGroupName(id: string, provider?: string): string {
  const str = (id ?? '').toLowerCase();

  let firstDelimiters = ['/', ' ', ':'];
  let secondDelimiters = ['-', '_'];

  const p = (provider ?? '').trim().toLowerCase();
  if (p && strongSeparatorProviders.has(p)) {
    firstDelimiters = ['/', ' ', '-', '_', ':'];
    secondDelimiters = [];
  }

  for (const delimiter of firstDelimiters) {
    if (str.includes(delimiter)) return str.split(delimiter)[0];
  }

  for (const delimiter of secondDelimiters) {
    if (str.includes(delimiter)) {
      const parts = str.split(delimiter);
      return parts.length > 1 ? parts[0] + '-' + parts[1] : parts[0];
    }
  }

  return str;
}

export function getDashscopeQwenGroupKey(modelId: string): string | null {
  const base = getLowerBaseModelName(modelId);
  const m = base.match(/^(qwen(?:\d+\.\d+|2(?:\.\d+)?|-\d+b|-(?:max|coder|vl)))/i);
  return m ? m[1].toLowerCase() : null;
}

export function resolveCherryGroupKey(modelId: string, providerId?: string): string {
  const p = (providerId ?? '').trim().toLowerCase();
  if (p === 'dashscope') {
    const base = getLowerBaseModelName(modelId);
    if (base.startsWith('qwen')) {
      const q = getDashscopeQwenGroupKey(base);
      if (q) return q;
    }
  }
  return getDefaultGroupName(modelId, p);
}



