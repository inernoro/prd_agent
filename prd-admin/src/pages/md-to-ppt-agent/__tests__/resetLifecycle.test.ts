import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const page = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');
const resetBody = page.split('const handleReset = useCallback(() => {')[1]?.split('}, [resetStreamPreview, SESSION_KEY, OUTLINE_RUN_KEY]);')[0];

describe('PPT 新建会话解除旧修改的提交锁', () => {
  it.each([true, false])('旧会话提交中=%s，新建后允许继续修改且取消旧流', (submitting) => {
    expect(resetBody).toBeTruthy();
    const patchSubmissionRef = { current: submitting };
    const cleanup = vi.fn(() => expect(patchSubmissionRef.current).toBe(false));
    const cleanupRef = { current: cleanup as (() => void) | null };
    const stateSetters = Object.fromEntries([...resetBody!.matchAll(/\b(set[A-Z]\w*)\(/g)].map((match) => [match[1], vi.fn()]));
    const scope = {
      ...stateSetters, patchSubmissionRef, cleanupRef,
      repairRestartKeyRef: { current: null }, hasRuntimePreviewRef: { current: true },
      editedHtmlRef: { current: 'draft' }, restoreSlideRef: { current: 2 },
      pendingRestoreRef: { current: 2 }, pendingRectRef: { current: null },
      resetStreamPreview: vi.fn(), sessionStorage: { removeItem: vi.fn() },
      SESSION_KEY: 'session', OUTLINE_RUN_KEY: 'outline', window: { clearTimeout: vi.fn() },
    };
    // 执行页面真实回调，而不是另写一份模拟 reset 实现。
    new Function(...Object.keys(scope), resetBody!)(...Object.values(scope));
    expect(patchSubmissionRef.current).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(cleanupRef.current).toBeNull();
    expect(stateSetters.setIsProcessing).toHaveBeenCalledWith(false);
  });
});
