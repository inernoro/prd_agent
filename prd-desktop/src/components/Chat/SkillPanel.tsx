import { useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useSkillStore } from '../../stores/skillStore';
import { ContextScope, OutputMode, SkillItem } from '../../types';

interface Props {
  disabled: boolean;
  onExecuteSkill: (skill: SkillItem, contextScope: ContextScope, outputMode: OutputMode) => void;
  onManageSkills: () => void;
}

const CONTEXT_SCOPE_OPTIONS: { value: ContextScope; label: string }[] = [
  { value: 'all', label: '全部上下文' },
  { value: 'current', label: '仅当前消息' },
  { value: 'prd', label: '仅 PRD 文档' },
];

const OUTPUT_MODE_OPTIONS: { value: OutputMode; label: string }[] = [
  { value: 'chat', label: '对话框内' },
  { value: 'download', label: '直接下载' },
  { value: 'clipboard', label: '复制到剪贴板' },
];

export default function SkillPanel({ disabled, onExecuteSkill, onManageSkills }: Props) {
  const { currentRole } = useSessionStore();
  const {
    activeSkillKey,
    runtimeContextScope,
    runtimeOutputMode,
    setActiveSkillKey,
    setRuntimeContextScope,
    setRuntimeOutputMode,
    getSkillsForRole,
  } = useSkillStore();

  const skills = useMemo(() => getSkillsForRole(currentRole), [currentRole, getSkillsForRole]);

  const activeSkill = useMemo(
    () => skills.find((s) => s.skillKey === activeSkillKey) ?? null,
    [skills, activeSkillKey]
  );

  return (
    <div className="px-3 py-2 flex flex-col gap-2 border-b border-black/10 dark:border-white/10 ui-glass-bar">
      {/* 技能列表 */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-text-secondary flex-shrink-0">技能</span>
        {skills.length === 0 && (
          <span className="text-xs text-text-secondary/60">暂无可用技能</span>
        )}
        {skills.map((skill) => (
          <button
            key={skill.skillKey}
            onClick={() => {
              if (activeSkillKey === skill.skillKey) {
                // 再次点击 = 执行
                onExecuteSkill(skill, runtimeContextScope, runtimeOutputMode);
              } else {
                setActiveSkillKey(skill.skillKey);
              }
            }}
            disabled={disabled}
            className={`flex-shrink-0 px-2.5 py-1.5 text-xs ui-chip transition-colors ${
              disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
            } ${
              activeSkillKey === skill.skillKey
                ? 'bg-primary-500/15 text-primary-600 dark:text-primary-300 border-primary-500/30'
                : 'text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            title={skill.description || skill.title}
          >
            {skill.icon && <span className="mr-1">{skill.icon}</span>}
            {skill.title}
            {skill.source === 'local' && (
              <span className="ml-1 text-[9px] opacity-50">本地</span>
            )}
          </button>
        ))}
        {/* 管理技能按钮 */}
        <button
          onClick={onManageSkills}
          className="flex-shrink-0 px-2 py-1.5 text-xs text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
        >
          + 管理
        </button>
      </div>

      {/* 技能配置区（选中技能后显示） */}
      {activeSkill && (
        <div className="flex items-center gap-3 text-xs">
          {/* 上下文范围 */}
          <div className="flex items-center gap-1.5">
            <span className="text-text-secondary">上下文:</span>
            <select
              value={runtimeContextScope}
              onChange={(e) => setRuntimeContextScope(e.target.value as ContextScope)}
              disabled={disabled}
              className="px-2 py-1 rounded-md text-xs ui-control bg-transparent"
            >
              {CONTEXT_SCOPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* 输出方式 */}
          <div className="flex items-center gap-1.5">
            <span className="text-text-secondary">输出:</span>
            <select
              value={runtimeOutputMode}
              onChange={(e) => setRuntimeOutputMode(e.target.value as OutputMode)}
              disabled={disabled}
              className="px-2 py-1 rounded-md text-xs ui-control bg-transparent"
            >
              {OUTPUT_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* 执行按钮 */}
          <button
            onClick={() => onExecuteSkill(activeSkill, runtimeContextScope, runtimeOutputMode)}
            disabled={disabled}
            className="px-3 py-1 rounded-md text-xs bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            执行
          </button>

          {/* 取消选中 */}
          <button
            onClick={() => setActiveSkillKey(null)}
            className="text-text-secondary hover:text-text-primary transition-colors"
          >
            取消
          </button>
        </div>
      )}
    </div>
  );
}
