import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSessionStore } from '../../stores/sessionStore';
import { ApiResponse, Document, Session } from '../../types';

interface UploadResponse {
  sessionId: string;
  document: Document;
}

export default function DocumentUpload() {
  const { setSession } = useSessionStore();
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleUpload = async (content: string) => {
    setLoading(true);
    setError('');

    try {
      const response = await invoke<ApiResponse<UploadResponse>>('upload_document', {
        content,
      });

      if (response.success && response.data) {
        const session: Session = {
          sessionId: response.data.sessionId,
          documentId: response.data.document.id,
          currentRole: 'PM',
          mode: 'QA',
        };
        setSession(session, response.data.document);
      } else {
        setError(response.error?.message || '上传失败');
      }
    } catch (err) {
      setError(String(err));
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
        handleUpload(content);
      } else {
        setError('仅支持 .md 格式文件');
      }
    }
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (text) {
      handleUpload(text);
    }
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      const content = await file.text();
      handleUpload(content);
    }
  };

  return (
    <div 
      className="flex-1 flex items-center justify-center p-8"
      onPaste={handlePaste}
    >
      <div
        className={`w-full max-w-2xl p-12 border-2 border-dashed rounded-2xl text-center transition-colors ${
          isDragging 
            ? 'border-primary-500 bg-primary-500/10' 
            : 'border-border hover:border-primary-300'
        }`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {loading ? (
          <div className="flex flex-col items-center">
            <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mb-4" />
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