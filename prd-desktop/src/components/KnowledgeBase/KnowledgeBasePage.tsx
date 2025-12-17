import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useGroupListStore } from '../../stores/groupListStore';
import { useSessionStore } from '../../stores/sessionStore';

export default function KnowledgeBasePage() {
  const { activeGroupId, documentLoaded, document } = useSessionStore();
  const { groups } = useGroupListStore();

  const group = groups.find((g) => g.groupId === activeGroupId) ?? null;

  if (!activeGroupId || !group) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        请先在左侧选择一个群组
      </div>
    );
  }

  if (!documentLoaded || !document) {
    return (
      <div className="flex-1 p-8 overflow-auto">
        <div className="max-w-3xl mx-auto">
          <div className="text-2xl font-semibold mb-2">知识库管理</div>
          <div className="text-text-secondary mb-6">
            群组：{group.groupName} · 当前状态：待上传
          </div>

          <div className="p-5 rounded-2xl border border-border bg-surface-light dark:bg-surface-dark">
            <div className="text-lg font-semibold mb-2">该群组未绑定 PRD</div>
            <div className="text-sm text-text-secondary">
              请先上传 PRD，并在左侧点击“上传PRD后绑定到当前群组”。绑定后，这里会显示 PRD 与后续资料入口。
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <div className="text-2xl font-semibold mb-2">知识库管理</div>
        <div className="text-text-secondary mb-6">
          群组：{group.groupName} · PRD：{document.title}
        </div>

        <div className="grid gap-4">
          <div className="p-5 rounded-2xl border border-border bg-surface-light dark:bg-surface-dark">
            <div className="text-lg font-semibold mb-2">当前 PRD（元信息）</div>
            <div className="text-sm text-text-secondary">
              documentId: <span className="font-mono">{document.id}</span> · chars: {document.charCount} · tokens~ {document.tokenEstimate}
            </div>
          </div>

          <div className="p-5 rounded-2xl border border-border bg-surface-light dark:bg-surface-dark">
            <div className="text-lg font-semibold mb-2">资料文件</div>
            <div className="text-sm text-text-secondary mb-3">
              未来支持在同一群组下上传多个文件作为参考（不锁死设计）。当前版本先提供占位入口。
            </div>
            <button
              disabled
              className="px-4 py-2 rounded-lg bg-gray-200 dark:bg-gray-700 text-text-secondary cursor-not-allowed"
            >
              添加资料（开发中）
            </button>
          </div>

          <div className="p-5 rounded-2xl border border-border bg-surface-light dark:bg-surface-dark">
            <div className="text-lg font-semibold mb-2">说明</div>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {`- **PRD 追随群组**：对话与资料均以群组为容器。\n- **未绑定 PRD 的群组**：不允许进行任何基于 PRD 的问答/讲解。\n- **扩展方向**：后续会把“PRD 文件内容（Markdown）/补充资料/版本管理”放在这里统一管理。`}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

