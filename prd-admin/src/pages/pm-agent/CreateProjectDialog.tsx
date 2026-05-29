import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { createPmProject } from '@/services';
import type { PmProject, PmProjectType, PmOperationSubType } from '@/services/contracts/pmAgent';
import { PROJECT_TYPE_REGISTRY, OPERATION_SUBTYPE_REGISTRY } from './pmConstants';

interface Props {
  onClose: () => void;
  onCreated: (project: PmProject) => void;
}

const TYPES: PmProjectType[] = ['strategic', 'innovation', 'operation'];
const SUBTYPES: PmOperationSubType[] = ['routine', 'rectification', 'supervision'];

export function CreateProjectDialog({ onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [businessGoal, setBusinessGoal] = useState('');
  const [description, setDescription] = useState('');
  const [projectType, setProjectType] = useState<PmProjectType>('operation');
  const [operationSubType, setOperationSubType] = useState<PmOperationSubType>('routine');
  const [strategyAlignment, setStrategyAlignment] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!title.trim()) { setError('请填写项目名称'); return; }
    if (!businessGoal.trim()) { setError('请填写业务目标（AI 拆解任务的依据）'); return; }
    setLoading(true);
    setError('');
    const res = await createPmProject({
      title: title.trim(),
      description: description.trim() || undefined,
      businessGoal: businessGoal.trim(),
      projectType,
      operationSubType: projectType === 'operation' ? operationSubType : undefined,
      strategyAlignment: strategyAlignment.trim() || undefined,
    });
    setLoading(false);
    if (res.success) {
      onCreated(res.data);
    } else {
      setError(res.error?.message || '创建失败');
    }
  };

  const labelCls = 'text-[12px] font-medium mb-1.5 block';
  const inputCls = 'w-full rounded-lg px-3 py-2 text-[13px] outline-none border';
  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="rounded-xl border flex flex-col w-full"
        style={{ maxWidth: 560, maxHeight: '88vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>立项注册</div>
          <button onClick={onClose} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-3.5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>项目名称 <span style={{ color: '#EF4444' }}>*</span></label>
            <input className={inputCls} style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：MAP 数字劳动力平台 V2" />
          </div>

          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>业务目标 <span style={{ color: '#EF4444' }}>*</span></label>
            <textarea className={inputCls} style={{ ...inputStyle, resize: 'vertical', minHeight: 64 }} value={businessGoal} onChange={(e) => setBusinessGoal(e.target.value)} placeholder="项目要达成的业务价值，譬如：新购收入提升 20% / 平台 LTV 提升…（AI 据此拆解任务）" />
          </div>

          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>项目类型</label>
            <div className="flex gap-2">
              {TYPES.map((t) => {
                const meta = PROJECT_TYPE_REGISTRY[t];
                const active = projectType === t;
                return (
                  <button
                    key={t}
                    onClick={() => setProjectType(t)}
                    className="flex-1 rounded-lg px-2 py-2 text-[12px] border text-left transition-colors"
                    style={{
                      borderColor: active ? meta.color : 'var(--border-subtle)',
                      background: active ? `${meta.color}1a` : 'var(--bg-input)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <span className="font-semibold" style={{ color: meta.color }}>{meta.short}</span> {meta.label.replace('项目', '')}
                  </button>
                );
              })}
            </div>
            <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>{PROJECT_TYPE_REGISTRY[projectType].desc}</div>
          </div>

          {projectType === 'operation' && (
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>运营子类型</label>
              <select className={inputCls} style={inputStyle} value={operationSubType} onChange={(e) => setOperationSubType(e.target.value as PmOperationSubType)}>
                {SUBTYPES.map((s) => <option key={s} value={s}>{OPERATION_SUBTYPE_REGISTRY[s].label}</option>)}
              </select>
            </div>
          )}

          {projectType === 'strategic' && (
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>战略对齐</label>
              <input className={inputCls} style={inputStyle} value={strategyAlignment} onChange={(e) => setStrategyAlignment(e.target.value)} placeholder="对齐哪个年度经营计划 / 战略目标" />
            </div>
          )}

          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>项目描述 / 背景（可选）</label>
            <textarea className={inputCls} style={{ ...inputStyle, resize: 'vertical', minHeight: 52 }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="项目背景、范围说明" />
          </div>

          {error && <div className="text-[12px]" style={{ color: '#EF4444' }}>{error}</div>}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleCreate} disabled={loading}>
            {loading ? <MapSpinner size={14} /> : null}
            立项
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
