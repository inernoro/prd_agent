import { useCallback, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { useGroupListStore } from '../../stores/groupListStore';
import { useSessionStore } from '../../stores/sessionStore';
import type { ApiResponse, Document } from '../../types';

export default function KnowledgeBasePage() {
  const { activeGroupId, documentLoaded, document, documents, sessionId, setDocuments } = useSessionStore();
  const { groups } = useGroupListStore();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const group = groups.find((g) => g.groupId === activeGroupId) ?? null;

  // 添加资料文件
  const handleAddDocument = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file || !sessionId) return;

    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.md') && !ext.endsWith('.mdc') && !ext.endsWith('.txt')) {
      setError('仅支持 .md、.mdc、.txt 格式文件');
      return;
    }

    try {
      setBusy(true);
      setError('');
      const content = await file.text();

      const resp = await invoke<ApiResponse<{ sessionId: string; documentId: string; documentIds: string[] }>>(
        'add_document_to_session',
        { sessionId, content }
      );

      if (!resp.success) {
        setError(resp.error?.message || '添加资料失败');
        return;
      }

      // 重新获取所有文档元信息
      const newDocIds: string[] = resp.data?.documentIds ?? [];
      const newDocs: Document[] = [];
      for (const did of newDocIds) {
        try {
          const r = await invoke<ApiResponse<Document>>('get_document', { documentId: did });
          if (r.success && r.data) newDocs.push(r.data);
        } catch { /* skip */ }
      }
      setDocuments(newDocs);
    } catch (err) {
      setError('添加资料失败');
      console.error(err);
    } finally {
      setBusy(false);
    }
  }, [sessionId, setDocuments]);

  // 移除资料文件
  const handleRemoveDocument = useCallback(async (documentId: string) => {
    if (!sessionId) return;
    if (documents.length <= 1) {
      setError('至少保留一个文档');
      return;
    }

    try {
      setBusy(true);
      setError('');

      const resp = await invoke<ApiResponse<{ sessionId: string; documentIds: string[] }>>(
        'remove_document_from_session',
        { sessionId, documentId }
      );

      if (!resp.success) {
        setError(resp.error?.message || '移除失败');
        return;
      }

      // 更新文档列表
      const newDocIds: string[] = resp.data?.documentIds ?? [];
      const newDocs: Document[] = [];
      for (const did of newDocIds) {
        try {
          const r = await invoke<ApiResponse<Document>>('get_document', { documentId: did });
          if (r.success && r.data) newDocs.push(r.data);
        } catch { /* skip */ }
      }
      setDocuments(newDocs);
    } catch (err) {
      setError('移除失败');
      console.error(err);
    } finally {
      setBusy(false);
    }
  }, [sessionId, documents.length, setDocuments]);

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

          <div className="p-5 ui-glass-panel">
            <div className="text-lg font-semibold mb-2">该群组未绑定 PRD</div>
            <div className="text-sm text-text-secondary">
              请先上传 PRD，并在左侧点击"上传PRD后绑定到当前群组"。绑定后，这里会显示 PRD 与后续资料入口。
            </div>
          </div>
        </div>
      </div>
    );
  }

  const docList = documents.length > 0 ? documents : [document];

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <div className="text-2xl font-semibold mb-2">知识库管理</div>
        <div className="text-text-secondary mb-6">
          群组：{group.groupName} · PRD：{document.title}
        </div>

        <div className="grid gap-4">
          {/* 文档列表 */}
          <div className="p-5 ui-glass-panel">
            <div className="flex items-center justify-between mb-3">
              <div className="text-lg font-semibold">资料文件 ({docList.length})</div>
              <button
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                className="px-3 py-1.5 rounded-lg ui-control text-sm hover:opacity-80 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? '处理中...' : '+ 追加资料'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.mdc,.txt"
                className="hidden"
                onChange={handleAddDocument}
              />
            </div>

            {error && (
              <div className="text-sm text-red-500 mb-3">{error}</div>
            )}

            <div className="space-y-2">
              {docList.map((doc, idx) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-black/5 dark:bg-white/5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{doc.title || `文档 ${idx + 1}`}</span>
                      {idx === 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-500 whitespace-nowrap">
                          主文档
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      <span className="font-mono">{doc.id.slice(0, 8)}...</span>
                      {' · '}{doc.charCount.toLocaleString()} 字符
                      {' · '}~{doc.tokenEstimate.toLocaleString()} tokens
                    </div>
                  </div>

                  {docList.length > 1 && (
                    <button
                      disabled={busy}
                      onClick={() => handleRemoveDocument(doc.id)}
                      className="ml-3 px-2 py-1 text-xs rounded hover:bg-red-500/15 hover:text-red-500 text-text-secondary transition-colors disabled:opacity-50"
                      title="移除此文档"
                    >
                      移除
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 说明 */}
          <div className="p-5 ui-glass-panel">
            <div className="text-lg font-semibold mb-2">说明</div>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {`- **PRD 追随群组**：对话与资料均以群组为容器。\n- **多文档支持**：追加的资料文件会作为 AI 对话时的参考上下文，与主 PRD 一同被引用。\n- **未绑定 PRD 的群组**：不允许进行任何基于 PRD 的问答/讲解。`}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
