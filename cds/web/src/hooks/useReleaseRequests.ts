import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { correlateRelease, releaseFailureReason, readReleaseRequests, releaseRequestStorageKey, type ReleaseRequest } from '@/lib/releaseRequest';
import type { ReleaseRun } from '@/pages/release-center/types';

/** 控制台账号内的未确认请求。只读核对，不重发POST，也不充当发布账本。 */
export function useReleaseRequests(account: string) {
  const key = releaseRequestStorageKey(account);
  const initial = useRef<{ requests: ReleaseRequest[]; error: string } | null>(null);
  if (!initial.current) {
    try { initial.current = { requests: typeof window === 'undefined' ? [] : readReleaseRequests(window.sessionStorage, key), error: '' }; }
    catch { initial.current = { requests: [], error: '浏览器无法读取保留的请求编号，请检查会话存储并重新打开控制台后再发起发布。' }; }
  }
  const [requests, setRequests] = useState<ReleaseRequest[]>(initial.current.requests);
  const saved = useRef(requests);
  const initialRequests = useRef(requests);
  const [error, setError] = useState(initial.current.error);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [failureReasons, setFailureReasons] = useState<Record<string, string>>({});
  const noteUnknown = useCallback((requestId: string, error: unknown) => setFailureReasons(current => ({ ...current, [requestId]: releaseFailureReason(error) })), []);
  const [found, setFound] = useState<Record<string, ReleaseRun>>({});
  const readers = useRef(new Map<string, AbortController>());
  useEffect(() => () => { for (const reader of readers.current.values()) reader.abort(); readers.current.clear(); }, []);

  const persist = useCallback((next: ReleaseRequest[]): boolean => {
    try {
      window.sessionStorage.setItem(key, JSON.stringify(next));
      saved.current = next;
      setRequests(next);
      setError('');
      return true;
    } catch {
      setError('浏览器无法更新请求编号。请保留屏幕上的编号并检查会话存储，已有未确认请求仍需核对；请勿据此重复发起命令。');
      return false;
    }
  }, [key]);
  const remember = useCallback((request: ReleaseRequest): boolean => {
    if (initial.current?.error) return false;
    if (saved.current.some(item => item.projectId === request.projectId && item.targetId === request.targetId)) return false;
    return persist([...saved.current, request]);
  }, [persist]);
  const forget = useCallback((requestId: string): boolean => persist(saved.current.filter(item => item.requestId !== requestId)), [persist]);
  const hasUnconfirmed = useCallback((projectId: string, targetId: string): boolean => !!initial.current?.error || saved.current.some(item => item.projectId === projectId && item.targetId === targetId), []);

  const verify = useCallback(async (request: ReleaseRequest): Promise<void> => {
    if (readers.current.has(request.requestId)) return;
    const controller = new AbortController();
    readers.current.set(request.requestId, controller);
    setChecking(current => ({ ...current, [request.requestId]: true }));
    try {
      const data = await apiRequest<{ runs: ReleaseRun[] }>(`/api/releases/runs?project=${encodeURIComponent(request.projectId)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!Array.isArray(data.runs)) throw new Error('发布记录返回格式无法确认');
      const result = correlateRelease(request, data.runs);
      setFound(current => { const next = { ...current }; delete next[request.requestId]; if (result.kind === 'found') next[request.requestId] = result.run; return next; });
      const message = result.kind === 'found' ? '已找到本次请求的任务，可查看结果。'
        : result.kind === 'ambiguous' ? '找到多个同编号任务，不能自动选中。请在原目标记录核对。'
          : result.kind === 'mismatch' ? '记录与原请求的对象或来源版本不一致，已停止自动接续。'
            : '尚未找到本次请求，不能确认是否已执行。请保留编号并稍后再次核对。';
      setMessages(current => ({ ...current, [request.requestId]: message }));
    } catch (error) {
      if (controller.signal.aborted) return;
      setFound(current => { const next = { ...current }; delete next[request.requestId]; return next; });
      setMessages(current => ({ ...current, [request.requestId]: `核对失败：${releaseFailureReason(error)}；原请求仍未确认。` }));
    } finally {
      readers.current.delete(request.requestId);
      if (!controller.signal.aborted) setChecking(current => ({ ...current, [request.requestId]: false }));
    }
  }, []);
  useEffect(() => { for (const request of initialRequests.current) void verify(request); }, [verify]);
  return { requests, error, checking, messages, failureReasons, noteUnknown, found, remember, forget, hasUnconfirmed, verify };
}
