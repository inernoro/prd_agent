import { useState, useCallback, useRef } from 'react';
import { message } from 'antd';
import { LoadingOutlined, CloudUploadOutlined, FileMarkdownOutlined } from '@ant-design/icons';
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
        message.success(`文档「${response.data.document.title}」加载成功！`);
      } else {
        message.error(response.error?.message || '上传失败');
      }
    } catch (err) {
      message.error(String(err));
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
        message.warning('仅支持 Markdown (.md) 格式文件');
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
      {/* 完全隐藏的 file input */}
      <input 
        ref={fileInputRef}
        type="file" 
        accept=".md,.markdown"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />
      
      <div
        className={`w-full max-w-3xl p-10 border-2 border-dashed rounded-2xl text-center transition-all duration-300 bg-black/10 ${
          isDragging 
            ? 'border-blue-500 bg-blue-500/10 scale-[1.02]' 
            : 'border-gray-600 hover:border-blue-400/50'
        }`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {loading ? (
          <div className="flex flex-col items-center">
            <LoadingOutlined className="text-5xl text-blue-500 mb-4" spin />
            <p className="text-gray-400 text-lg">正在解析文档...</p>
          </div>
        ) : (
          <>
            <div className="w-20 h-20 mx-auto mb-6 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-2xl flex items-center justify-center border border-blue-500/30">
              <FileMarkdownOutlined className="text-4xl text-blue-400" />
            </div>
            
            <h2 className="text-2xl font-semibold text-white mb-3">上传 PRD 文档</h2>
            <p className="text-gray-400 mb-8">
              拖拽 Markdown 文件到此处，或点击选择文件<br />
              <span className="text-gray-500 text-sm">也可以使用 Ctrl+V 粘贴 Markdown 内容</span>
            </p>

            <button 
              onClick={handleButtonClick}
              className="inline-flex items-center gap-2 px-8 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-xl cursor-pointer hover:from-blue-500 hover:to-blue-400 transition-all duration-300 shadow-lg shadow-blue-500/25 border-0"
            >
              <CloudUploadOutlined className="text-lg" />
              <span className="font-medium">选择文件</span>
            </button>

            <div className="mt-8 flex items-center justify-center gap-6 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-green-500 rounded-full" />
                支持 .md 格式
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 bg-green-500 rounded-full" />
                最大 10MB
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

