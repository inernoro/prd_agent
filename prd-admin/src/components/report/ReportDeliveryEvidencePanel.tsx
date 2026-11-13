import type { CSSProperties } from 'react';
import type { ReportDeliverySnapshot, ReportEvidenceCitation } from '@/services/contracts/reportEvidence';
import { reportSourceHref } from './reportEvidenceLinks';

const STATUS_COLOR_REGISTRY: Record<string, string> = {
  complete: 'var(--accent-fg-success, var(--text-primary))',
  passed: 'var(--accent-fg-success, var(--text-primary))',
  released: 'var(--accent-fg-success, var(--text-primary))',
  failed: 'var(--accent-fg-danger, var(--text-primary))',
  stale: 'var(--accent-fg-warning, var(--text-secondary))',
  blocked: 'var(--accent-fg-warning, var(--text-secondary))',
  unknown: 'var(--text-muted)',
};

const boxStyle: CSSProperties = { border: '1px solid var(--border-primary)', background: 'var(--bg-secondary)' };

function EvidenceSources({ sources }: { sources: ReportEvidenceCitation[] }) {
  if (sources.length === 0) return <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>未附可核查来源</p>;
  return (
    <details className="text-[12px]">
      <summary className="cursor-pointer font-medium" style={{ color: 'var(--text-secondary)' }}>核查来源（{sources.length}）</summary>
      <ol className="mt-2 space-y-3">
        {sources.map((source) => {
          const href = reportSourceHref(source.uri);
          return (
            <li key={source.id} className="space-y-1 rounded-lg p-3" style={{ ...boxStyle, overflowWrap: 'anywhere' }}>
              <p style={{ color: 'var(--text-secondary)' }}>{source.excerpt}</p>
              {href ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-claude)' }}>{source.uri}</a> : <p className="font-mono" style={{ color: 'var(--text-muted)' }}>{source.uri}</p>}
              <p style={{ color: 'var(--text-muted)' }}>{source.occurredAt} · {source.kind}{source.revision ? ` · ${source.revision}` : ''}</p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

/** Read-only facts are separate from editable report prose and personal monthly opinions. */
export function ReportDeliveryEvidencePanel({ evidence, title = '交付事实与连续进展' }: { evidence?: ReportDeliverySnapshot; title?: string }) {
  if (!evidence) return (
    <aside role="note" aria-label="来源快照尚未核查" className="mb-6 rounded-xl p-4 text-[12px] leading-relaxed" style={{ ...boxStyle, color: 'var(--text-secondary)' }}>
      这份历史报告未保存事项级来源快照；正文保留原文，功能、验证、上线及指标尚未核查。
    </aside>
  );
  return (
    <section aria-label={title} className="mb-6 space-y-4 rounded-xl p-4" style={boxStyle}>
      <header className="space-y-1">
        <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{evidence.headline}</p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>来源快照中的状态与指标不会随正文手工修改而自动改变。</p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{evidence.periodStart.slice(0, 10)} 至 {evidence.periodEnd.slice(0, 10)} · {evidence.timeZone}</p>
      </header>
      {evidence.limitations.length > 0 && (
        <ul className="list-disc space-y-1 pl-4 text-[12px]" style={{ color: 'var(--text-secondary)' }} aria-label="数据与核查边界">
          {evidence.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}
        </ul>
      )}
      <div className="space-y-3">
        {evidence.items.map((item) => (
          <article key={item.id} className="space-y-3 rounded-lg p-3" style={{ border: '1px solid var(--border-primary)', background: 'var(--bg-primary)' }}>
            <div className="space-y-1" style={{ overflowWrap: 'anywhere' }}>
              <h3 className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>{item.title}</h3>
              <p className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{item.movement}{item.owner ? ` · ${item.owner}` : ''}</p>
              {item.previousSummary && <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>上期：{item.previousSummary}</p>}
            </div>
            <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                { key: 'code', label: '功能', status: item.codeStatus, text: item.codeLabel },
                { key: 'validation', label: '验证', status: item.validationStatus, text: item.validationLabel },
                { key: 'release', label: '上线', status: item.releaseStatus, text: item.releaseLabel },
              ].map((stage) => (
                <div key={stage.key} className="min-w-0 rounded-lg px-3 py-2" style={boxStyle}>
                  <dt className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{stage.label}</dt>
                  <dd className="mt-1 text-[12px] font-medium" style={{ color: STATUS_COLOR_REGISTRY[stage.status] || 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{stage.text}</dd>
                </div>
              ))}
            </dl>
            {item.blockReason && <p className="text-[12px] leading-relaxed" style={{ color: 'var(--accent-fg-danger, var(--text-primary))' }}>风险 / 阻塞：{item.blockReason}</p>}
            {item.nextStep && <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>下一步：{item.nextStep}</p>}
            <p className="text-[11px] font-mono" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>事项 {item.id}{item.revision ? ` · 当前版本 ${item.revision}` : ''}</p>
            <EvidenceSources sources={item.sources} />
          </article>
        ))}
      </div>
      {evidence.metrics.length > 0 && (
        <section className="space-y-3 border-t pt-3" style={{ borderColor: 'var(--border-primary)' }} aria-label="效率、工时与收益">
          <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>效率、工时与收益</h3>
          {evidence.metrics.map((metric) => (
            <div key={metric.key} className="space-y-1">
              <p className="text-[12px] leading-relaxed" style={{ color: metric.available ? 'var(--text-secondary)' : 'var(--text-muted)' }}><span className="font-medium">{metric.label}：</span>{metric.text}</p>
              {metric.sources.length > 0 && <EvidenceSources sources={metric.sources} />}
            </div>
          ))}
        </section>
      )}
    </section>
  );
}
