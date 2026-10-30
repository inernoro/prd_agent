import type { PdfDownloadContext } from './pdfDownloadBridge';

export const PACKAGE_DOWNLOAD_REQUEST = 'map-hosted-package-download';
export const PACKAGE_DOWNLOAD_STATUS = 'map-hosted-package-status';
export const PACKAGE_MANIFEST_PATH = 'downloads/tutorial-package.json';
type Part = { path: string; bytes: number; sha256: string };
export type PackageManifest = { fileName: string; bytes: number; sha256: string; parts: Part[] };
type PackageRequest = { type: typeof PACKAGE_DOWNLOAD_REQUEST; siteId: string; nonce: string; requestId: string };
const MAX_PART_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export function acceptPackageDownloadRequest(data: unknown, source: MessageEventSource | null,
  frame: Window | null | undefined, context: PdfDownloadContext): data is PackageRequest {
  if (!frame || source !== frame || !data || typeof data !== 'object') return false;
  const request = data as Partial<PackageRequest>;
  return request.type === PACKAGE_DOWNLOAD_REQUEST && request.siteId === context.siteId
    && request.nonce === context.nonce && typeof request.requestId === 'string'
    && request.requestId.length > 0 && request.requestId.length <= 80;
}

export function parsePackageManifest(data: unknown): PackageManifest {
  const invalid = () => new Error('完整包清单不完整，请联系分享者更新下载文件。');
  if (!data || typeof data !== 'object') throw invalid();
  const m = data as PackageManifest;
  if (typeof m.fileName !== 'string' || !/^[^\\/:*?"<>|]{1,120}\.zip$/i.test(m.fileName)
    || Array.from(m.fileName).some(c => c.charCodeAt(0) < 32)
    || !Number.isSafeInteger(m.bytes) || m.bytes <= 0 || m.bytes > MAX_PACKAGE_BYTES
    || typeof m.sha256 !== 'string' || !SHA256.test(m.sha256)
    || !Array.isArray(m.parts) || m.parts.length < 1 || m.parts.length > 64) throw invalid();
  let sum = 0;
  const paths = new Set<string>();
  for (const p of m.parts) {
    if (!p || typeof p.path !== 'string' || !/^downloads\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.bin$/.test(p.path)
      || paths.has(p.path) || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || p.bytes > MAX_PART_BYTES
      || typeof p.sha256 !== 'string' || !SHA256.test(p.sha256)) throw invalid();
    paths.add(p.path); sum += p.bytes;
  }
  if (sum !== m.bytes) throw invalid();
  return m;
}

/** 只读取当前版本目录内的固定清单和有限分片；子网页不能指定远程下载 URL。 */
export async function downloadHostedPackage(context: PdfDownloadContext, signal: AbortSignal,
  progress: (message: string, percent: number) => void): Promise<{ blob: Blob; fileName: string }> {
  const root = new URL('../'.repeat(context.entryFile.split('/').length - 1) || '.', context.siteUrl);
  if (root.protocol !== 'https:') throw new Error('下载地址不可用，请刷新分享页后重试。');
  const options: RequestInit = { signal, credentials: 'omit', redirect: 'error', cache: 'no-store' };
  const manifestReply = await fetch(new URL(PACKAGE_MANIFEST_PATH, root), options);
  if (!manifestReply.ok || Number(manifestReply.headers.get('content-length')) > 65536)
    throw new Error('下载清单暂时不可用，请稍后重试。');
  const manifestText = await manifestReply.text();
  if (manifestText.length > 65536) throw new Error('下载清单过大，请联系分享者。');
  const manifest = parsePackageManifest(JSON.parse(manifestText));
  const blobs: Blob[] = [];
  let received = 0, lastPercent = -1;
  for (const part of manifest.parts) {
    const response = await fetch(new URL(part.path, root), options);
    if (!response.ok || !response.body) throw new Error('下载中断，请检查网络后重新点击下载。');
    const reader = response.body.getReader();
    let partBytes = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { controller.close(); return; }
          partBytes += next.value.byteLength; received += next.value.byteLength;
          if (partBytes > part.bytes) { await reader.cancel(); throw new Error('下载文件大小有误，请联系分享者更新完整包。'); }
          const percent = Math.min(99, Math.floor(received / manifest.bytes * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            progress(`正在准备完整教程包：${percent}%（${(received / 1e9).toFixed(2)} / ${(manifest.bytes / 1e9).toFixed(2)} GB），请保持本页打开。`, percent);
          }
          controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      cancel: () => reader.cancel(),
    });
    const blob = await new Response(stream).blob();
    if (blob.size !== part.bytes) throw new Error('下载文件不完整，请检查网络后重试。');
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== part.sha256) throw new Error('下载文件校验失败，请重新下载。');
    blobs.push(blob);
  }
  const blob = new Blob(blobs, { type: 'application/zip' });
  if (blob.size !== manifest.bytes) throw new Error('完整包大小有误，请重新下载。');
  return { blob, fileName: manifest.fileName };
}

export function withPackageDownloadBridge(html: string, context: PdfDownloadContext): string {
  if (!html || !context.siteId) return html;
  const config = JSON.stringify({ siteId: context.siteId, nonce: context.nonce })
    .replace(/</g, '\\u003c');
  return `${html}<script data-map-package-download-bridge>(function(){
var config=${config},requestId=null,running=false;
function update(message,percent){
 document.querySelectorAll('[data-package-status]').forEach(function(n){n.textContent=message;});
 document.querySelectorAll('[data-package-progress]').forEach(function(n){n.hidden=!running;n.value=percent;});
 document.querySelectorAll('[data-download-package]').forEach(function(n){n.disabled=running;n.textContent=running?'正在准备下载…':'下载完整教程包';});
}
window.addEventListener('message',function(event){
 var d=event.data;
 if(event.source!==window.parent||!d||d.type!=='${PACKAGE_DOWNLOAD_STATUS}'||d.requestId!==requestId)return;
 running=d.status==='pending';update(d.message,d.percent||0);
});
window.addEventListener('click',function(event){
 if(!event.isTrusted||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
 var button=event.target instanceof Element?event.target.closest('[data-download-package]'):null;
 if(!button)return;
 event.preventDefault();event.stopImmediatePropagation();
 if(running)return;
 requestId=crypto.randomUUID();running=true;update('正在连接完整教程包…',0);
 window.parent.postMessage({type:'${PACKAGE_DOWNLOAD_REQUEST}',siteId:config.siteId,nonce:config.nonce,requestId:requestId},'*');
},true);
})();</script>`;
}
