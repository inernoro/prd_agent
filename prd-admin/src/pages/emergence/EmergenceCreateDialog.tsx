import { useState } from 'react';
import { createEmergenceTree } from '@/services';
import { TreePine, X } from 'lucide-react';

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
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        width: 480, maxWidth: '90vw', borderRadius: 16, padding: 24,
        background: 'var(--surface-primary, #1a1a2e)',
        border: '1px solid rgba(255,255,255,0.1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TreePine size={18} />
            <span style={{ fontWeight: 600, fontSize: 16 }}>新建涌现树</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, opacity: 0.6, marginBottom: 6 }}>标题（可选，自动从种子内容提取）</label>
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="如：文档空间功能涌现"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 13,
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
              color: 'inherit', outline: 'none',
            }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, opacity: 0.6, marginBottom: 6 }}>
            种子内容 — 涌现树的第一座基石（反向自洽的锚点）
          </label>
          <textarea
            value={seedContent}
            onChange={e => setSeedContent(e.target.value)}
            placeholder="输入一段文档、一个产品方案、一个功能标题、或一段对话…&#10;&#10;例如：「文档空间目前支持基础 CRUD，需要探索下一步做什么功能」"
            rows={5}
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 13,
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
              color: 'inherit', outline: 'none', resize: 'vertical', lineHeight: 1.5,
            }}
          />
        </div>

        {error && (
          <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
              color: 'inherit',
            }}
          >
            取消
          </button>
          <button
            onClick={handleCreate}
            disabled={loading}
            style={{
              padding: '8px 18px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
              background: 'rgba(59,130,246,0.2)', border: '1px solid rgba(59,130,246,0.3)',
              color: 'inherit', opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? '创建中…' : '开始涌现'}
          </button>
        </div>
      </div>
    </div>
  );
}
