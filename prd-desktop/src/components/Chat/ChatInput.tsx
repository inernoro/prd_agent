import { useCallback, useEffect, useMemo, useState, useRef, KeyboardEvent, useLayoutEffect } from 'react';
import { invoke } from '../../lib/tauri';
import { useSessionStore } from '../../stores/sessionStore';
import { useMessageStore } from '../../stores/messageStore';
import { useAuthStore } from '../../stores/authStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useUiPrefsStore } from '../../stores/uiPrefsStore';
import { useSkillStore } from '../../stores/skillStore';
import { useSystemNoticeStore } from '../../stores/systemNoticeStore';
import { ApiResponse, AttachmentInfo, Message, Skill, SkillSuggestion, SkillsResponse } from '../../types';
import AttachmentPreview from './AttachmentPreview';
import SkillManagerModal from './SkillManagerModal';
import { open as tauriDialogOpen } from '@tauri-apps/plugin-dialog';

export default function ChatInput() {
  const { sessionId, currentRole, document } = useSessionStore();
  const {
    addUserMessageWithPendingAssistant,
    isStreaming,
    stopStreaming,
    ackPendingUserMessageRunId,
    clearPendingAssistant,
    messages,
  } = useMessageStore();
  const { user } = useAuthStore();
  const connectionStatus = useConnectionStore((s) => s.status);
  const pushNotice = useSystemNoticeStore((s) => s.push);
  const isDisconnected = connectionStatus === 'disconnected';
  const aiAnyway = useUiPrefsStore((s) => s.aiAnyway);
  const toggleAiAnyway = useUiPrefsStore((s) => s.toggleAiAnyway);
  const [content, setContent] = useState('');
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const skillsContainerRef = useRef<HTMLDivElement>(null);
  const [resendTargetMessageId, setResendTargetMessageId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputHeight, setInputHeight] = useState(36);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 附件状态
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  // 技能管理弹窗
  const [showSkillManager, setShowSkillManager] = useState(false);
  const [skillSuggestion, setSkillSuggestion] = useState<SkillSuggestion | null>(null);
  const [skillSuggestionSaving, setSkillSuggestionSaving] = useState(false);
  const dismissedSuggestionIdsRef = useRef<Set<string>>(new Set());
  const lastCheckedAssistantIdRef = useRef<string>('');

  // 技能 store
  const { skills, setSkills, setLoading, getVisibleSkills, pinnedSkillKeys } = useSkillStore();

  const canChat = !!sessionId;
  const canChatNow = canChat && !isDisconnected;

  const waitForUiPaint = useCallback(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }, []);

  const refreshSkills = useCallback(async () => {
    if (!sessionId) return;
    try {
      const resp = await invoke<ApiResponse<SkillsResponse>>('get_skills', { role: currentRole });
      if (resp?.success && resp.data?.skills) {
        setSkills(resp.data.skills);
      }
    } catch {
      // ignore
    }
  }, [sessionId, currentRole, setSkills]);

  useEffect(() => {
    if (isStreaming && isSubmitting) setIsSubmitting(false);
  }, [isStreaming, isSubmitting]);

  // 外部触发：预填输入框
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const ce = e as CustomEvent<{ content?: string; resendMessageId?: string | null }>;
      const next = String(ce?.detail?.content ?? '').trim();
      const mid = ce?.detail?.resendMessageId ? String(ce.detail.resendMessageId) : null;
      if (!next) return;
      setContent(next);
      setResendTargetMessageId(mid);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        const ta = textareaRef.current;
        if (ta) {
          const len = ta.value.length;
          try { ta.setSelectionRange(len, len); } catch { /* ignore */ }
        }
      });
    };
    window.addEventListener('prdAgent:prefillChatInput' as any, onPrefill as EventListener);
    return () => window.removeEventListener('prdAgent:prefillChatInput' as any, onPrefill as EventListener);
  }, []);

  // 从新 API 加载技能列表
  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    refreshSkills()
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false));
  }, [sessionId, currentRole, refreshSkills, setLoading]);

  // 按角色过滤的技能列表
  const visibleSkills = useMemo(
    () => getVisibleSkills(currentRole),
    [currentRole, getVisibleSkills, skills, pinnedSkillKeys]
  );

  useEffect(() => {
    setSkillSuggestion(null);
    lastCheckedAssistantIdRef.current = '';
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || isStreaming || isSubmitting) return;
    const latestAssistant = [...messages]
      .reverse()
      .find((m) => m.role === 'Assistant' && String(m.content || '').trim().length > 0);
    if (!latestAssistant?.id) return;
    if (lastCheckedAssistantIdRef.current === latestAssistant.id) return;
    lastCheckedAssistantIdRef.current = latestAssistant.id;

    invoke<ApiResponse<{ suggestion?: SkillSuggestion | null }>>('get_latest_skill_suggestion', {
      sessionId,
      assistantMessageId: latestAssistant.id,
    })
      .then((resp) => {
        const suggestion = resp?.success ? ((resp.data as any)?.suggestion as SkillSuggestion | null | undefined) : null;
        if (!suggestion?.suggestionId) {
          setSkillSuggestion(null);
          return;
        }
        if (dismissedSuggestionIdsRef.current.has(String(suggestion.suggestionId))) {
          return;
        }
        setSkillSuggestion(suggestion);
      })
      .catch(() => {
        // ignore
      });
  }, [sessionId, messages, isStreaming, isSubmitting]);

  const handleDismissSkillSuggestion = useCallback(() => {
    if (skillSuggestion?.suggestionId) {
      dismissedSuggestionIdsRef.current.add(String(skillSuggestion.suggestionId));
    }
    setSkillSuggestion(null);
  }, [skillSuggestion]);

  const handleConfirmSkillSuggestion = useCallback(async () => {
    if (!sessionId || !skillSuggestion || skillSuggestionSaving) return;
    try {
      setSkillSuggestionSaving(true);
      const resp = await invoke<ApiResponse<{ skillKey: string; alreadyExists?: boolean }>>(
        'confirm_skill_suggestion',
        {
          sessionId,
          suggestionId: skillSuggestion.suggestionId,
          assistantMessageId: skillSuggestion.sourceAssistantMessageId,
        }
      );
      if (!resp?.success) {
        pushNotice(resp?.error?.message || '保存技能失败', { level: 'error' });
        return;
      }
      const existed = (resp.data as any)?.alreadyExists === true;
      pushNotice(existed ? '技能已存在，已直接复用' : '已保存到技能库', { level: 'info' });
      dismissedSuggestionIdsRef.current.add(String(skillSuggestion.suggestionId));
      setSkillSuggestion(null);
      await refreshSkills();
    } catch {
      pushNotice('保存技能失败', { level: 'error' });
    } finally {
      setSkillSuggestionSaving(false);
    }
  }, [sessionId, skillSuggestion, skillSuggestionSaving, pushNotice, refreshSkills]);

  const pushSimulatedUserMessage = (text: string) => {
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'User',
      content: text,
      timestamp: new Date(),
      viewRole: currentRole,
      senderId: user?.userId ?? undefined,
      senderName: user?.displayName ?? undefined,
      senderRole: user?.role ?? undefined,
      senderAvatarUrl: user?.avatarUrl ?? undefined,
    };
    addUserMessageWithPendingAssistant({ userMessage });
    return userMessage;
  };

  // 单击技能 = 立即执行
  const handleSkillClick = async (skill: Skill) => {
    if (!sessionId || isStreaming || isSubmitting || isDisconnected) return;
    try {
      setIsSubmitting(true);
      setSkillSuggestion(null);
      const userInput = content.trim() || undefined;
      const text = userInput ? `【${skill.title}】${userInput}` : `【${skill.title}】`;
      pushSimulatedUserMessage(text);

      await waitForUiPaint();

      const resp = await invoke<ApiResponse<{ runId: string }>>('execute_skill', {
        skillKey: skill.skillKey,
        sessionId,
        userInput,
        attachmentIds: attachments.length ? attachments.map((a) => a.attachmentId) : undefined,
      });

      const runId = resp?.success ? resp.data?.runId : null;
      if (runId) {
        ackPendingUserMessageRunId({ runId });
        await invoke('subscribe_chat_run', { runId, afterSeq: 0 });
      }
      setContent('');
      setAttachments([]);
    } catch (err) {
      console.error('Failed to execute skill:', err);
      setIsSubmitting(false);
    }
  };

  const handleSend = async () => {
    if (!content.trim() || !sessionId || isStreaming || isSubmitting || isDisconnected) return;
    setSkillSuggestion(null);

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'User',
      content: content.trim(),
      timestamp: new Date(),
      viewRole: currentRole,
      senderId: user?.userId ?? undefined,
      senderName: user?.displayName ?? undefined,
      senderRole: user?.role ?? undefined,
      senderAvatarUrl: user?.avatarUrl ?? undefined,
    };

    setIsSubmitting(true);
    addUserMessageWithPendingAssistant({ userMessage });
    setContent('');

    const attachmentIds = attachments.length ? attachments.map((a) => a.attachmentId) : undefined;
    setAttachments([]);

    try {
      await waitForUiPaint();
      if (resendTargetMessageId) {
        const target = resendTargetMessageId;
        setResendTargetMessageId(null);
        await invoke('resend_message', {
          sessionId,
          messageId: target,
          content: userMessage.content,
          role: currentRole.toLowerCase(),
          attachmentIds,
          skipAiReply: !aiAnyway || undefined,
        });
      } else {
        const resp = await invoke<ApiResponse<any>>('create_chat_run', {
          sessionId,
          content: userMessage.content,
          role: currentRole.toLowerCase(),
          attachmentIds,
          skipAiReply: !aiAnyway || undefined,
        });
        const data = resp?.success ? (resp as any).data : null;
        const runId = data?.runId ? String(data.runId) : '';
        const skippedAi = data?.skippedAiReply === true;

        if (skippedAi) {
          clearPendingAssistant();
          setIsSubmitting(false);
        } else if (runId) {
          ackPendingUserMessageRunId({ runId });
          await invoke('subscribe_chat_run', { runId, afterSeq: 0 });
        }
      }
    } catch (err) {
      console.error('Failed to send message:', err);
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!isStreaming) return;
    try {
      const lastUserRunId = useMessageStore
        .getState()
        .messages?.slice()
        .reverse()
        .find((m) => m.role === 'User' && m.runId)?.runId;
      if (lastUserRunId) {
        await invoke('cancel_chat_run', { runId: lastUserRunId });
      }
      await invoke('cancel_stream', { kind: 'message' });
    } catch (err) {
      console.error('Failed to cancel stream:', err);
    } finally {
      stopStreaming();
    }
  };

  // 附件上传
  const handleAttachmentClick = async () => {
    if (isUploading || !canChatNow) return;
    try {
      const selected = await tauriDialogOpen({
        multiple: true,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length === 0) return;

      setIsUploading(true);
      for (const filePath of paths) {
        try {
          const resp = await invoke<ApiResponse<AttachmentInfo>>('upload_attachment', { filePath });
          if (resp?.success && resp.data) {
            setAttachments((prev) => [...prev, resp.data!]);
          }
        } catch (innerErr) {
          console.error('Failed to upload file:', innerErr);
        }
      }
      setIsUploading(false);
    } catch (err) {
      console.error('Failed to open file dialog:', err);
      setIsUploading(false);
    }
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    setAttachments((prev) => prev.filter((a) => a.attachmentId !== attachmentId));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const CONTROL_HEIGHT = 36;

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const next = Math.max(CONTROL_HEIGHT, Math.min(textarea.scrollHeight, 200));
      textarea.style.height = next + 'px';
      setInputHeight(next);
    }
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => adjustTextareaHeight());
    return () => cancelAnimationFrame(raf);
  }, [content, adjustTextareaHeight]);

  // 技能溢出检测
  const checkSkillsOverflow = useCallback(() => {
    const container = skillsContainerRef.current;
    if (!container) return;
    if (!showAllSkills) {
      setHasOverflow(container.scrollWidth > container.clientWidth);
    }
  }, [showAllSkills]);

  useLayoutEffect(() => {
    checkSkillsOverflow();
    window.addEventListener('resize', checkSkillsOverflow);
    return () => window.removeEventListener('resize', checkSkillsOverflow);
  }, [checkSkillsOverflow, visibleSkills]);

  useEffect(() => {
    if (!showAllSkills) {
      requestAnimationFrame(checkSkillsOverflow);
    }
  }, [showAllSkills, checkSkillsOverflow]);

  const actionDisabled = isStreaming || isSubmitting || isDisconnected;

  return (
    <div className="border-t ui-glass-bar">
      {/* 统一技能栏：单行 chips，点击即执行 */}
      {canChat && document?.id && visibleSkills.length > 0 && (
        <div className="px-3 py-2 flex items-start gap-2 border-b border-black/10 dark:border-white/10 ui-glass-bar">
          <div className="flex-1 min-w-0 flex items-center gap-1">
            <div
              ref={skillsContainerRef}
              className={`flex items-center gap-1 ${
                showAllSkills ? 'flex-wrap flex-1' : 'overflow-hidden'
              }`}
            >
              {visibleSkills.map((skill) => (
                <button
                  key={skill.skillKey}
                  onClick={() => handleSkillClick(skill)}
                  disabled={actionDisabled}
                  className={`flex-shrink-0 px-2.5 py-1.5 text-xs ui-chip transition-colors ${
                    actionDisabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
                  } text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-black/5 dark:hover:bg-white/5`}
                  title={skill.description || skill.title}
                >
                  {skill.icon && <span className="mr-0.5">{skill.icon}</span>}
                  <span className="hidden sm:inline">{skill.title}</span>
                  <span className="sm:hidden">{skill.order}</span>
                  {skill.visibility === 'personal' && (
                    <span className="ml-0.5 text-[9px] opacity-40">私</span>
                  )}
                </button>
              ))}
              {showAllSkills && (
                <button
                  onClick={() => setShowAllSkills(false)}
                  className="flex-shrink-0 px-2 py-1.5 text-xs text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
                >
                  收起
                </button>
              )}
            </div>
            {hasOverflow && !showAllSkills && (
              <button
                onClick={() => setShowAllSkills(true)}
                className="flex-shrink-0 px-2 py-1.5 text-xs text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
              >
                更多
              </button>
            )}
            {/* 管理按钮 */}
            <button
              onClick={() => setShowSkillManager(true)}
              className="flex-shrink-0 px-2 py-1.5 text-xs text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300 transition-colors"
            >
              +
            </button>
          </div>

          {/* AI Anyway 开关 */}
          <div className="flex-shrink-0 flex items-center gap-1.5">
            <span className="text-xs text-text-secondary whitespace-nowrap">AI</span>
            <button
              onClick={toggleAiAnyway}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                aiAnyway ? 'bg-primary-500' : 'bg-gray-300 dark:bg-gray-600'
              }`}
              aria-label="AI Anyway"
              title={aiAnyway ? '发消息时 AI 会回复' : '发消息时 AI 不回复（仅发送）'}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  aiAnyway ? 'translate-x-4' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      )}

      {skillSuggestion && (
        <div className="mx-3 mt-2 rounded-xl border border-primary-500/30 bg-primary-500/10 px-3 py-2.5">
          <div className="text-xs font-medium text-text-primary">
            检测到可复用流程：{skillSuggestion.title}
          </div>
          <div className="mt-1 text-[11px] text-text-secondary">
            {skillSuggestion.reason || '当前轮次适合沉淀为技能'}
            {typeof skillSuggestion.confidence === 'number'
              ? `（置信度 ${Math.round(skillSuggestion.confidence * 100)}%）`
              : ''}
          </div>
          {Array.isArray(skillSuggestion.tags) && skillSuggestion.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {skillSuggestion.tags.slice(0, 6).map((tag, idx) => (
                <span
                  key={`skill-suggestion-tag-${idx}`}
                  className="px-1.5 py-0.5 text-[10px] rounded-md border border-primary-500/40 text-primary-600 dark:text-primary-300"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleConfirmSkillSuggestion()}
              disabled={skillSuggestionSaving}
              className="h-7 px-3 text-[11px] rounded-md bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {skillSuggestionSaving ? '保存中...' : '保存为技能'}
            </button>
            <button
              type="button"
              onClick={handleDismissSkillSuggestion}
              disabled={skillSuggestionSaving}
              className="h-7 px-3 text-[11px] rounded-md border border-black/10 dark:border-white/15 text-text-secondary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              忽略
            </button>
          </div>
        </div>
      )}

      {/* 附件预览条 */}
      {attachments.length > 0 && (
        <AttachmentPreview
          attachments={attachments}
          onRemove={handleRemoveAttachment}
        />
      )}

      {/* 输入区域 */}
      <div className="px-3 pb-3 pt-2">
        <div className="grid grid-cols-[36px,1fr,36px] items-stretch gap-2">
          <div className="flex items-end" style={{ height: `${inputHeight}px` }}>
            <button
              type="button"
              onClick={handleAttachmentClick}
              disabled={isUploading || !canChatNow}
              className={`h-9 w-9 flex items-center justify-center text-text-secondary hover:text-primary-500 transition-colors rounded-lg hover:bg-black/5 dark:hover:bg-white/5 ${
                isUploading ? 'animate-pulse' : ''
              } disabled:opacity-50 disabled:cursor-not-allowed`}
              aria-label="附件"
              title={isUploading ? '上传中...' : '上传图片附件'}
            >
              {isUploading ? (
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              )}
            </button>
          </div>

          <div className="min-w-0 relative flex items-stretch" style={{ height: `${inputHeight}px` }}>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isDisconnected
                  ? "服务器已断开连接，正在重连..."
                  : (canChat ? "输入您的问题... (Enter 发送, Shift+Enter 换行)" : "该群组未绑定 PRD，无法提问")
              }
              className="w-full min-w-0 px-3 py-2 ui-control rounded-xl resize-none text-sm overflow-y-hidden"
              rows={1}
              disabled={isStreaming || !canChatNow}
            />
          </div>

          <div className="flex items-end justify-end" style={{ height: `${inputHeight}px` }}>
            <button
              onClick={isStreaming ? handleCancel : handleSend}
              disabled={isStreaming ? false : (isSubmitting || !content.trim() || !canChatNow)}
              className="h-9 w-9 flex items-center justify-center bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label={isStreaming ? '停止' : '发送'}
              title={isStreaming ? '停止' : '发送'}
            >
              {isStreaming ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 6h12v12H6z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* 技能管理弹窗 */}
      <SkillManagerModal
        open={showSkillManager}
        onClose={() => {
          setShowSkillManager(false);
          // 关闭弹窗后刷新技能列表
          void refreshSkills();
        }}
      />
    </div>
  );
}
