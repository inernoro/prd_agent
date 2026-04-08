import { useEffect, useState } from 'react';
import { ScanSearch, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiRequest } from '@/services/real/apiClient';

/**
 * PR审查棱镜：与「产品评审员」(review-agent) 为独立应用；当前为占位页，后续接入 PR 审查主流程。
 */
export function PrReviewPrismPage() {
  const navigate = useNavigate();
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiRequest<{ appKey: string; phase: string; message: string }>(
        '/api/pr-review-prism/status',
        { method: 'GET' }
      );
      if (!cancelled && res.success && res.data?.message) {
        setHint(res.data.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white/80 mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        返回首页
      </button>

      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 rounded-xl bg-violet-500/15 flex items-center justify-center border border-violet-500/20">
          <ScanSearch className="w-6 h-6 text-violet-300" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">PR审查棱镜</h1>
          <p className="text-sm text-white/45 mt-0.5">PR / MR 变更专项审查（独立于产品评审员）</p>
        </div>
      </div>

      <div
        className="rounded-xl p-5 border text-sm leading-relaxed"
        style={{
          background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
          borderColor: 'rgba(255,255,255,0.08)',
          color: 'var(--text-muted, rgba(255,255,255,0.55))',
        }}
      >
        {hint ?? '正在连接服务…'}
      </div>
    </div>
  );
}
