import { useCallback, useEffect, useRef, useState } from 'react';
import { useGroupListStore } from '../../stores/groupListStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useKbStore } from '../../stores/kbStore';
import { invoke } from '../../lib/tauri';
import type { ApiResponse, KbDocumentContent } from '../../types';

export default function KnowledgeBasePage() {
  const { activeGroupId } = useSessionStore();
  const { groups } = useGroupListStore();
  const { documents, loading, error, loadDocuments, uploadDocuments, replaceDocument, deleteDocument } = useKbStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [replaceTargetId, setReplaceTargetId] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ fileName: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const group = groups.find((g) => g.groupId === activeGroupId) ?? null;

  useEffect(() => {
    if (activeGroupId) {
      loadDocuments(activeGroupId);
    }
  }, [activeGroupId, loadDocuments]);

  const handleUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const files = input.files;
    input.value = '';
    if (!files || files.length === 0 || !activeGroupId) return;

    const fileList = Array.from(files);
    const invalid = fileList.find((f) => {
      const ext = f.name.toLowerCase().split('.').pop();
      return ext !== 'pdf' && ext !== 'md';
    });
    if (invalid) {
      alert(`文件 ${invalid.name} 格式不支持（仅支持 .pdf 和 .md）`);
      return;
    }

    const tooLarge = fileList.find((f) => f.size > 10 * 1024 * 1024);
    if (tooLarge) {
      alert(`文件 ${tooLarge.name} 大小超过 10MB 限制`);
      return;
    }

    await uploadDocuments(activeGroupId, fileList);
  }, [activeGroupId, uploadDocuments]);

  const handleReplace = useCallback((documentId: string) => {
    setReplaceTargetId(documentId);
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !activeGroupId || !replaceTargetId) return;

    const ext = file.name.toLowerCase().split('.').pop();
    if (ext !== 'pdf' && ext !== 'md') {
      alert('仅支持 .pdf 和 .md 格式');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      alert('文件大小超过 10MB 限制');
      return;
    }

    await replaceDocument(activeGroupId, replaceTargetId, file);
    setReplaceTargetId(null);
  }, [activeGroupId, replaceTargetId, replaceDocument]);

  const handleDelete = useCallback(async (documentId: string, fileName: string) => {
    if (!activeGroupId) return;
    if (!confirm(`确认删除文档「${fileName}」？此操作不可撤销。`)) return;
    await deleteDocument(activeGroupId, documentId);
  }, [activeGroupId, deleteDocument]);

  const handlePreview = useCallback(async (documentId: string) => {
    if (!activeGroupId) return;
    setPreviewLoading(true);
    try {
      const resp = await invoke<ApiResponse<KbDocumentContent>>('get_kb_document_content', {
        groupId: activeGroupId,
        documentId,
      });
      if (resp.success && resp.data) {
        setPreviewDoc({
          fileName: resp.data.fileName,
          content: resp.data.textContent || '（无法提取文本内容）',
        });
      } else {
        alert(resp.error?.message || '获取内容失败');
      }
    } catch (err) {
      alert('获取内容失败: ' + String(err));
    } finally {
      setPreviewLoading(false);
    }
  }, [activeGroupId]);

  if (!activeGroupId || !group) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        请先在左侧选择一个群组
      </div>
    );
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const maxDocs = 10;
  const canUpload = documents.length < maxDocs;

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="text-2xl font-semibold">知识库管理</div>
            <div className="text-text-secondary mt-1">
              群组：{group.groupName} · {documents.length}/{maxDocs} 份文档
            </div>
          </div>
          <button
            type="button"
            onClick={handleUpload}
            disabled={!canUpload || loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 text-white font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
            title={canUpload ? '上传文档（.pdf / .md）' : `已达上限 ${maxDocs} 份`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            上传文档
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/15 border border-red-500/35 rounded-lg text-red-700 dark:text-red-200 text-sm">
            {error}
          </div>
        )}

        {loading && documents.length === 0 && (
          <div className="text-center py-12 text-text-secondary">加载中...</div>
        )}

        {!loading && documents.length === 0 && (
          <div className="text-center py-12">
            <div className="text-text-secondary mb-2">暂无文档</div>
            <div className="text-sm text-text-secondary">点击「上传文档」添加 PDF 或 Markdown 文件作为知识库参考资料</div>
          </div>
        )}

        {documents.length > 0 && (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div
                key={doc.documentId}
                className="flex items-center gap-3 p-4 ui-glass-panel rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <div className="shrink-0">
                  {doc.fileType === 'pdf' ? (
                    <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9l-5-5H7a2 2 0 00-2 2v13a2 2 0 002 2z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14 4v5h5" />
                    </svg>
                  ) : (
                    <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6M7 20h10a2 2 0 002-2V6a2 2 0 00-2-2H9l-2 2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate" title={doc.fileName}>
                    {doc.fileName}
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5">
                    {formatFileSize(doc.fileSize)} · {doc.charCount.toLocaleString()} 字 · ~{doc.tokenEstimate.toLocaleString()} tokens
                    {doc.replaceVersion > 1 && ` · v${doc.replaceVersion}`}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {doc.hasTextContent && (
                    <button
                      type="button"
                      onClick={() => handlePreview(doc.documentId)}
                      disabled={previewLoading}
                      className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                      title="预览内容"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleReplace(doc.documentId)}
                    disabled={loading}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    title="替换文件"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M20 8a8 8 0 00-14.9-2M4 16a8 8 0 0014.9 2" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(doc.documentId, doc.fileName)}
                    disabled={loading}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="删除文档"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.md"
          multiple
          className="hidden"
          onChange={handleFileSelected}
        />
        <input
          ref={replaceInputRef}
          type="file"
          accept=".pdf,.md"
          className="hidden"
          onChange={handleReplaceFileSelected}
        />
      </div>

      {/* Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setPreviewDoc(null)} />
          <div className="relative w-full max-w-3xl max-h-[80vh] mx-4 ui-glass-modal flex flex-col">
            <div className="px-6 py-4 border-b border-black/10 dark:border-white/10 flex items-center justify-between shrink-0">
              <div className="text-lg font-semibold text-text-primary truncate">{previewDoc.fileName}</div>
              <button
                type="button"
                onClick={() => setPreviewDoc(null)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-primary-500 hover:bg-black/5 dark:hover:bg-white/5"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto p-6">
              <pre className="text-sm whitespace-pre-wrap break-words font-mono text-text-primary">
                {previewDoc.content}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
