import { useEffect, useState } from 'react';
import { getRelatedSummaries, type RelatedSummary } from '@/services/real/relatedDocuments';
import { useAuthStore } from '@/stores/authStore';

export function useRelatedSummaries(siteIds: string[]) {
  const key = [...new Set(siteIds)].sort().join(',');
  const token = useAuthStore(state => state.token);
  const [state, setState] = useState<{ token: string | null; items: Record<string, RelatedSummary> }>({ token, items: {} });
  useEffect(() => {
    let alive = true;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const request = ++generation;
      if (!key) { setState({ token, items: {} }); return; }
      const ids = key.split(',');
      const batches = await Promise.all(Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => getRelatedSummaries(ids.slice(i * 100, (i + 1) * 100))));
      if (alive && request === generation) setState({ token, items: Object.assign({}, ...batches.filter(r => r.success).map(r => r.data.items)) });
    };
    void refresh();
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 80); };
    window.addEventListener('focus', schedule);
    window.addEventListener('hosted-comments-changed', schedule);
    window.addEventListener('hosted-relations-changed', schedule);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener('focus', schedule); window.removeEventListener('hosted-comments-changed', schedule); window.removeEventListener('hosted-relations-changed', schedule); };
  }, [key, token]);
  return state.token === token ? state.items : {};
}
