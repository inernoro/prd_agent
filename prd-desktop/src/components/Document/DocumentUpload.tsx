import { useState, useCallback } from 'react';
import { invoke } from '../../lib/tauri';
import { isSystemErrorCode } from '../../lib/systemError';
import { useSessionStore } from '../../stores/sessionStore';
import { useAuthStore } from '../../stores/authStore';
import { useGroupListStore } from '../../stores/groupListStore';
import { useRemoteAssetUrl } from '../../stores/remoteAssetsStore';
import { ApiResponse, Document, Session } from '../../types';
import { extractMarkdownTitle, extractSnippetFromContent, isMeaninglessName, normalizeCandidateName, stripFileExtension } from '../utils/nameHeuristics';

interface UploadResponse {
  sessionId: string;
  document: Document;
}

export default function DocumentUpload() {
  const { setSession } = useSessionStore();
  const { logout } = useAuthStore();
  const { loadGroups } = useGroupListStore();
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loadGifUrl = useRemoteAssetUrl('icon.desktop.load');

  const suggestGroupName = async (content: string, fileName?: string | null, docTitle?: string | null) => {
    const rawFileBase = fileName ? normalizeCandidateName(stripFileExtension(fileName)) : '';
    if (rawFileBase && !isMeaninglessName(rawFileBase)) return rawFileBase;

    const snippet = extractSnippetFromContent(content);
    // fileName 无意义时，优先走“意图模型”
    if (snippet) {
      try {
        const resp = await invoke<ApiResponse<{ name: string }>>('suggest_group_name', {
          fileName: fileName ?? null,
          snippet,
        });
        const name = (resp.success && resp.data?.name) ? String(resp.data.name).trim() : '';
        if (name) return name;
      } catch {
        // ignore
      }
    }

    // 兜底：取 Markdown 标题 / 解析后的 docTitle
    const mdTitle = extractMarkdownTitle(content);
    return mdTitle || (docTitle || '').trim() || '未命名群组';
  };

  const handleUpload = async (content: string, fileName?: string | null) => {
    setLoading(true);
    setError('');

    try {
      const response = await invoke<ApiResponse<UploadResponse>>('upload_document', {
        content,
      });

      if (response.success && response.data) {
        // 上传 PRD 后默认“一键创建群组”，并将该 PRD 绑定到群组（群组作为容器）
        const groupName = await suggestGroupName(content, fileName ?? null, response.data.document.title || null);
        const createResp = await invoke<ApiResponse<{ groupId: string; inviteCode: string }>>('create_group', {
          prdDocumentId: response.data.document.id,
          groupName: groupName || undefined,
        });

        if (!createResp.success || !createResp.data) {
          if (createResp.error?.code === 'UNAUTHORIZED') {
            logout();
            return;
          }
          // 退化：仅进入上传会话（旧行为）
          const session: Session = {
            sessionId: response.data.sessionId,
            documentId: response.data.document.id,
            currentRole: 'PM',
            mode: 'QA',
          };
          setSession(session, response.data.document);
          return;
        }

        await loadGroups();

        // 打开群组会话，后续所有对话都基于该群组/session
        const openResp = await invoke<ApiResponse<{ sessionId: string; groupId: string; documentId: string; currentRole: string }>>(
          'open_group_session',
          { groupId: createResp.data.groupId, userRole: 'PM' }
        );

        if (!openResp.success || !openResp.data) {
          // 退化：仍然保存文档信息
          const session: Session = {
            sessionId: response.data.sessionId,
            documentId: response.data.document.id,
            currentRole: 'PM',
            mode: 'QA',
            groupId: createResp.data.groupId,
          };
          setSession(session, response.data.document);
          return;
        }

        const session: Session = {
          sessionId: openResp.data.sessionId,
          groupId: openResp.data.groupId,
          documentId: openResp.data.documentId,
          currentRole: 'PM',
          mode: 'QA',
        };

        setSession(session, response.data.document);
      } else {
        const code = response.error?.code ?? null;
        // 系统性错误交给全局弹窗接管，避免重复提示
        if (!isSystemErrorCode(code)) {
          setError(response.error?.message || '上传失败');
        }
      }
    } catch (err) {
      // invoke reject 已由全局弹窗接管
      console.error('Upload failed:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.name.endsWith('.md')) {
        const content = await file.text();
        handleUpload(content, file.name);
      } else {
        setError('仅支持 .md 格式文件');
      }
    }
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (text) {
      handleUpload(text, null);
    }
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      const content = await file.text();
      handleUpload(content, file.name);
    }
  };

  return (
    <div 
      className="flex-1 flex items-center justify-center p-8"
      onPaste={handlePaste}
    >
      <div
        className={`w-full max-w-2xl p-12 ui-glass-panel border-2 border-dashed text-center transition-colors ${
          isDragging 
            ? 'border-primary-400/60 bg-primary-500/8' 
            : 'border-black/10 dark:border-white/10 hover:border-primary-400/40'
        }`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {loading ? (
          <div className="flex flex-col items-center">
            <img
              src={loadGifUrl}
              alt="加载中"
              className="w-12 h-12 mb-4 select-none pointer-events-none"
              draggable={false}
            />
            <p className="text-text-secondary">正在解析文档...</p>
          </div>
        ) : (
          <>
            <div className="w-16 h-16 mx-auto mb-6 bg-primary-100 dark:bg-primary-900/30 rounded-2xl flex items-center justify-center">
              <svg className="w-8 h-8 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            
            <h2 className="text-xl font-semibold mb-2">上传PRD文档</h2>
            <p className="text-text-secondary mb-6">
              拖拽 Markdown 文件到此处，或点击选择文件
            </p>

            <label className="inline-flex items-center gap-2 px-6 py-3 bg-primary-500 text-white rounded-lg cursor-pointer hover:bg-primary-600 transition-colors">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              选择文件
              <input 
                type="file" 
                accept=".md" 
                className="hidden" 
                onChange={handleFileSelect}
              />
            </label>

            <p className="text-xs text-text-secondary mt-4">
              支持 Ctrl+V 粘贴 Markdown 文本
            </p>

            {error && (
              <p className="mt-4 text-red-500 text-sm">{error}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
