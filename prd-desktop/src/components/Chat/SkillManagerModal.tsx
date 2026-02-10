import { useState } from 'react';
import { useSkillStore } from '../../stores/skillStore';
import { ContextScope, OutputMode, SkillItem } from '../../types';

interface Props {
  open: boolean;
  onClose: () => void;
}

const EMPTY_SKILL: Omit<SkillItem, 'source'> = {
  skillKey: '',
  title: '',
  description: '',
  icon: '',
  category: '',
  roles: [],
  order: 0,
  contextScope: 'all',
  outputMode: 'chat',
  promptTemplate: '',
  isEnabled: true,
};

export default function SkillManagerModal({ open, onClose }: Props) {
  const { localSkills, addLocalSkill, updateLocalSkill, removeLocalSkill } = useSkillStore();
  const [editing, setEditing] = useState<SkillItem | null>(null);
  const [isNew, setIsNew] = useState(false);

  if (!open) return null;

  const handleStartNew = () => {
    setEditing({
      ...EMPTY_SKILL,
      skillKey: `local-${Date.now()}`,
      source: 'local',
      order: localSkills.length + 1,
    });
    setIsNew(true);
  };

  const handleEdit = (skill: SkillItem) => {
    setEditing({ ...skill });
    setIsNew(false);
  };

  const handleSave = () => {
    if (!editing) return;
    if (!editing.title.trim()) return;

    if (isNew) {
      addLocalSkill(editing);
    } else {
      updateLocalSkill(editing.skillKey, editing);
    }
    setEditing(null);
    setIsNew(false);
  };

  const handleDelete = (skillKey: string) => {
    removeLocalSkill(skillKey);
    if (editing?.skillKey === skillKey) {
      setEditing(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-bg-primary rounded-2xl shadow-2xl w-[640px] max-h-[80vh] flex flex-col overflow-hidden border border-black/10 dark:border-white/10">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/10 dark:border-white/10">
          <h2 className="text-base font-medium">管理自定义技能</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left: skill list */}
          <div className="w-48 border-r border-black/10 dark:border-white/10 overflow-y-auto p-3 flex flex-col gap-1">
            <button
              onClick={handleStartNew}
              className="w-full px-3 py-2 text-xs text-left rounded-lg bg-primary-500/10 text-primary-600 dark:text-primary-300 hover:bg-primary-500/20 transition-colors"
            >
              + 新建技能
            </button>
            {localSkills.map((skill) => (
              <div
                key={skill.skillKey}
                onClick={() => handleEdit(skill)}
                className={`w-full px-3 py-2 text-xs text-left rounded-lg cursor-pointer transition-colors flex items-center justify-between group ${
                  editing?.skillKey === skill.skillKey
                    ? 'bg-primary-500/15 text-primary-600'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-text-primary'
                }`}
              >
                <span className="truncate">{skill.icon ? `${skill.icon} ` : ''}{skill.title || '未命名'}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(skill.skillKey);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-600 ml-1"
                  title="删除"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
            {localSkills.length === 0 && !editing && (
              <p className="text-xs text-text-secondary/60 text-center py-4">
                点击上方按钮创建你的第一个自定义技能
              </p>
            )}
          </div>

          {/* Right: edit form */}
          <div className="flex-1 overflow-y-auto p-4">
            {editing ? (
              <div className="flex flex-col gap-3">
                {/* Title + Icon */}
                <div className="grid grid-cols-[1fr,80px] gap-2">
                  <label className="block">
                    <span className="text-xs text-text-secondary mb-1 block">名称 *</span>
                    <input
                      type="text"
                      value={editing.title}
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                      className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                      placeholder="技能名称"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-text-secondary mb-1 block">图标</span>
                    <input
                      type="text"
                      value={editing.icon ?? ''}
                      onChange={(e) => setEditing({ ...editing, icon: e.target.value })}
                      className="w-full px-3 py-2 text-sm rounded-lg ui-control text-center"
                      placeholder="emoji"
                    />
                  </label>
                </div>

                {/* Description */}
                <label className="block">
                  <span className="text-xs text-text-secondary mb-1 block">描述</span>
                  <input
                    type="text"
                    value={editing.description}
                    onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                    placeholder="技能用途简介"
                  />
                </label>

                {/* Category */}
                <label className="block">
                  <span className="text-xs text-text-secondary mb-1 block">分类</span>
                  <input
                    type="text"
                    value={editing.category ?? ''}
                    onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                    placeholder="分析 / 生成 / 提取 ..."
                  />
                </label>

                {/* Context Scope + Output Mode */}
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs text-text-secondary mb-1 block">默认上下文</span>
                    <select
                      value={editing.contextScope}
                      onChange={(e) => setEditing({ ...editing, contextScope: e.target.value as ContextScope })}
                      className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                    >
                      <option value="all">全部上下文</option>
                      <option value="current">仅当前消息</option>
                      <option value="prd">仅 PRD 文档</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-text-secondary mb-1 block">默认输出</span>
                    <select
                      value={editing.outputMode}
                      onChange={(e) => setEditing({ ...editing, outputMode: e.target.value as OutputMode })}
                      className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                    >
                      <option value="chat">对话框内</option>
                      <option value="download">直接下载</option>
                      <option value="clipboard">复制到剪贴板</option>
                    </select>
                  </label>
                </div>

                {/* Prompt Template */}
                <label className="block">
                  <span className="text-xs text-text-secondary mb-1 block">提示词模板 *</span>
                  <textarea
                    value={editing.promptTemplate}
                    onChange={(e) => setEditing({ ...editing, promptTemplate: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg ui-control resize-y min-h-[120px]"
                    placeholder="请输入技能的提示词模板，可使用 {{变量名}} 作为参数占位符"
                  />
                </label>

                {/* Save */}
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    onClick={() => { setEditing(null); setIsNew(false); }}
                    className="px-4 py-2 text-xs rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!editing.title.trim() || !editing.promptTemplate.trim()}
                    className="px-4 py-2 text-xs rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isNew ? '创建' : '保存'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-xs text-text-secondary/60">
                选择左侧技能编辑，或创建新技能
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
