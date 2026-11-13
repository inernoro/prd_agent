import type { ReactNode } from 'react';

/** 文章区只保留文档标题与操作，生成配置集中在右侧工作台。 */
export function ArticleEditorToolbar({ title, actions }: {
  title: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="mb-3 flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-2" aria-label="文章工具栏">
      <div className="min-w-0" style={{ flex: '1 1 160px' }}>{title}</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="文档操作">
        {actions}
      </div>
    </div>
  );
}
