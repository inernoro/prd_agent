import { acceptPackageDownloadRequest, downloadHostedPackage, PACKAGE_DOWNLOAD_STATUS, withPackageDownloadBridge } from './packageDownloadBridge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadHostedPdf } from '@/services/real/webPages';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { saveBlobAsFile } from './sourceDownload';
import { acceptPdfDownloadRequest, PDF_DOWNLOAD_INIT, PDF_DOWNLOAD_STATUS, withPdfDownloadBridge } from './pdfDownloadBridge';

type PdfDownloadSite = { id: string; siteUrl: string; entryFile: string; pdfFilePaths?: string[] };
type Status = { kind: 'idle' | 'pending' | 'handed-off' | 'error'; message: string };

export function useHostedPdfDownload(site: PdfDownloadSite | null, share?: { token: string; password?: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle', message: '' });
  const pendingRef = useRef<object | null>(null);
  const siteId = site?.id ?? '';
  const siteUrl = site?.siteUrl ?? '';
  const entryFile = site?.entryFile ?? '';
  const pathsKey = JSON.stringify(site?.pdfFilePaths ?? []);
  const context = useMemo(() => ({ siteId, siteUrl, entryFile,
    pdfFilePaths: JSON.parse(pathsKey) as string[], nonce: crypto.randomUUID() }),
  [siteId, siteUrl, entryFile, pathsKey]);
  const shareToken = share?.token;
  const sharePassword = share?.password;

  const notifyFrame = useCallback(() => {
    if (!context.siteId) return;
    iframeRef.current?.contentWindow?.postMessage({ type: PDF_DOWNLOAD_INIT,
      siteId: context.siteId, nonce: context.nonce, pdfFilePaths: context.pdfFilePaths }, '*');
  }, [context]);

  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    pendingRef.current = null;
    setStatus({ kind: 'idle', message: '' });
    const receive = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (frame && event.source === frame && event.data?.type === 'map-hosted-pdf-ready') {
        notifyFrame();
        return;
      }
      if (acceptPackageDownloadRequest(event.data, event.source, frame, context)) {
        const request = event.data;
        const reply = (kind: Exclude<Status['kind'], 'idle'>, message: string, percent = 0) => {
          if (!active) return;
          setStatus({ kind, message });
          frame?.postMessage({ type: PACKAGE_DOWNLOAD_STATUS, requestId: request.requestId, status: kind, message, percent }, '*');
        };
        if (pendingRef.current) {
          reply('error', '已有文件正在准备，请等待当前下载完成。'); return;
        }
        if (navigator.userActivation?.isActive !== true) {
          reply('error', '请亲自点击完整教程包下载按钮后重试。'); return;
        }
        const pending = {};
        pendingRef.current = pending;
        reply('pending', '正在连接完整教程包…');
        void downloadHostedPackage(context, abort.signal, (message, percent) => reply('pending', message, percent))
          .then(result => {
            if (!active) return;
            saveBlobAsFile(result.blob, result.fileName);
            reply('handed-off', '完整 ZIP 已交给浏览器，请查看下载列表。', 100);
          }).catch((error: unknown) => {
            reply('error', error instanceof Error ? error.message : '下载中断，请检查网络后重试。');
          }).finally(() => { if (pendingRef.current === pending) pendingRef.current = null; });
        return;
      }
      if (!acceptPdfDownloadRequest(event.data, event.source, frame, context)) return;
      const request = event.data;
      const reply = (kind: Exclude<Status['kind'], 'idle'>, message: string) => {
        if (!active) return;
        setStatus({ kind, message });
        frame?.postMessage({ type: PDF_DOWNLOAD_STATUS, requestId: request.requestId, status: kind, message }, '*');
      };
      if (pendingRef.current) {
        frame?.postMessage({ type: PDF_DOWNLOAD_STATUS, requestId: request.requestId,
          status: 'pending', message: '另一份 PDF 正在准备，请等待当前下载完成后再点击。' }, '*');
        return;
      }
      if (navigator.userActivation?.isActive !== true) {
        reply('error', '请亲自点击网页中的 PDF 下载按钮后重试。');
        return;
      }
      const pending = {};
      pendingRef.current = pending;
      reply('pending', '正在准备 PDF，请稍候…');
      void downloadHostedPdf(context.siteId, request.filePath,
        shareToken ? { token: shareToken, password: sharePassword } : undefined).then(result => {
        if (!active) return;
        if (!/^application\/pdf(?:;|$)/i.test(result.contentType))
          throw new Error('返回的文件不是 PDF，请刷新网页后重试。');
        saveBlobAsFile(result.blob, result.fileName);
        reply('handed-off', 'PDF 已交给浏览器，请查看下载列表。');
      }).catch((error: unknown) => {
        reply('error', error instanceof Error ? error.message : 'PDF 下载未完成，请稍后重新点击下载按钮。');
      }).finally(() => { if (pendingRef.current === pending) pendingRef.current = null; });
    };
    window.addEventListener('message', receive);
    return () => { active = false; abort.abort(); window.removeEventListener('message', receive); };
  }, [context, shareToken, sharePassword, notifyFrame]);

  return { iframeRef, notifyFrame, status,
    decorateHtml: (html: string) => withPackageDownloadBridge(withPdfDownloadBridge(html, context), context) };
}

export function HostedPdfDownloadStatus({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  return <div role={status.kind === 'error' ? 'alert' : 'status'} aria-live="polite"
    className="absolute bottom-3 left-3 z-20 flex max-w-[90%] items-center gap-2 rounded-lg border border-token-subtle bg-token-card px-3 py-2 text-xs text-token-primary shadow-lg">
    {status.kind === 'pending' && <MapSpinner size={14} />}
    {status.message}
  </div>;
}
