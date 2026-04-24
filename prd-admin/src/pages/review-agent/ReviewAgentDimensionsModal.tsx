import { useState, useEffect } from 'react';
import { X, Plus, Trash2, GripVertical, Save, ChevronDown, ChevronUp, ClipboardList } from 'lucide-react';
import { getReviewDimensions as getDimensions, updateReviewDimensions as updateDimensions } from '@/services';
import type { ReviewDimensionConfig, DimensionCheckItem } from '@/services';

interface Props {
  open: boolean;
  onClose: () => void;
}

type EditableDim = Omit<ReviewDimensionConfig, 'updatedAt' | 'updatedBy'>;

// 全局规则清单模板（与后端 DefaultReviewDimensions.All[0] 一致）
const GLOBAL_RULES_TEMPLATE: EditableDim = {
  id: '',
  key: 'global_rules_checklist',
  name: '全局规则检查清单',
  maxScore: 30,
  description:
    '检查方案是否考虑到米多平台的硬性业务/技术规则。对每个检查项做二段判断：① 方案是否涉及该规则？② 若涉及，方案是否已明确写出对应设计？只有「涉及=是 且 覆盖=否」才算未通过，涉及=否直接视为通过。得分 = 30 × 通过项数 / 总项数（向下取整）。',
  orderIndex: 1,
  isActive: true,
  items: [
    { id: 'rule_risk_control', category: '安全与权限类', text: '风控接入（黑名单）' },
    { id: 'rule_permission_control', category: '安全与权限类', text: '权限控制' },
    { id: 'rule_app_permission_config', category: '安全与权限类', text: '应用权限配置规则（新增子系统/应用：不默认开放、支持单独订购）' },
    { id: 'rule_operation_log', category: '安全与权限类', text: '操作日志写入' },
    { id: 'rule_mobile_auth', category: '安全与权限类', text: '用户授权（移动端）' },
    { id: 'rule_phone_verify', category: '安全与权限类', text: '手机号验证组件' },
    { id: 'rule_3plus2_sso', category: '安全与权限类', text: '3+2账号单点登录' },
    { id: 'rule_user_deregister', category: '安全与权限类', text: '用户注销' },
    { id: 'rule_user_agreement', category: '安全与权限类', text: '用户协议' },
    { id: 'rule_new_ui_framework', category: '组件与框架类', text: '新增子系统/应用：新UI框架顶部导航规范校验' },
    { id: 'rule_mobile_footer', category: '组件与框架类', text: '移动端底部「米多技术支持」+「投诉」组件' },
    { id: 'rule_sms_fee', category: '业务功能类', text: '短信费（扣平台/扣商户）' },
    { id: 'rule_sms_signature', category: '业务功能类', text: '短信签名' },
    { id: 'rule_message_notify', category: '业务功能类', text: '消息通知' },
    { id: 'rule_store_multi_dealer', category: '业务功能类', text: '门店一对多个上级经销商（需确认是否已开通）', note: '该能力未全局开放：需邮件申请，经技术为品牌商配置开通' },
    { id: 'rule_store_multi_account', category: '业务功能类', text: '门店账号（一个手机支持注册多个门店）', note: '该能力未全局开放：默认一个手机号只能注册一个门店；若需一个手机支持注册多个门店，需邮件申请由技术处理' },
    { id: 'rule_cross_system', category: '系统边界与集成类', text: '跨子系统/应用母体（能力依赖/数据互通/入口挂载）' },
    { id: 'rule_legacy_data', category: '数据与存量类', text: '旧数据处理（含历史存量、迁移、兼容、清洗、字段/结构变更对存量的影响等）', note: '若涉及旧数据，方案是否包含须为「是」，且须体现与技术对齐后的处理范围、方式及关键风险/回滚等要点' },
  ],
};

function groupItemsByCategory(items: DimensionCheckItem[]): Record<string, DimensionCheckItem[]> {
  return items.reduce<Record<string, DimensionCheckItem[]>>((acc, it) => {
    const key = it.category || '未分类';
    (acc[key] ||= []).push(it);
    return acc;
  }, {});
}

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
          items: d.items ?? null,
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
      items: null,
    };
    setDims(prev => [...prev, newDim]);
    // 新增维度自动展开明细
    setExpandedKeys(prev => new Set([...prev, key]));
  }

  function insertGlobalRulesTemplate() {
    // 若已存在同 key 维度，则直接展开；否则追加到列表末尾
    const existsIdx = dims.findIndex(d => d.key === GLOBAL_RULES_TEMPLATE.key);
    if (existsIdx >= 0) {
      setExpandedKeys(prev => new Set([...prev, GLOBAL_RULES_TEMPLATE.key]));
      setError('已存在「全局规则检查清单」维度，请勿重复插入');
      return;
    }
    const maxOrder = dims.length > 0 ? Math.max(...dims.map(d => d.orderIndex)) : 0;
    setDims(prev => [...prev, { ...GLOBAL_RULES_TEMPLATE, orderIndex: maxOrder + 1 }]);
    setExpandedKeys(prev => new Set([...prev, GLOBAL_RULES_TEMPLATE.key]));
    setError('');
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

        {/* 总分不足警告 */}
        {totalScore < 80 && !loading && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg text-xs text-amber-300/90 flex items-center gap-2"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <span>⚠</span>
            <span>启用维度总分 <strong>{totalScore}</strong> 分，低于通过线 80 分，任何方案都无法通过，请调整分值</span>
          </div>
        )}

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
                    <div className="px-3 pb-3 border-t border-white/5 pt-2.5 space-y-2.5">
                      <div>
                        <p className="text-xs text-white/35 mb-1.5">明细要求 <span className="text-white/20">（写入评审提示词，指导 AI 评分）</span></p>
                        <textarea
                          value={dim.description}
                          onChange={e => updateDim(idx, { description: e.target.value })}
                          placeholder="描述该维度的评分依据、检查要点和扣分规则..."
                          rows={4}
                          className="w-full bg-black/20 rounded-lg text-sm text-white/80 placeholder-white/20 outline-none px-3 py-2 resize-none border border-white/8 focus:border-indigo-500/40 transition-colors leading-relaxed"
                        />
                      </div>
                      {dim.items && dim.items.length > 0 && (
                        <div>
                          <p className="text-xs text-white/35 mb-1.5">
                            清单检查项 <span className="text-white/20">（共 {dim.items.length} 项，二段判断：涉及 → 覆盖）</span>
                          </p>
                          <div
                            className="rounded-lg overflow-hidden"
                            style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.15)' }}
                          >
                            {Object.entries(groupItemsByCategory(dim.items)).map(([cat, list]) => (
                              <div key={cat} className="px-3 py-2 border-b border-white/5 last:border-b-0">
                                <p className="text-[11px] text-indigo-300/80 font-medium mb-1">{cat}</p>
                                <ul className="space-y-0.5">
                                  {list.map(it => (
                                    <li key={it.id} className="text-xs text-white/55 leading-relaxed">
                                      • {it.text}
                                      {it.note && <span className="text-white/30 ml-1">（{it.note}）</span>}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-white/8 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <button
              onClick={addDim}
              className="flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              添加维度
            </button>
            <button
              onClick={insertGlobalRulesTemplate}
              className="flex items-center gap-1.5 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
              title="插入「全局规则检查清单」维度模板（30 分，18 项检查点）"
            >
              <ClipboardList className="w-3.5 h-3.5" />
              插入全局规则清单模板
            </button>
          </div>

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
