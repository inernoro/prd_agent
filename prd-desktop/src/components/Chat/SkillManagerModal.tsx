import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '../../lib/tauri';
import { ApiResponse, Skill, SkillsResponse } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useSkillStore } from '../../stores/skillStore';

interface Props {
  open: boolean;
  onClose: () => void;
}

const CATEGORY_OPTIONS = [
  { value: 'general', label: '通用' },
  { value: 'analysis', label: '分析' },
  { value: 'generation', label: '生成' },
  { value: 'extraction', label: '提取' },
  { value: 'translation', label: '翻译' },
  { value: 'summary', label: '总结' },
  { value: 'check', label: '检查' },
  { value: 'optimization', label: '优化' },
  { value: 'other', label: '其他' },
];

const EMOJI_LIST = [
  '📝', '📊', '🔍', '💡', '🎯', '📋', '🛠️', '🚀',
  '📐', '🧪', '📈', '🔧', '💬', '📖', '🎨', '⚡',
  '🧩', '📌', '🏷️', '✅', '🔄', '📦', '🗂️', '💻',
];

interface SkillFormData {
  title: string;
  description: string;
  icon: string;
  category: string;
  contextScope: string;
  outputMode: string;
  promptTemplate: string;
}

const EMPTY_FORM: SkillFormData = {
  title: '',
  description: '',
  icon: '',
  category: 'general',
  contextScope: 'prd',
  outputMode: 'chat',
  promptTemplate: '',
};

export default function SkillManagerModal({ open, onClose }: Props) {
  const { currentRole } = useSessionStore();
  const { skills } = useSkillStore();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [form, setForm] = useState<SkillFormData>(EMPTY_FORM);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const emojiRef = useRef<HTMLDivElement>(null);

  // 只显示个人技能
  const personalSkills = skills.filter((s) => s.visibility === 'personal');

  useEffect(() => {
    if (!showEmojiPicker) return;
    const onClick = (e: MouseEvent) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [showEmojiPicker]);

  const refreshSkills = async () => {
    try {
      const resp = await invoke<ApiResponse<SkillsResponse>>('get_skills', { role: currentRole });
      if (resp?.success && resp.data?.skills) {
        useSkillStore.getState().setSkills(resp.data.skills);
      }
    } catch { /* ignore */ }
  };

  const handleStartNew = () => {
    setForm(EMPTY_FORM);
    setEditingKey('__new__');
    setIsNew(true);
    setShowEmojiPicker(false);
  };

  const handleEdit = (skill: Skill) => {
    setForm({
      title: skill.title,
      description: skill.description,
      icon: skill.icon ?? '',
      category: skill.category,
      contextScope: skill.input.contextScope,
      outputMode: skill.output.mode,
      promptTemplate: '',
    });
    setEditingKey(skill.skillKey);
    setIsNew(false);
    setShowEmojiPicker(false);
  };

  const handleSave = async () => {
    if (!form.title.trim() || !form.promptTemplate.trim()) return;
    setIsSaving(true);

    const request = {
      title: form.title.trim(),
      description: form.description.trim(),
      icon: form.icon || null,
      category: form.category,
      tags: [] as string[],
      order: personalSkills.length + 1,
      input: {
        contextScope: form.contextScope,
        acceptsUserInput: false,
        userInputPlaceholder: null,
        acceptsAttachments: false,
        parameters: [],
      },
      execution: {
        promptTemplate: form.promptTemplate.trim(),
        systemPromptOverride: null,
        modelType: 'chat',
      },
      output: {
        mode: form.outputMode,
        fileNameTemplate: null,
        echoToChat: false,
      },
    };

    try {
      if (isNew) {
        await invoke<ApiResponse<any>>('create_skill', { request });
      } else if (editingKey) {
        await invoke<ApiResponse<any>>('update_skill', { skillKey: editingKey, request });
      }
      await refreshSkills();
      setEditingKey(null);
      setIsNew(false);
    } catch (err) {
      console.error('Failed to save skill:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (skillKey: string) => {
    try {
      await invoke<ApiResponse<any>>('delete_skill', { skillKey });
      await refreshSkills();
      if (editingKey === skillKey) {
        setEditingKey(null);
      }
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="ui-glass-modal w-[640px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/10 dark:border-white/10">
          <h2 className="text-base font-medium">管理我的技能</h2>
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
            {personalSkills.map((skill) => (
              <div
                key={skill.skillKey}
                onClick={() => handleEdit(skill)}
                className={`w-full px-3 py-2 text-xs text-left rounded-lg cursor-pointer transition-colors flex items-center justify-between group ${
                  editingKey === skill.skillKey
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
            {personalSkills.length === 0 && !editingKey && (
              <p className="text-xs text-text-secondary/60 text-center py-4">
                点击上方按钮创建你的第一个自定义技能
              </p>
            )}
          </div>

          {/* Right: edit form */}
          <div className="flex-1 overflow-y-auto p-4">
            {editingKey ? (
              <div className="flex flex-col gap-3">
                {/* Title + Icon */}
                <div className="grid grid-cols-[1fr,80px] gap-2">
                  <label className="block">
                    <span className="text-xs text-text-secondary mb-1 block">名称 *</span>
                    <input
                      type="text"
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                      placeholder="技能名称"
                    />
                  </label>
                  <div className="block relative" ref={emojiRef}>
                    <span className="text-xs text-text-secondary mb-1 block">图标</span>
                    <button
                      type="button"
                      onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                      className="w-full px-3 py-2 text-sm rounded-lg ui-control text-center h-[38px] cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                      {form.icon || '选择'}
                    </button>
                    {showEmojiPicker && (
                      <div className="absolute top-full left-0 mt-1 z-10 p-2 rounded-lg shadow-lg border border-black/10 dark:border-white/10 bg-white dark:bg-gray-800 w-[220px]">
                        <div className="grid grid-cols-6 gap-1">
                          {EMOJI_LIST.map((emoji) => (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => {
                                setForm({ ...form, icon: emoji });
                                setShowEmojiPicker(false);
                              }}
                              className={`w-8 h-8 flex items-center justify-center text-base rounded-md hover:bg-primary-500/15 transition-colors ${
                                form.icon === emoji ? 'bg-primary-500/20 ring-1 ring-primary-500/40' : ''
                              }`}
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                        {form.icon && (
                          <button
                            type="button"
                            onClick={() => {
                              setForm({ ...form, icon: '' });
                              setShowEmojiPicker(false);
                            }}
                            className="w-full mt-1.5 px-2 py-1 text-xs text-red-500 hover:bg-red-500/10 rounded-md transition-colors"
                          >
                            清除图标
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Description */}
                <label className="block">
                  <span className="text-xs text-text-secondary mb-1 block">描述</span>
                  <input
                    type="text"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                    placeholder="技能用途简介"
                  />
                </label>

                {/* Category */}
                <label className="block">
                  <span className="text-xs text-text-secondary mb-1 block">分类</span>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                  >
                    {CATEGORY_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </label>

                {/* Context Scope + Output Mode */}
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs text-text-secondary mb-1 block">默认上下文</span>
                    <select
                      value={form.contextScope}
                      onChange={(e) => setForm({ ...form, contextScope: e.target.value })}
                      className="w-full px-3 py-2 text-sm rounded-lg ui-control"
                    >
                      <option value="all">全部上下文</option>
                      <option value="current">仅当前消息</option>
                      <option value="prd">仅 PRD 文档</option>
                      <option value="none">无上下文</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs text-text-secondary mb-1 block">默认输出</span>
                    <select
                      value={form.outputMode}
                      onChange={(e) => setForm({ ...form, outputMode: e.target.value })}
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
                    value={form.promptTemplate}
                    onChange={(e) => setForm({ ...form, promptTemplate: e.target.value })}
                    className="w-full px-3 py-2 text-sm rounded-lg ui-control resize-y min-h-[120px]"
                    placeholder="请输入技能的提示词内容"
                  />
                </label>

                {/* Save */}
                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    onClick={() => { setEditingKey(null); setIsNew(false); }}
                    className="px-4 py-2 text-xs rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!form.title.trim() || !form.promptTemplate.trim() || isSaving}
                    className="px-4 py-2 text-xs rounded-lg bg-primary-500 text-white hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSaving ? '保存中...' : isNew ? '创建' : '保存'}
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
    </div>,
    document.body
  );
}
