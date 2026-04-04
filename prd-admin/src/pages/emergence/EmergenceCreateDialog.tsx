import { useState } from 'react';
import { createEmergenceTree } from '@/services';
import { TreePine, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { glassPanel } from '@/lib/glassStyles';

interface Props {
  onClose: () => void;
  onCreated: (treeId: string) => void;
}

export function EmergenceCreateDialog({ onClose, onCreated }: Props) {
  const [seedContent, setSeedContent] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!seedContent.trim()) {
      setError('种子内容不能为空');
      return;
    }
    setLoading(true);
    setError('');
    const res = await createEmergenceTree({
      title: title.trim() || undefined,
      seedContent: seedContent.trim(),
      seedSourceType: 'text',
    });
    if (res.success) {
      onCreated(res.data.tree.id);
    } else {
      setError(res.error?.message ?? '创建失败');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>

      <div className="w-[480px] max-w-[90vw] rounded-[16px] p-6" style={glassPanel}>
        {/* 标题 */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: 'rgba(147,51,234,0.08)', border: '1px solid rgba(147,51,234,0.12)' }}>
              <TreePine size={15} style={{ color: 'rgba(147,51,234,0.85)' }} />
            </div>
            <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              新建涌现树
            </span>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6 transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* 标题输入 */}
        <div className="mb-4">
          <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
            标��（可选）
          </label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="如：文档空间功能涌现"
            className="w-full h-9 px-3 rounded-[10px] text-[13px] outline-none transition-colors duration-200"
            style={{
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* 种子内容 */}
        <div className="mb-4">
          <label className="block text-[12px] mb-1.5" style={{ color: 'var(--text-muted)' }}>
            种子内容 — 涌现树的第一座基石
          </label>
          <textarea
            value={seedContent}
            onChange={e => setSeedContent(e.target.value)}
            placeholder={'输入一段文档、一个产品���案、一个功能标题��或一段对话…\n\n例如：「文档空间目前支持��础 CRUD，需要探索下一步做什么功能」'}
            rows={5}
            className="w-full px-3 py-2.5 rounded-[10px] text-[13px] outline-none resize-y leading-[1.6] transition-colors duration-200"
            style={{
              background: 'var(--input-bg, rgba(255,255,255,0.05))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
              color: 'var(--text-primary)',
            }}
          />
          <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
            反向自洽：每个涌现都从真��文档出发，不凭空生长
          </p>
        </div>

        {/* 错误提示 */}
        {error && (
          <p className="text-[12px] mb-3" style={{ color: 'rgba(239,68,68,0.9)' }}>{error}</p>
        )}

        {/* 操作按钮 */}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="xs" onClick={onClose}>取消</Button>
          <Button variant="primary" size="xs" onClick={handleCreate} disabled={loading}>
            {loading ? '创建中…' : '开始涌现'}
          </Button>
        </div>
      </div>
    </div>
  );
}
