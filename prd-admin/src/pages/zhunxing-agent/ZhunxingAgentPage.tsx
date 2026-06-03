import { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { askZhunxing, type ZhunxingAskResponse } from '@/services/real/zhunxing';
import { AlertCircle, Search, ShieldCheck } from 'lucide-react';

const STARTERS = [
  '员工迟到怎么认定？',
  '跨部门交接最少要包含哪些信息？',
  '请假审批的标准流程是什么？',
];

export default function ZhunxingAgentPage() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ZhunxingAskResponse | null>(null);

  const runAsk = async (q?: string) => {
    const text = (q ?? question).trim();
    if (!text || loading) return;

    setLoading(true);
    setError(null);
    try {
      const res = await askZhunxing(text, 3);
      if (!res.success || !res.data) {
        setResult(null);
        setError(res.error?.message || '准星暂时不可用，请稍后重试');
        return;
      }
      setQuestion(text);
      setResult(res.data);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : '网络异常，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-4">
      <div className="max-w-5xl mx-auto flex flex-col gap-4">
        <GlassCard variant="subtle" animated className="p-4">
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: 'rgba(59, 130, 246, 0.15)',
                border: '1px solid rgba(59, 130, 246, 0.35)',
              }}
            >
              <ShieldCheck size={20} style={{ color: '#60A5FA' }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                准星智能体
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                面向公司制度、产研规范、跨部门协作流程的问答入口
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'rgba(255,255,255,0.4)' }}
              />
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void runAsk();
                  }
                }}
                placeholder="输入你的问题，例如：考勤、请假、交接流程..."
                className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm outline-none"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void runAsk(s)}
                  className="px-2.5 py-1 rounded-md text-xs transition-colors"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={() => void runAsk()} disabled={!question.trim() || loading}>
                {loading ? <MapSpinner size={14} color="var(--text-primary)" /> : null}
                提交问题
              </Button>
            </div>
          </div>
        </GlassCard>

        {error && (
          <GlassCard variant="subtle" animated className="p-3 flex items-center gap-2">
            <AlertCircle size={16} style={{ color: '#FB923C' }} />
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
              {error}
            </span>
          </GlassCard>
        )}

        {result && (
          <GlassCard variant="subtle" animated className="p-4">
            <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              回答
            </div>
            <div className="text-sm leading-6 whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
              {result.answer}
            </div>

            {result.followUpSuggestion && (
              <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                建议下一步：{result.followUpSuggestion}
              </div>
            )}

            <div className="mt-4">
              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                依据条款
              </div>
              <div className="flex flex-col gap-2">
                {result.citations.map((c, idx) => (
                  <div
                    key={`${c.documentId}-${c.chapter}-${idx}`}
                    className="rounded-lg p-2.5"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {c.documentTitle} / {c.chapter} / {c.title}
                    </div>
                    <div className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>
                      {c.snippet}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>
        )}
      </div>
    </div>
  );
}
