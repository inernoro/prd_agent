import { useCallback, useEffect, useRef, useState } from 'react';
import { createDefect, updateDefect, addDefectAttachment, deleteDefectAttachment, submitDefect } from '@/services';
import type { CreateDefectContract, DefectReport } from '@/services/contracts/defectAgent';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';
import { toast } from '@/lib/toast';

type DraftInput = Omit<Parameters<CreateDefectContract>[0], 'clientRequestId'>;
export interface SubmissionAttachment { file: File; description?: string }
interface SubmissionSnapshot {
  input: Readonly<DraftInput>;
  attachments: readonly Readonly<SubmissionAttachment>[];
}
interface Options {
  onCreated?: (defect: DefectReport) => void;
  onSubmitted?: (defect: DefectReport) => void;
  /** 已核实原记录提交成功，但当前编辑未应用；只同步记录，不关闭编辑器。 */
  onRecovered?: (defect: DefectReport) => void;
}
interface Attempt {
  clientRequestId: string;
  initialInput: DraftInput;
  notifiedDraftId?: string;
  files: Map<File, { clientRequestId: string; description?: string }>;
  submittedSnapshot?: SubmissionSnapshot;
}

const inputFields = ['templateId', 'title', 'content', 'assigneeUserId', 'severity', 'priority', 'projectId', 'teamId'] as const satisfies readonly (keyof DraftInput)[];
const normalized = (value: string | undefined) => (value ?? '').trim();
function snapshot(input: DraftInput, attachments: readonly SubmissionAttachment[]): SubmissionSnapshot {
  return Object.freeze({ input: Object.freeze({ ...input }), attachments: Object.freeze(attachments.map((item) => Object.freeze({ ...item }))) });
}
function sameSubmission(left: SubmissionSnapshot, right: SubmissionSnapshot): boolean {
  return inputFields.every((field) => normalized(left.input[field]) === normalized(right.input[field]))
    && left.attachments.length === right.attachments.length
    && left.attachments.every((item, index) => item.file === right.attachments[index].file
      && normalized(item.description) === normalized(right.attachments[index].description));
}

/** 两个提交入口共用传输重试身份；业务状态始终以服务器返回的草稿为准。 */
export function useDefectSubmission(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const attemptRef = useRef<Attempt | null>(null);
  const busyRef = useRef(false);
  const confirmationRef = useRef(false);
  const failureToastRef = useRef<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState('');
  const [savedDefect, setSavedDefect] = useState<DefectReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [unappliedChanges, setUnappliedChanges] = useState(false);

  const dismissFailure = useCallback(() => {
    if (failureToastRef.current) toast.dismiss(failureToastRef.current);
    failureToastRef.current = undefined;
  }, []);
  useEffect(() => () => dismissFailure(), [dismissFailure]);

  const reset = useCallback(() => {
    if (busyRef.current) return;
    dismissFailure();
    attemptRef.current = null;
    setSavedDefect(null);
    setError(null);
    setProgress('');
    setConfirmationPending(false);
    setUnappliedChanges(false);
    confirmationRef.current = false;
  }, [dismissFailure]);

  const submit = useCallback(async (input: DraftInput, attachments: SubmissionAttachment[]): Promise<boolean> => {
    if (busyRef.current) return false;
    dismissFailure();
    busyRef.current = true;
    setSubmitting(true);
    setError(null);
    const currentSnapshot = snapshot(input, attachments);
    const attempt = attemptRef.current ?? {
      clientRequestId: crypto.randomUUID(),
      initialInput: { ...currentSnapshot.input },
      files: new Map<File, { clientRequestId: string; description?: string }>(),
    };
    attemptRef.current = attempt;
    let confirmingSubmission = confirmationRef.current;
    const preserveCurrentChanges = (defect: DefectReport): boolean => {
      const sent = attempt.submittedSnapshot ?? snapshot(attempt.initialInput, []);
      if (sameSubmission(currentSnapshot, sent)) return false;
      const message = `缺陷 ${defect.defectNo} 已提交；当前修改尚未保存，内容和附件仍保留在此表单。`;
      setUnappliedChanges(true);
      setConfirmationPending(false);
      confirmationRef.current = false;
      setError(message);
      failureToastRef.current = toast.error('当前修改尚未保存', message);
      optionsRef.current.onRecovered?.(defect);
      return true;
    };
    try {
      setProgress('正在保存草稿');
      // 创建响应丢失时，重放首次请求的身份与内容，随后再保存当前编辑结果。
      const created = await createDefect({ ...attempt.initialInput, clientRequestId: attempt.clientRequestId });
      if (!created.success) throw created.error;
      if (!created.data?.defect) throw new Error('草稿保存未完成');
      let defect = created.data.defect;
      confirmingSubmission = false;
      setSavedDefect(defect);
      if (attempt.notifiedDraftId !== defect.id) {
        attempt.notifiedDraftId = defect.id;
        optionsRef.current.onCreated?.(defect);
      }

      if (defect.status === 'draft' || defect.status === 'awaiting') {
        const updated = await updateDefect({
          ...currentSnapshot.input, id: defect.id,
          templateId: currentSnapshot.input.templateId ?? '',
          projectId: currentSnapshot.input.projectId ?? '',
          teamId: currentSnapshot.input.teamId ?? '',
        });
        if (!updated.success) throw updated.error;
        if (!updated.data?.defect) throw new Error('草稿更新未完成');
        defect = updated.data.defect;
        setSavedDefect(defect);

        // 只同步本次编辑会话已发送过的文件；其他来源附件和系统日志保持服务器原状。
        const sentIds = new Set([...attempt.files.values()].map((file) => file.clientRequestId));
        const keptIds = new Set(currentSnapshot.attachments.map((item) => attempt.files.get(item.file)?.clientRequestId));
        for (const uploaded of defect.attachments ?? []) {
          if (!uploaded.clientRequestId || !sentIds.has(uploaded.clientRequestId) || keptIds.has(uploaded.clientRequestId)) continue;
          setProgress('正在同步附件');
          const removed = await deleteDefectAttachment({ id: defect.id, attachmentId: uploaded.id });
          if (!removed.success) throw removed.error;
        }

        for (let index = 0; index < currentSnapshot.attachments.length; index++) {
          const item = currentSnapshot.attachments[index];
          let identity = attempt.files.get(item.file);
          if (!identity) {
            identity = { clientRequestId: crypto.randomUUID(), description: item.description };
            attempt.files.set(item.file, identity);
          }
          setProgress(`正在上传附件 ${index + 1}/${currentSnapshot.attachments.length}`);
          const uploaded = await addDefectAttachment({ id: defect.id, file: item.file, ...identity });
          if (!uploaded.success) throw uploaded.error;
          if (!uploaded.data?.attachment) throw new Error('附件上传未完成');
        }
        // 保存实际送出的不可变传输版本；恢复已提交结果时不能把之后的编辑当成已保存。
        attempt.submittedSnapshot = snapshot({ ...currentSnapshot.input }, currentSnapshot.attachments.map((item) => ({
          file: item.file, description: attempt.files.get(item.file)?.description,
        })));
      } else if (preserveCurrentChanges(defect)) {
        return false;
      }

      setProgress('正在确认提交');
      confirmingSubmission = true;
      // 已提交请求的重放交给后端判断，不在客户端推导或回退业务状态。
      const submitted = await submitDefect({ id: defect.id });
      if (!submitted.success) {
        // apiRequest 也把断连、超时转换成业务形状的失败；没有确认结果时不能断言服务端未提交。
        throw submitted.error;
      }
      if (!submitted.data?.defect) throw new Error('提交结果尚未确认');
      setSavedDefect(submitted.data.defect);
      if (preserveCurrentChanges(submitted.data.defect)) return false;
      setConfirmationPending(false);
      confirmationRef.current = false;
      setUnappliedChanges(false);
      toast.success('缺陷已提交');
      optionsRef.current.onSubmitted?.(submitted.data.defect);
      return true;
    } catch (failure) {
      confirmationRef.current = confirmingSubmission;
      setConfirmationPending(confirmingSubmission);
      const message = toUserReadableErrorMessage(failure, {
        fallbackMessage: confirmingSubmission ? '提交结果待确认' : '缺陷尚未提交',
        recoveryMessage: confirmingSubmission ? '请重试确认，系统会继续本次提交。' : '请重试；已保存的草稿会继续使用。',
      });
      setError(message);
      failureToastRef.current = toast.error(confirmingSubmission ? '提交结果待确认' : '缺陷尚未提交', message);
      return false;
    } finally {
      busyRef.current = false;
      setSubmitting(false);
      setProgress('');
    }
  }, [dismissFailure]);

  return { submit, submitting, progress, savedDefect, error, confirmationPending, unappliedChanges, reset };
}
