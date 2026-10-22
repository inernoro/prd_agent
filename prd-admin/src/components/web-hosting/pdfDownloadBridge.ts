export const PDF_DOWNLOAD_INIT = 'map-hosted-pdf-init';
export const PDF_DOWNLOAD_REQUEST = 'map-hosted-pdf-download';
export const PDF_DOWNLOAD_STATUS = 'map-hosted-pdf-status';

export interface PdfDownloadContext {
  siteId: string;
  siteUrl: string;
  entryFile: string;
  nonce: string;
  pdfFilePaths: string[];
}

export interface PdfDownloadRequest {
  type: typeof PDF_DOWNLOAD_REQUEST;
  siteId: string;
  nonce: string;
  filePath: string;
  requestId: string;
}

/** 不透明源的 origin 为 null，只认当前 iframe、当前站点上下文和服务端登记的精确路径。 */
export function acceptPdfDownloadRequest(data: unknown, source: MessageEventSource | null,
  frame: Window | null | undefined, context: PdfDownloadContext): data is PdfDownloadRequest {
  if (!frame || source !== frame || !data || typeof data !== 'object') return false;
  const request = data as Partial<PdfDownloadRequest>;
  return request.type === PDF_DOWNLOAD_REQUEST && request.siteId === context.siteId
    && request.nonce === context.nonce && typeof request.filePath === 'string'
    && context.pdfFilePaths.includes(request.filePath)
    && typeof request.requestId === 'string' && request.requestId.length > 0 && request.requestId.length <= 80;
}

export function pdfDownloadUrlMap(context: PdfDownloadContext): Record<string, string> {
  if (!context.siteUrl || context.pdfFilePaths.length === 0) return {};
  const parents = context.entryFile.split('/').length - 1;
  const root = new URL(parents ? '../'.repeat(parents) : '.', context.siteUrl);
  return Object.fromEntries(context.pdfFilePaths.map(path => [new URL(path, root).href, path]));
}

/** 只注入首屏 srcDoc。后续跨域 HTML 可主动采用同一有限协议，不赋予它父站同源能力。 */
export function withPdfDownloadBridge(html: string, context: PdfDownloadContext): string {
  if (!html || !context.siteId) return html;
  const config = JSON.stringify({ ...context, urls: pdfDownloadUrlMap(context) })
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `${html}<script data-map-pdf-download-bridge>(function(){
var context=${config};
document.addEventListener('click',function(event){
  if(!event.isTrusted || event.defaultPrevented || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  var link=event.target instanceof Element ? event.target.closest('a[href]') : null;
  if(!link) return;
  var url; try{url=new URL(link.href);url.search='';url.hash='';}catch(error){return;}
  var path=context.urls[url.href];
  if(!path){
    if(!/\\.pdf$/i.test(url.pathname)) return;
    event.preventDefault();
    var note=document.getElementById('map-pdf-download-error');
    if(!note){note=document.createElement('div');note.id='map-pdf-download-error';note.setAttribute('role','alert');
      link.insertAdjacentElement('afterend',note);}
    note.textContent='这份 PDF 未登记到当前网页，请联系分享者重新上传。';return;
  }
  event.preventDefault();
  window.parent.postMessage({type:'${PDF_DOWNLOAD_REQUEST}',siteId:context.siteId,nonce:context.nonce,
    filePath:path,requestId:crypto.randomUUID()},'*');
},true);
})();</script>`;
}
