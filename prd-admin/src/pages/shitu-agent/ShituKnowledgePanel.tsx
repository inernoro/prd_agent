import { DocumentStoreBrowser } from '@/components/doc-browser/DocumentStoreBrowser';

interface Props {
  storeId: string;
  canWrite: boolean;
  categoryLabel: string;
}

/** 识途内嵌分类知识库 — 复用 DocumentStoreBrowser，不在文档空间单独维护 */
export function ShituKnowledgePanel({ storeId, canWrite, categoryLabel }: Props) {
  return (
    <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-white/10 bg-black/20 overflow-hidden">
      <div className="shrink-0 px-4 py-2 border-b border-white/10 text-[12px] text-white/55">
        {categoryLabel}知识库
        {!canWrite && <span className="ml-2 text-white/35">（只读，维护请联系管理员）</span>}
      </div>
      <div className="flex-1 min-h-0">
        <DocumentStoreBrowser storeId={storeId} canWrite={canWrite} />
      </div>
    </div>
  );
}
