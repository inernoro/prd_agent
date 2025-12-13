import { useState, useCallback, useRef } from 'react';
import { Message } from '@arco-design/web-react';
import { IconLoading, IconUpload, IconFile } from '@arco-design/web-react/icon';
import { usePrdSessionStore } from '../../stores/prdSessionStore';
import { uploadDocument } from '../../services/api';
import { ApiResponse, UploadDocumentResponse, PrdSession } from '../../types';

export default function DocumentUpload() {
  const { setSession } = usePrdSessionStore();
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (content: string) => {
    setLoading(true);

    try {
      const response = await uploadDocument(content) as unknown as ApiResponse<UploadDocumentResponse>;

      if (response.success && response.data) {
        const session: PrdSession = {
          sessionId: response.data.sessionId,
          documentId: response.data.document.id,
          currentRole: 'PM',
          mode: 'QA',
        };
        setSession(session, response.data.document);
        Message.success(`文档「${response.data.document.title}」加载成功!`);
      } else {
        Message.error(response.error?.message || '上传失败');
      }
    } catch (err) {
      Message.error(String(err));
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
      if (file.name.endsWith('.md') || file.name.endsWith('.markdown')) {
        const content = await file.text();
        handleUpload(content);
      } else {
        Message.warning('仅支持 Markdown (.md) 格式文件');
      }
    }
  }, []);

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text');
    if (text && text.length > 50) {
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

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div 
      className="flex-1 flex items-start justify-center pt-6 pb-12 px-6"
      onPaste={handlePaste}
      tabIndex={-1}
      style={{ outline: 'none' }}
    >
      <input 
        ref={fileInputRef}
        type="file" 
        accept=".md,.markdown"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />
      
      <div
        style={{
          width: '100%',
          maxWidth: 640,
          padding: 'var(--space-10)',
          border: `2px dashed ${isDragging ? 'var(--accent)' : 'var(--border-default)'}`,
          borderRadius: 'var(--radius-xl)',
          textAlign: 'center',
          background: isDragging ? 'var(--accent-muted)' : 'var(--bg-card)',
          transition: 'all var(--duration-normal) var(--ease-out)',
          transform: isDragging ? 'scale(1.01)' : 'scale(1)',
        }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {loading ? (
          <div className="flex flex-col items-center">
            <IconLoading style={{ fontSize: 48, color: 'var(--accent)', marginBottom: 'var(--space-4)' }} spin />
            <p style={{ color: 'var(--text-muted)', fontSize: 16 }}>正在解析文档...</p>
          </div>
        ) : (
          <>
            <div 
              style={{
                width: 72,
                height: 72,
                margin: '0 auto var(--space-6)',
                background: 'var(--accent-muted)',
                borderRadius: 'var(--radius-lg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconFile style={{ fontSize: 32, color: 'var(--accent)' }} />
            </div>
            
            <h2 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 'var(--space-3)' }}>
              上传 PRD 文档
            </h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-6)' }}>
              拖拽 Markdown 文件到此处，或点击选择文件<br />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>也可以使用 Ctrl+V 粘贴 Markdown 内容</span>
            </p>

            <button 
              onClick={handleButtonClick}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '12px 24px',
                background: 'var(--accent)',
                color: '#fff',
                borderRadius: 'var(--radius-md)',
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                fontWeight: 500,
              }}
            >
              <IconUpload style={{ fontSize: 16 }} />
              <span>选择文件</span>
            </button>

            <div 
              className="flex items-center justify-center gap-6"
              style={{ marginTop: 'var(--space-6)', fontSize: 12, color: 'var(--text-muted)' }}
            >
              <span className="flex items-center gap-2">
                <span style={{ width: 6, height: 6, background: 'var(--success)', borderRadius: '50%' }} />
                支持 .md 格式
              </span>
              <span className="flex items-center gap-2">
                <span style={{ width: 6, height: 6, background: 'var(--success)', borderRadius: '50%' }} />
                最大 10MB
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
