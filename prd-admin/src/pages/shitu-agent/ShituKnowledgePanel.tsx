import { DocumentStoreBrowser } from '@/components/doc-browser/DocumentStoreBrowser';

interface Props {
  storeId: string;
  canWrite: boolean;
  categoryLabel: string;
}

/** 识途内嵌分类知识库 — 复用 DocumentStoreBrowser，不在文档空间单独维护 */
export function ShituKnowledgePanel({ storeId, canWrite, categoryLabel }: Props) {
  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-token-subtle bg-token-nested overflow-hidden">
      <div className="shrink-0 px-4 py-2 border-b border-token-subtle text-[12px] text-token-secondary">
        {categoryLabel}知识库
        {!canWrite && <span className="ml-2 text-token-muted">（只读，维护请联系管理员）</span>}
      </div>
      <div className="flex-1 min-h-0">
        <DocumentStoreBrowser storeId={storeId} canWrite={canWrite} />
      </div>
    </div>
  );
}
