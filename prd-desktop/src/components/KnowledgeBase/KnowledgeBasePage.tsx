import { useCallback, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useGroupListStore } from '../../stores/groupListStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePrdCitationPreviewStore } from '../../stores/prdCitationPreviewStore';
import type { ApiResponse, Document, DocumentType } from '../../types';
import { DOCUMENT_TYPE_LABELS } from '../../types';

const DOC_TYPES: DocumentType[] = ['product', 'technical', 'design', 'reference'];

/** 明确支持的格式 — 直接放行，不需要探测 */
const KNOWN_GOOD_EXTS = new Set([
  // 文档
  '.md', '.mdc', '.txt', '.csv', '.json', '.xml', '.html', '.htm', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.rst', '.adoc', '.tex',
  // 代码
  '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.css', '.scss', '.less', '.sass',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift', '.c', '.cpp', '.h', '.hpp', '.cs', '.fs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto',
  '.r', '.lua', '.dart', '.php', '.pl', '.pm', '.ex', '.exs', '.erl', '.hs', '.clj', '.lisp', '.ml', '.zig',
  // 数据/配置
  '.env', '.properties', '.gradle', '.pom', '.lock', '.editorconfig', '.gitignore', '.dockerignore',
  // 二进制文档（已知有提取器）
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
]);

/** 明确不支持的格式 — 立即拒绝，不浪费时间 */
const KNOWN_BAD_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif', '.psd', '.ai', '.raw',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.webm', '.mkv', '.wmv', '.aac', '.m4a',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dmg', '.iso', '.msi', '.app', '.deb', '.rpm',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz', '.zst',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.sqlite', '.db',
]);

type FilePhase = 'queued' | 'rejected' | 'detecting' | 'uploading' | 'success' | 'failed';
interface FileTask {
  name: string;
  path: string;
  phase: FilePhase;
  message?: string;
}

export default function KnowledgeBasePage() {
  const { activeGroupId, documentLoaded, document, documents, sessionId, setDocuments } = useSessionStore();
  const { groups } = useGroupListStore();
  const openCitationPreview = usePrdCitationPreviewStore((s) => s.open);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fileTasks, setFileTasks] = useState<FileTask[]>([]);
  const fileTasksRef = useRef<FileTask[]>([]);
  const group = groups.find((g) => g.groupId === activeGroupId) ?? null;

  // 辅助：更新单个文件任务状态
  const updateTask = useCallback((idx: number, patch: Partial<FileTask>) => {
    fileTasksRef.current = fileTasksRef.current.map((t, i) => i === idx ? { ...t, ...patch } : t);
    setFileTasks([...fileTasksRef.current]);
  }, []);

  // 更新文档类型
  const handleChangeDocumentType = useCallback(async (documentId: string, newType: DocumentType) => {
    if (!sessionId) return;
    try {
      setBusy(true);
      setError('');
      const resp = await invoke<ApiResponse<{ documentIds: string[]; documentMetas: Array<{ documentId: string; documentType: string }> }>>(
        'update_document_type',
        { sessionId, documentId, documentType: newType }
      );
      if (!resp.success) {
        setError(resp.error?.message || '更新类型失败');
        return;
      }
      // 用 metas 更新 documents 的 documentType
      const metaMap = new Map((resp.data?.documentMetas ?? []).map(m => [m.documentId, m.documentType as DocumentType]));
      setDocuments(documents.map(d => ({
        ...d,
        documentType: metaMap.get(d.id) ?? d.documentType,
      })));
    } catch (err) {
      setError('更新类型失败');
      console.error(err);
    } finally {
      setBusy(false);
    }
  }, [sessionId, documents, setDocuments]);

  // 刷新文档列表
  const refreshDocuments = useCallback(async () => {
    if (!sessionId) return;
    try {
      // 重新获取会话信息以获取最新的 documentIds
      const sessionResp = await invoke<ApiResponse<{ documentIds: string[]; documentMetas: Array<{ documentId: string; documentType: string }> }>>(
        'get_session',
        { groupId: activeGroupId }
      );
      const newDocIds: string[] = sessionResp.data?.documentIds ?? [];
      const metaMap = new Map((sessionResp.data?.documentMetas ?? []).map(m => [m.documentId, m.documentType as DocumentType]));
      const newDocs: Document[] = [];
      for (const did of newDocIds) {
        try {
          const r = await invoke<ApiResponse<Document>>('get_document', { documentId: did });
          if (r.success && r.data) {
            r.data.documentType = metaMap.get(did) ?? (did === newDocIds[0] ? 'product' : 'reference');
            newDocs.push(r.data);
          }
        } catch { /* skip */ }
      }
      if (newDocs.length > 0) setDocuments(newDocs);
    } catch { /* skip */ }
  }, [sessionId, activeGroupId, setDocuments]);

  // 三阶段文件上传：已知放行 → 已知拒绝 → 未知探测
  const handleAddDocumentNative = useCallback(async () => {
    if (!sessionId) return;

    try {
      const selected = await open({
        multiple: true,
        title: '选择资料文件（文档、代码、配置等均可）',
      });

      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      setBusy(true);
      setError('');

      // Phase 1：分类 — 已知放行 / 已知拒绝 / 未知待探测
      const tasks: FileTask[] = paths.map(filePath => {
        const name = filePath.split(/[/\\]/).pop() || filePath;
        const dotIdx = name.lastIndexOf('.');
        const ext = dotIdx >= 0 ? name.slice(dotIdx).toLowerCase() : '';

        if (KNOWN_BAD_EXTS.has(ext)) {
          return { name, path: filePath, phase: 'rejected' as const, message: '不支持的文件类型（图片/音视频/压缩包/可执行文件）' };
        }
        if (KNOWN_GOOD_EXTS.has(ext) || ext === '') {
          return { name, path: filePath, phase: 'queued' as const };
        }
        // 未知格式 → 需要探测
        return { name, path: filePath, phase: 'detecting' as const, message: '正在检测文件格式…' };
      });

      fileTasksRef.current = tasks;
      setFileTasks([...tasks]);

      // Phase 2 & 3：逐个上传（已知放行直接上传，未知格式标记"探测中"后上传）
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        if (task.phase === 'rejected') continue;

        // 标记上传中
        const uploadMsg = task.phase === 'detecting' ? '格式未知，尝试上传并由服务端检测…' : '上传中…';
        updateTask(i, { phase: 'uploading', message: uploadMsg });

        try {
          const resp = await invoke<ApiResponse<{ sessionId: string; documentId: string; documentIds: string[]; documentMetas: Array<{ documentId: string; documentType: string }> }>>(
            'upload_file_to_session',
            { sessionId, filePath: task.path }
          );
          if (resp.success) {
            updateTask(i, { phase: 'success', message: '已添加' });
          } else {
            updateTask(i, { phase: 'failed', message: resp.error?.message || '上传失败' });
          }
        } catch (err) {
          updateTask(i, { phase: 'failed', message: '处理失败' });
          console.error(err);
        }
      }

      await refreshDocuments();

      // 3 秒后清除已完结的任务（成功 + 拒绝），只保留失败项供用户排查
      setTimeout(() => {
        fileTasksRef.current = fileTasksRef.current.filter(t => t.phase === 'failed');
        setFileTasks([...fileTasksRef.current]);
      }, 3000);
    } catch (err) {
      setError('添加资料失败');
      console.error(err);
    } finally {
      setBusy(false);
    }
  }, [sessionId, refreshDocuments, updateTask]);

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

      const resp = await invoke<ApiResponse<{ sessionId: string; documentIds: string[]; documentMetas: Array<{ documentId: string; documentType: string }> }>>(
        'remove_document_from_session',
        { sessionId, documentId }
      );

      if (!resp.success) {
        setError(resp.error?.message || '移除失败');
        return;
      }

      // 更新文档列表
      const newDocIds: string[] = resp.data?.documentIds ?? [];
      const metaMap = new Map((resp.data?.documentMetas ?? []).map(m => [m.documentId, m.documentType as DocumentType]));
      const newDocs: Document[] = [];
      for (const did of newDocIds) {
        try {
          const r = await invoke<ApiResponse<Document>>('get_document', { documentId: did });
          if (r.success && r.data) {
            r.data.documentType = metaMap.get(did) ?? 'reference';
            newDocs.push(r.data);
          }
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
                onClick={handleAddDocumentNative}
                className="px-3 py-1.5 rounded-lg ui-control text-sm hover:opacity-80 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? '处理中...' : '+ 追加资料'}
              </button>
            </div>

            {error && (
              <div className="text-sm text-red-500 mb-3">{error}</div>
            )}

            {/* 逐文件上传进度 */}
            {fileTasks.length > 0 && (
              <div className="space-y-1.5 mb-3">
                {fileTasks.map((task, idx) => (
                  <div
                    key={`${task.name}-${idx}`}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs ${
                      task.phase === 'success' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
                      task.phase === 'failed' || task.phase === 'rejected' ? 'bg-red-500/10 text-red-500' :
                      task.phase === 'detecting' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
                      'bg-blue-500/10 text-blue-500'
                    }`}
                  >
                    {/* 状态图标 */}
                    {task.phase === 'uploading' || task.phase === 'detecting' ? (
                      <svg className="w-3.5 h-3.5 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                        <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                    ) : task.phase === 'success' ? (
                      <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    )}
                    <span className="font-medium truncate">{task.name}</span>
                    {task.message && <span className="opacity-70 truncate">{task.message}</span>}
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2">
              {docList.map((doc, idx) => (
                <div
                  key={doc.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-black/5 dark:bg-white/5"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{doc.title || `文档 ${idx + 1}`}</span>
                      {idx === 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-500 whitespace-nowrap">
                          主文档
                        </span>
                      )}
                      {/* 文档类型选择器 */}
                      <select
                        value={doc.documentType || (idx === 0 ? 'product' : 'reference')}
                        onChange={(e) => handleChangeDocumentType(doc.id, e.target.value as DocumentType)}
                        disabled={busy}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 border border-black/10 dark:border-white/10 text-text-secondary cursor-pointer disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-primary-500"
                      >
                        {DOC_TYPES.map(t => (
                          <option key={t} value={t}>{DOCUMENT_TYPE_LABELS[t]}</option>
                        ))}
                      </select>
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      <span className="font-mono">{doc.id.slice(0, 8)}...</span>
                      {' · '}{doc.charCount.toLocaleString()} 字符
                      {' · '}~{doc.tokenEstimate.toLocaleString()} tokens
                    </div>
                  </div>

                  <div className="flex items-center gap-1 ml-3 shrink-0">
                    <button
                      type="button"
                      onClick={() => openCitationPreview({
                        documentId: doc.id,
                        groupId: activeGroupId || '',
                        citations: [],
                      })}
                      className="px-2 py-1 text-xs rounded hover:bg-primary-500/15 hover:text-primary-500 text-text-secondary transition-colors"
                      title="预览文档"
                    >
                      <svg className="w-4 h-4 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </button>
                    {docList.length > 1 && (
                      <button
                        disabled={busy}
                        onClick={() => handleRemoveDocument(doc.id)}
                        className="px-2 py-1 text-xs rounded hover:bg-red-500/15 hover:text-red-500 text-text-secondary transition-colors disabled:opacity-50"
                        title="移除此文档"
                      >
                        移除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 说明 */}
          <div className="p-5 ui-glass-panel">
            <div className="text-lg font-semibold mb-2">说明</div>
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {`- **主文档**：对话的焦点，AI 回答围绕主文档展开，默认为产品文档类型。\n- **文档类型**：可为每个文档设置类型（产品文档、技术文档、设计文档、参考资料），AI 会根据类型调整引用权重。\n- **多文档支持**：追加的资料文件会作为 AI 对话时的参考上下文，与主文档一同被引用。支持一次选择多个文件。\n- **支持格式**：支持所有文本格式（代码、配置、文档等）和 PDF / Word / Excel / PPT。系统自动识别文件类型并提取文本内容。\n- **未绑定 PRD 的群组**：不允许进行任何基于 PRD 的问答/讲解。`}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
