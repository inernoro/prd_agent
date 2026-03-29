import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, Upload, FileText, X, AlertCircle } from 'lucide-react';
import { uploadAttachment } from '@/services/real/aiToolbox';
import { createReviewSubmission } from '@/services';

export function ReviewAgentSubmitPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.name.endsWith('.md') && f.type !== 'text/markdown' && f.type !== 'text/plain') {
      setError('请上传 .md 格式的 Markdown 文件');
      return;
    }
    setError(null);
    setFile(f);
    // 自动填充标题（去掉扩展名）
    if (!title) {
      setTitle(f.name.replace(/\.md$/i, ''));
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) {
      const fakeEvent = { target: { files: [f] } } as unknown as React.ChangeEvent<HTMLInputElement>;
      handleFileChange(fakeEvent);
    }
  }

  async function handleSubmit() {
    if (!title.trim()) { setError('请填写方案标题'); return; }
    if (!file) { setError('请上传方案文件'); return; }

    setError(null);
    setUploading(true);

    try {
      const uploadRes = await uploadAttachment(file);
      if (!uploadRes.success) {
        setError(uploadRes.error?.message ?? '文件上传失败');
        setUploading(false);
        return;
      }

      setUploading(false);
      setSubmitting(true);

      const submitRes = await createReviewSubmission(title.trim(), uploadRes.data!.attachmentId);
      if (!submitRes.success) {
        setError(submitRes.error?.message ?? '提交失败');
        setSubmitting(false);
        return;
      }

      const submissionId = submitRes.data!.submission.id;
      navigate(`/review-agent/submissions/${submissionId}`);
    } catch (e) {
      setError('提交过程发生错误，请重试');
      setUploading(false);
      setSubmitting(false);
    }
  }

  const isLoading = uploading || submitting;
  const loadingText = uploading ? '正在上传文件...' : submitting ? '正在创建评审任务...' : '';

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* 页头 */}
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center">
          <ClipboardCheck className="w-5 h-5 text-indigo-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">提交方案评审</h1>
          <p className="text-sm text-white/50 mt-0.5">上传 .md 格式的产品方案，AI 将从 7 个维度评审打分</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* 方案标题 */}
        <div>
          <label className="block text-sm font-medium text-white/70 mb-2">
            方案标题 <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="输入方案标题（如：用户反馈模块 v2.0）"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-white placeholder-white/30 focus:outline-none focus:border-indigo-500/50 focus:bg-white/8 transition-colors"
            disabled={isLoading}
          />
        </div>

        {/* 文件上传 */}
        <div>
          <label className="block text-sm font-medium text-white/70 mb-2">
            方案文件 (.md) <span className="text-red-400">*</span>
          </label>
          {file ? (
            <div className="flex items-center gap-3 bg-white/5 border border-indigo-500/30 rounded-lg px-4 py-3">
              <FileText className="w-5 h-5 text-indigo-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{file.name}</p>
                <p className="text-xs text-white/40 mt-0.5">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
              {!isLoading && (
                <button onClick={() => setFile(null)} className="text-white/40 hover:text-white/70 transition-colors">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ) : (
            <div
              className="border-2 border-dashed border-white/10 rounded-lg p-8 text-center hover:border-indigo-500/40 hover:bg-white/3 transition-colors cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={handleDrop}
            >
              <Upload className="w-8 h-8 text-white/30 mx-auto mb-3" />
              <p className="text-sm text-white/50">拖拽文件到此处，或点击选择</p>
              <p className="text-xs text-white/30 mt-1">支持 .md 格式，文件大小不超过 20MB</p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,text/markdown"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
            <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* 评审维度说明 */}
        <div className="bg-white/3 border border-white/8 rounded-lg p-4">
          <p className="text-xs font-medium text-white/40 uppercase tracking-wider mb-3">AI 将从以下 7 个维度评审（共 100 分，≥80 分通过）</p>
          <div className="grid grid-cols-2 gap-2 text-xs text-white/50">
            <span>• 文档规范完整性（20分）</span>
            <span>• 内在自洽性（20分）</span>
            <span>• 问题陈述质量（15分）</span>
            <span>• 用户价值清晰度（15分）</span>
            <span>• 实现思路可行性（15分）</span>
            <span>• 需求可测试性（10分）</span>
            <span>• 表达规范性（5分）</span>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/review-agent')}
            disabled={isLoading}
            className="flex-1 bg-white/5 hover:bg-white/10 disabled:opacity-50 border border-white/10 rounded-lg py-3 text-sm text-white/70 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || !file || !title.trim()}
            className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg py-3 text-sm font-medium text-white transition-colors flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                {loadingText}
              </>
            ) : (
              <>
                <ClipboardCheck className="w-4 h-4" />
                提交评审
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
