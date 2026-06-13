/**
 * 版本工作流详情 — 需求 / 功能可点击列表（跳转对象详情）。
 */
import { useNavigate } from 'react-router-dom';
import type { Feature, Requirement } from './types';

const GRADE_LABEL: Record<string, string> = {
  p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3',
};

export function RequirementLinkList({
  productId,
  requirements,
  emptyText = '暂无关联需求',
  sectionTitle,
}: {
  productId: string;
  requirements: Requirement[];
  emptyText?: string;
  sectionTitle?: string;
}) {
  const navigate = useNavigate();
  if (requirements.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-white/35">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {sectionTitle && <div className="text-xs text-white/45">{sectionTitle}</div>}
      {requirements.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => navigate(`/product-agent/p/${productId}/requirement/${r.id}`)}
          className="flex w-full items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-left hover:border-cyan-400/30 hover:bg-cyan-400/5"
        >
          <span className="shrink-0 rounded border border-cyan-400/25 bg-cyan-400/10 px-1.5 py-0.5 text-[10px] font-mono text-cyan-200">
            {r.requirementNo}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-white/85">{r.title}</span>
            {r.grade && (
              <span className="mt-0.5 inline-block text-[10px] text-white/40">{GRADE_LABEL[r.grade] ?? r.grade}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

export function FeatureLinkList({
  productId,
  features,
  emptyText = '暂无关联功能',
  sectionTitle,
}: {
  productId: string;
  features: Feature[];
  emptyText?: string;
  sectionTitle?: string;
}) {
  const navigate = useNavigate();
  if (features.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-white/35">
        {emptyText}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {sectionTitle && <div className="text-xs text-white/45">{sectionTitle}</div>}
      {features.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => navigate(`/product-agent/p/${productId}/feature/${f.id}`)}
          className="flex w-full items-start gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-left hover:border-cyan-400/30 hover:bg-cyan-400/5"
        >
          <span className="shrink-0 rounded border border-violet-400/25 bg-violet-400/10 px-1.5 py-0.5 text-[10px] font-mono text-violet-200">
            {f.featureNo}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-white/85">{f.title}</span>
            {f.requirementIds.length > 0 && (
              <span className="mt-0.5 inline-block text-[10px] text-white/40">关联需求 {f.requirementIds.length} 条</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
