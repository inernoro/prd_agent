import { useState, useEffect } from 'react';
import { X, Plus, Trash2, GripVertical, Save, ChevronDown, ChevronUp } from 'lucide-react';
import { getReviewDimensions as getDimensions, updateReviewDimensions as updateDimensions } from '@/services';
import type { ReviewDimensionConfig } from '@/services';

interface Props {
  open: boolean;
  onClose: () => void;
}

type EditableDim = Omit<ReviewDimensionConfig, 'updatedAt' | 'updatedBy'>;

export function ReviewAgentDimensionsModal({ open, onClose }: Props) {
  const [dims, setDims] = useState<EditableDim[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) {
      setExpandedKeys(new Set());
      return;
    }
    setLoading(true);
    setError('');
    getDimensions().then(res => {
      if (res.success && res.data) {
        setDims(res.data.dimensions.map((d): EditableDim => ({
          id: d.id,
          key: d.key,
          name: d.name,
          description: d.description,
          maxScore: d.maxScore,
          orderIndex: d.orderIndex,
          isActive: d.isActive,
        })));
      }
      setLoading(false);
    });
  }, [open]);

  if (!open) return null;

  const totalScore = dims.filter(d => d.isActive).reduce((s, d) => s + (d.maxScore || 0), 0);

  function updateDim(idx: number, patch: Partial<EditableDim>) {
    setDims(prev => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
  }

  function toggleExpand(key: string) {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function addDim() {
    const maxOrder = dims.length > 0 ? Math.max(...dims.map(d => d.orderIndex)) : 0;
    const key = `dim_${Date.now()}`;
    const newDim: EditableDim = {
      id: '',
      key,
      name: '',
      description: '',
      maxScore: 10,
      orderIndex: maxOrder + 1,
      isActive: true,
    };
    setDims(prev => [...prev, newDim]);
    // 新增维度自动展开明细
    setExpandedKeys(prev => new Set([...prev, key]));
  }

  function removeDim(idx: number) {
    setDims(prev => prev.filter((_, i) => i !== idx));
  }

  function moveUp(idx: number) {
    if (idx === 0) return;
    setDims(prev => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next.map((d, i) => ({ ...d, orderIndex: i + 1 }));
    });
  }

  function moveDown(idx: number) {
    if (idx === dims.length - 1) return;
    setDims(prev => {
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next.map((d, i) => ({ ...d, orderIndex: i + 1 }));
    });
  }

  async function handleSave() {
    const invalid = dims.find(d => !d.name.trim());
    if (invalid) { setError('维度名称不能为空'); return; }
    setSaving(true);
    setError('');
    try {
      const ordered = dims.map((d, i) => ({ ...d, orderIndex: i + 1 }));
      const res = await updateDimensions(ordered);
      if (res.success) { onClose(); }
      else { setError(res.error?.message || '保存失败'); }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl rounded-2xl overflow-hidden flex flex-col"
        style={{
          background: 'rgba(12, 15, 28, 0.97)',
          border: '1px solid rgba(255,255,255,0.1)',
          maxHeight: '85vh',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <div>
            <h2 className="text-sm font-semibold text-white">评审维度配置</h2>
            <p className="text-xs text-white/40 mt-0.5">
              满分 <span className="text-indigo-400 font-medium">{totalScore}</span> 分（≥80 分视为通过）
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/8 transition-colors text-white/40 hover:text-white/70">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-indigo-500/40 border-t-indigo-400 rounded-full animate-spin" />
            </div>
          ) : dims.length === 0 ? (
            <p className="text-center text-white/30 text-sm py-8">暂无维度，点击下方添加</p>
          ) : (
            dims.map((dim, idx) => {
              const isExpanded = expandedKeys.has(dim.key);
              return (
                <div
                  key={dim.key}
                  className="rounded-xl overflow-hidden"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                >
                  {/* Row: controls + name + score + expand/delete */}
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    {/* Move buttons */}
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button
                        onClick={() => moveUp(idx)}
                        disabled={idx === 0}
                        className="w-4 h-3 flex items-center justify-center text-white/25 hover:text-white/60 disabled:opacity-20 transition-colors"
                      >
                        <GripVertical className="w-3 h-3 rotate-90 -scale-y-100" />
                      </button>
                      <button
                        onClick={() => moveDown(idx)}
                        disabled={idx === dims.length - 1}
                        className="w-4 h-3 flex items-center justify-center text-white/25 hover:text-white/60 disabled:opacity-20 transition-colors"
                      >
                        <GripVertical className="w-3 h-3 rotate-90" />
                      </button>
                    </div>

                    {/* Active toggle */}
                    <button
                      onClick={() => updateDim(idx, { isActive: !dim.isActive })}
                      className={`w-2 h-2 rounded-full shrink-0 transition-colors ${dim.isActive ? 'bg-indigo-400' : 'bg-white/15'}`}
                      title={dim.isActive ? '点击禁用' : '点击启用'}
                    />

                    {/* Name */}
                    <input
                      value={dim.name}
                      onChange={e => updateDim(idx, { name: e.target.value })}
                      placeholder="维度名称"
                      className="flex-1 bg-transparent text-sm text-white placeholder-white/25 outline-none min-w-0"
                    />

                    {/* Max score */}
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={dim.maxScore}
                        onChange={e => updateDim(idx, { maxScore: Math.max(1, parseInt(e.target.value) || 1) })}
                        className="w-12 bg-white/5 rounded-lg text-center text-sm text-white outline-none px-1 py-0.5 border border-white/8"
                      />
                      <span className="text-xs text-white/30">分</span>
                    </div>

                    {/* Expand criteria */}
                    <button
                      onClick={() => toggleExpand(dim.key)}
                      className="p-1 rounded-lg hover:bg-white/8 text-white/25 hover:text-white/60 transition-colors shrink-0"
                      title="展开/折叠明细要求"
                    >
                      {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>

                    {/* Delete */}
                    <button
                      onClick={() => removeDim(idx)}
                      className="p-1 rounded-lg hover:bg-rose-500/15 text-white/25 hover:text-rose-400 transition-colors shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Expandable: description / criteria */}
                  {isExpanded && (
                    <div className="px-3 pb-3 border-t border-white/5 pt-2.5">
                      <p className="text-xs text-white/35 mb-1.5">明细要求 <span className="text-white/20">（写入评审提示词，指导 AI 评分）</span></p>
                      <textarea
                        value={dim.description}
                        onChange={e => updateDim(idx, { description: e.target.value })}
                        placeholder="描述该维度的评分依据、检查要点和扣分规则..."
                        rows={4}
                        className="w-full bg-black/20 rounded-lg text-sm text-white/80 placeholder-white/20 outline-none px-3 py-2 resize-none border border-white/8 focus:border-indigo-500/40 transition-colors leading-relaxed"
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/8 px-4 py-3 flex items-center justify-between gap-3">
          <button
            onClick={addDim}
            className="flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            添加维度
          </button>

          <div className="flex items-center gap-3">
            {error && <p className="text-xs text-rose-400">{error}</p>}
            <button
              onClick={onClose}
              className="text-sm text-white/40 hover:text-white/70 transition-colors px-3 py-1.5"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50"
              style={{ background: 'rgba(99,102,241,0.85)', color: 'white' }}
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
