import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiDownloadedFile } from '@/services/real/apiClient';
import {
  describeOfflineExportFailure,
  offlineExportProgressLabel,
  readOfflineExportSummary,
  type OfflineExportSummary,
} from './offlineExport';
import { saveBlobAsFile } from './sourceDownload';

export type OfflineExportOutcome =
  | { ok: true; fileName: string; summary: OfflineExportSummary }
  | { ok: false; failure: { text: string; detail?: string } }
  /** 上一次还没打完，这一次点击被忽略 */
  | { ok: null };

/**
 * 离线 HTML 下载的共用状态：打包中不接受第二次点击、每秒更新一次已等待时长、
 * 成功就经唯一落盘出口 saveBlobAsFile 存盘，并把结论交回给调用方去展示。
 * 站内工作台与分享页共用它，两边对「打包中该显示什么」「失败怎么说」只有一份答案。
 */
export function useOfflineExport() {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return undefined;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const run = useCallback(async (download: () => Promise<ApiDownloadedFile>): Promise<OfflineExportOutcome> => {
    if (busyRef.current) return { ok: null };
    busyRef.current = true;
    setBusy(true);
    try {
      const file = await download();
      saveBlobAsFile(file.blob, file.fileName);
      return { ok: true, fileName: file.fileName, summary: readOfflineExportSummary(file.headers) };
    } catch (error) {
      return { ok: false, failure: describeOfflineExportFailure(error) };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, elapsed, label: offlineExportProgressLabel(elapsed), run };
}
