import type { ReactNode } from 'react';

/** 文档操作和模型选择分别占行，按编辑区宽度自然换行。 */
export function ArticleEditorToolbar({ title, actions, children }: {
  title: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-3 flex min-w-0 shrink-0 flex-col gap-3" aria-label="文章工具栏">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0" style={{ flex: '1 1 160px' }}>{title}</div>
        <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="文档操作">
          {actions}
        </div>
      </div>
      <div
        className="grid min-w-0 gap-3 border-t pt-3"
        style={{
          borderColor: 'var(--border-subtle)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
        }}
        aria-label="模型选择"
      >
        {children}
      </div>
    </div>
  );
}

export function ArticleEditorModelField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5" role="group" aria-label={label}>
      <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</span>
      {children}
    </div>
  );
}
