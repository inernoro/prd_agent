import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 项目管理表单草稿缓存（sessionStorage，会话内自动恢复）。
 *
 * 痛点：编辑目标/里程碑/任务时未保存就误关弹窗或误跳页，内容全丢、得重写。
 * 本 hook 让表单值实时（防抖）落到 sessionStorage，下次打开同一实体的表单自动回填，
 * 保存成功后清除草稿。遵守 no-localstorage.md：草稿是用户产物、非服务器权威数据，
 * 用 sessionStorage（关浏览器即清，发版后用旧值无害也不会串数据）。
 *
 * 用法：
 *   const [title, setTitle] = useState(''); ...
 *   const snapshot = useMemo(() => ({ title, desc, ... }), [title, desc, ...]);
 *   const { hasDraft, clearDraft, dismissHint } = useFormDraft({
 *     key: open ? pmDraftKey('milestone', projectId, milestone?.id) : null,
 *     value: snapshot,
 *     onRestore: (s) => { setTitle(s.title); setDesc(s.desc); ... },
 *   });
 *   // 保存成功后调用 clearDraft()
 */

const PREFIX = 'pm-draft:';

/** 草稿 key：实体类型 + 项目 + 实体 id（新建用 'new'）。带 projectId 防跨项目串草稿。 */
export function pmDraftKey(entity: string, projectId: string, id?: string | null): string {
  return `${PREFIX}${entity}:${projectId}:${id || 'new'}`;
}

interface Options<T> {
  /** sessionStorage key；null = 停用（如弹窗关闭时不读不写） */
  key: string | null;
  /** 当前表单快照（必须可 JSON 序列化） */
  value: T;
  /** 原始内容快照（未编辑时的值）。与 value 相等时不视为草稿，避免「没动过也提示恢复」 */
  pristine: T;
  /** 检测到草稿时回填到表单（每个 key 仅触发一次） */
  onRestore: (saved: T) => void;
  /** 是否启用，默认 true */
  enabled?: boolean;
}

export function useFormDraft<T>({ key, value, pristine, onRestore, enabled = true }: Options<T>) {
  const [hasDraft, setHasDraft] = useState(false);
  const restoredKeyRef = useRef<string | null>(null);
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  const pristineRef = useRef(pristine);
  pristineRef.current = pristine;

  // 恢复用 useLayoutEffect：在浏览器绘制前同步回填，state 更新先于下面的防抖落库 effect，
  // 避免「初始值把已存草稿覆盖掉」的竞态。
  useLayoutEffect(() => {
    if (!key || !enabled) return;
    if (restoredKeyRef.current === key) return;
    restoredKeyRef.current = key;
    try {
      const raw = sessionStorage.getItem(key);
      // 仅当草稿与原始内容不同才算「未保存改动」，相等则清理掉、不打扰用户
      if (raw && raw !== JSON.stringify(pristineRef.current)) {
        onRestoreRef.current(JSON.parse(raw) as T);
        setHasDraft(true);
      } else {
        if (raw) { try { sessionStorage.removeItem(key); } catch { /* ignore */ } }
        setHasDraft(false);
      }
    } catch {
      /* JSON 损坏 / 隐私模式无 storage：忽略，按无草稿处理 */
    }
  }, [key, enabled]);

  // 值变化时同步落库（仅在该 key 已完成恢复检测后）。草稿是极小 JSON，无需防抖；
  // 同步写可彻底规避「编辑后立刻关弹窗」因防抖未触发而丢最后改动。等于原始内容时删除草稿。
  useEffect(() => {
    if (!key || !enabled) return;
    if (restoredKeyRef.current !== key) return;
    try {
      if (JSON.stringify(value) === JSON.stringify(pristineRef.current)) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 配额超限等：静默 */
    }
  }, [key, enabled, value]);

  const clearDraft = useCallback(() => {
    if (key) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    restoredKeyRef.current = null;
    setHasDraft(false);
  }, [key]);

  /** 仅隐藏「已恢复草稿」提示条，不删除草稿 */
  const dismissHint = useCallback(() => setHasDraft(false), []);

  return { hasDraft, clearDraft, dismissHint };
}
