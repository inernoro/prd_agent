import { useState } from 'react';
import { invoke } from '../../lib/tauri';
import { useDefectStore } from '../../stores/defectStore';
import type { ApiResponse, DefectReport, DefectSeverity } from '../../types';

const severityOptions: { value: DefectSeverity; label: string; color: string }[] = [
  { value: 'critical', label: '致命', color: 'bg-red-500' },
  { value: 'major', label: '严重', color: 'bg-orange-500' },
  { value: 'minor', label: '一般', color: 'bg-yellow-500' },
  { value: 'trivial', label: '轻微', color: 'bg-blue-500' },
];

export default function DefectSubmitPanel() {
  const { setShowSubmitPanel, addDefectToList, loadStats } = useDefectStore();
  const [content, setContent] = useState('');
  const [severity, setSeverity] = useState<DefectSeverity>('minor');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const extractTitle = (text: string) => {
    const lines = text.split('\n').filter((l) => l.trim());
    return lines[0]?.trim().slice(0, 100) || undefined;
  };

  const handleSubmit = async () => {
    if (!content.trim()) {
      setError('请输入问题描述');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const title = extractTitle(content);

      // Step 1: 创建缺陷（草稿），assigneeUserId 已在 Rust 层硬编码为 "inernoro"
      const createResp = await invoke<ApiResponse<{ defect: DefectReport }>>('create_defect', {
        content: content.trim(),
        severity,
        title: title ?? null,
      });

      if (!createResp.success || !createResp.data) {
        setError(createResp.error?.message || '创建失败');
        setSubmitting(false);
        return;
      }

      const defect = (createResp.data as any).defect ?? createResp.data;

      // Step 2: 提交缺陷（draft → submitted）
      const submitResp = await invoke<ApiResponse<{ defect: DefectReport }>>('submit_defect', {
        id: defect.id,
      });

      if (submitResp.success && submitResp.data) {
        const submitted = (submitResp.data as any).defect ?? submitResp.data;
        addDefectToList(submitted as DefectReport);
      } else {
        // 降级：以草稿形式添加
        addDefectToList(defect as DefectReport);
      }

      loadStats();
      setShowSubmitPanel(false);
      setContent('');
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 ui-glass-panel rounded-xl shadow-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-white/10">
          <h3 className="text-lg font-semibold">提交缺陷</h3>
          <button
            onClick={() => setShowSubmitPanel(false)}
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* 提交给：固定为 inernoro */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">提交给</label>
            <div className="px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 text-sm">
              inernoro
            </div>
          </div>

          {/* 严重程度 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-2">严重程度</label>
            <div className="flex gap-2">
              {severityOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSeverity(opt.value)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    severity === opt.value
                      ? 'bg-primary-500/15 text-primary-600 dark:text-primary-400 ring-1 ring-primary-500/30'
                      : 'bg-black/5 dark:bg-white/5 text-text-secondary hover:bg-black/10 dark:hover:bg-white/10'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${opt.color}`} />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 问题描述 */}
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">问题描述</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="请描述你遇到的问题...&#10;&#10;第一行将作为标题"
              rows={6}
              className="w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary-500/30"
            />
          </div>

          {error && (
            <p className="text-red-500 text-sm">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-black/5 dark:border-white/10">
          <button
            onClick={() => setShowSubmitPanel(false)}
            className="px-4 py-2 text-sm rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !content.trim()}
            className="px-4 py-2 text-sm rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? '提交中...' : '提交缺陷'}
          </button>
        </div>
      </div>
    </div>
  );
}
