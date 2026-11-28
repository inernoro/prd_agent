import type { QcTemplate, QcWebSection } from './types';

/** 可辨认的风格海报。任务的实际画面由预览和成片播放器承担。 */
export function StyleFrame({ template }: { template: Pick<QcTemplate, 'name' | 'posterUrl' | 'frame'>; scene?: number }) {
  return (
    <div role="img" aria-label={`${template.name} · 样片海报`} className="aspect-video w-full overflow-hidden bg-[var(--bg-secondary)]">
      <img src={template.posterUrl} alt="" loading="lazy" decoding="async" className="block h-full w-full object-cover" />
    </div>
  );
}

export function TemplatePageBody({ sections, activeAnchor, pendingFrom, maxHeight = 220 }: {
  sections: QcWebSection[];
  activeAnchor?: string;
  pendingFrom?: number;
  maxHeight?: number | 'none';
}) {
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4 text-token-primary" style={{ maxHeight }}>
      {sections.map((section, index) => (
        pendingFrom != null && index >= pendingFrom
          ? <section key={section.anchor} aria-label={`${section.title}（生成中）`} className="qc-shimmer space-y-2 rounded-md p-2">
              <div className="text-sm font-semibold">{section.title}</div>
              <div className="qc-skel h-2 w-11/12 rounded" /><div className="qc-skel h-2 w-3/4 rounded" />
            </section>
          : <section key={section.anchor} id={`qc-${section.anchor}`}
              className="rounded-md p-2" style={{ outline: activeAnchor === section.anchor ? '2px solid var(--accent-primary)' : undefined }}>
              <h3 className="m-0 text-sm font-semibold">{section.title}</h3>
              <p className="m-0 mt-1 text-[12.5px] leading-6 text-token-secondary">{section.body}</p>
            </section>
      ))}
    </div>
  );
}
