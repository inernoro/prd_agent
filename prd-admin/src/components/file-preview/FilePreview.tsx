import { useEffect, useState } from 'react';
import { Check, CloudUpload, FileText, Clock3, RefreshCw } from 'lucide-react';
import { getFileTypeConfig } from '@/lib/fileTypeRegistry';
import type { FilePreviewKind } from '@/lib/fileTypeRegistry';
import { AudioWavePlayer } from '@/components/doc-browser/AudioWavePlayer';
import { TranscriptKaraoke } from '@/components/doc-browser/TranscriptKaraoke';
import type { DocBrowserEntry, EntryPreview } from '@/components/doc-browser/DocBrowser';
import { extractTranscriptSummary } from '@/components/doc-browser/transcriptSegments';
import { MarkdownViewer } from './MarkdownViewer';
import { listTranscribeStyles, retryRecordingArchive } from '@/services';
import { toast } from '@/lib/toast';
import { MapSpinner } from '@/components/ui/VideoLoader';

// ── 文件预览组件（按 fileTypeRegistry.preview 字段路由到不同渲染器） ──

function formatBackgroundDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

const RECORDING_ARCHIVE_STALE_MS = 10 * 60 * 1000;

export function isStaleRecordingArchive(startedAt?: string, now = Date.now()): boolean {
  if (!startedAt) return false;
  const startedMs = new Date(startedAt).getTime();
  return Number.isFinite(startedMs) && now - startedMs >= RECORDING_ARCHIVE_STALE_MS;
}

function RecordingArchiveProgress({
  hasPlayback,
  hasTranscript,
  startedAt,
    waitingForRetry,
  entryId,
}: {
  hasPlayback: boolean;
  hasTranscript: boolean;
  startedAt?: string;
  waitingForRetry: boolean;
  entryId: string;
}) {
  const startedMs = startedAt ? new Date(startedAt).getTime() : Date.now();
  const [elapsed, setElapsed] = useState(() => (
    Number.isFinite(startedMs) ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000)) : 0
  ));
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const stages = [
    { label: '录音已保存', state: 'done' as const, icon: Check },
    waitingForRetry
      ? { label: '等待自动重试', state: 'waiting' as const, icon: Clock3 }
      : { label: '保存云端副本', state: 'active' as const, icon: CloudUpload },
    { label: '本页自动更新', state: 'pending' as const, icon: FileText },
  ];

  return (
    <section
      data-testid="recording-background-progress"
      aria-live="polite"
      className="w-full max-w-[760px] rounded-[14px] p-4"
      style={{
        background: 'var(--semantic-info-soft)',
        border: '1px solid var(--semantic-info-border)',
        color: 'var(--text-secondary)',
      }}>
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]"
          style={{ background: 'rgba(59,130,246,0.12)', color: 'rgba(96,165,250,0.98)' }}>
          <CloudUpload size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-token-primary">
            {waitingForRetry ? '云端服务暂时不可用，已排队重试' : '正在保存云端副本'}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-token-secondary">
            {waitingForRetry
              ? '录音和原文已经可用，不需要停在本页等待。系统会在后台自动重试云端副本。'
              : '后台只负责保存正式音频并确认原文可恢复，不会自动总结或改写。'}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-token-muted">
            {hasPlayback
              ? hasTranscript
                ? '现在可以播放、编辑原文，并使用按语速估算的逐句跟随。完成后本页会自动切换正式音频。'
                : '现在可以播放本机录音。云端副本完成后，本页会自动补齐原文。'
              : '录音已经安全保存。云端副本完成后，本页会自动出现正式音频和原文。'}
          </p>
        </div>
      </div>

      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full"
        role="progressbar"
        aria-label="保存云端副本"
        aria-valuetext={waitingForRetry
          ? `等待云端服务恢复，已等待 ${formatBackgroundDuration(elapsed)}`
          : `已后台处理 ${formatBackgroundDuration(elapsed)}`}
        style={{ background: 'rgba(59,130,246,0.10)' }}>
        <span
          className={`block h-full w-2/5 rounded-full ${waitingForRetry ? '' : 'animate-pulse motion-reduce:animate-none'}`}
          style={{ background: 'linear-gradient(90deg, rgba(59,130,246,0.45), rgba(129,140,248,0.95))' }}
        />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2" aria-label="云端副本处理阶段">
        {stages.map(({ label, state, icon: Icon }) => (
          <div key={label} className="flex min-w-0 flex-col items-center text-center">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-full"
              style={{
                background: state === 'done' ? 'rgba(34,197,94,0.14)' : 'var(--bg-elevated)',
                color: state === 'done'
                  ? 'rgba(74,222,128,0.95)'
                  : state === 'active'
                    ? 'rgba(96,165,250,0.98)'
                    : 'var(--text-muted)',
                border: '1px solid var(--border-faint)',
              }}>
              {state === 'active'
                ? <MapSpinner size={13} color="rgba(96,165,250,0.98)" />
                : <Icon size={13} />}
            </span>
            <span className="mt-1.5 text-[10px] leading-4 text-token-muted">{label}</span>
          </div>
        ))}
      </div>

      <p className="mt-3 text-center text-[10px] tabular-nums text-token-muted">
        {waitingForRetry ? '可以离开本页，恢复后会自动更新' : '完成后本页自动更新，可以离开本页'}
        {' · '}{waitingForRetry ? '已等待' : '已处理'} {formatBackgroundDuration(elapsed)}
      </p>
      {waitingForRetry && (
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            void retryRecordingArchive(entryId)
              .then((result) => {
                if (!result.success) {
                  toast.error('重试未启动', result.error?.message);
                  return;
                }
                toast.success(result.data.completed ? '云端副本已完成' : '已立即重新尝试保存云端副本');
              })
              .finally(() => setRetrying(false));
          }}
          className="mx-auto mt-3 flex min-h-11 items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold disabled:opacity-50"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)', color: 'var(--text-primary)' }}>
          <RefreshCw size={13} className={retrying ? 'animate-spin motion-reduce:animate-none' : ''} />
          {retrying ? '正在唤醒后台任务' : '立即重试'}
        </button>
      )}
    </section>
  );
}

/**
 * 给 srcDoc 渲染的 HTML 正文注入移动端响应式能力：
 * - 缺 <meta viewport> 时补一条 width=device-width（核心：让移动端按真机宽度排版而非 980px 桌面视口）
 * - 注入流式兜底 CSS（img/table/pre 等 max-width:100%），把固定像素宽内容收进屏宽
 * 已含 viewport 的报告原样返回，不重复注入。纯静态注入，不改变报告语义。
 */
function ensureResponsiveHtml(html: string): string {
  if (!html) return html;
  if (/<meta[^>]+name=["']viewport["']/i.test(html)) return html;
  const inject =
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>html,body{margin:0}*{box-sizing:border-box}' +
    'img,video,table,pre,canvas,svg,iframe{max-width:100%!important;height:auto}' +
    'body{padding:12px;-webkit-text-size-adjust:100%;overflow-wrap:break-word;word-break:break-word}</style>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + inject);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + inject + '</head>');
  return `<!DOCTYPE html><html><head>${inject}</head><body>${html}</body></html>`;
}

export function FilePreview({ entry, preview, transcriptNoteMd, onSaveTranscriptNote, onAskRecording }: {
  entry?: DocBrowserEntry;
  preview: EntryPreview | null;
  /** 音频条目：已生成的转录笔记 markdown（有则渲染歌词滚轮跟读播放器） */
  transcriptNoteMd?: string | null;
  /** 保存用户在原文句子上的直接校对。 */
  onSaveTranscriptNote?: (nextNoteMd: string) => Promise<boolean | void>;
  /** 打开知识库智能体，并以当前录音原文作为上下文。 */
  onAskRecording?: () => void;
}) {
  if (!entry) {
    return (
      <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        请选择文件
      </div>
    );
  }
  if (entry.isFolder) {
    return (
      <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        请选择文件夹中的文件查看内容
      </div>
    );
  }

  const cfg = getFileTypeConfig(entry.title, entry.contentType);
  const kind: FilePreviewKind = cfg.preview;
  const fileUrl = preview?.fileUrl ?? null;
  const text = preview?.text ?? null;
  // MIME 是服务端对实际媒体内容的权威判断。录音产出的 .webm 扩展名也可用于
  // 视频，不能在检查 audio/* 之前按扩展名提前渲染成黑色视频框。
  const isAudioEntry = (entry.contentType ?? '').toLowerCase().startsWith('audio/');

  // 图片预览
  if (kind === 'image' && fileUrl) {
    return (
      <div className="flex items-center justify-center py-4 w-full">
        <img
          src={fileUrl}
          alt={entry.title}
          className="max-w-full max-h-[80vh] rounded-lg border border-token-subtle"
          style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}
        />
      </div>
    );
  }

  // 视频预览
  if (kind === 'video' && fileUrl && !isAudioEntry) {
    return (
      <div className="flex items-center justify-center py-4 w-full">
        <video
          src={fileUrl}
          controls
          className="max-w-full max-h-[80vh] rounded-lg border border-token-subtle"

        />
      </div>
    );
  }

  // 音频预览 — 自定义波形播放器（wavesurfer.js）。
  // contentType audio/* 优先于扩展名路由：录音产出的 .webm 是音频（audio/webm），
  // 不能因扩展名被当成视频渲染成黑盒播放器（2026-07-13 用户截图反馈）。
  const isAudio = kind === 'audio' || isAudioEntry;
  const liveTranscript = entry.metadata?.liveTranscript?.trim() || null;
  const effectiveTranscript = transcriptNoteMd?.trim() || liveTranscript;
  const archivePending = entry.metadata?.audioArchiveStatus === 'pending';
  const archiveWaitingForRetry = entry.metadata?.audioArchiveNeedsRetry === 'true'
    || isStaleRecordingArchive(entry.createdAt);
  if (isAudio && fileUrl) {
    // 不再放大图标 + 文件名块（标题已在阅读区头部/列表里，重复且占屏，2026-07-13 用户反馈）；
    // 主视觉直接是声纹播放器（+ 歌词滚轮）
    return (
      <div className={`flex min-h-full w-full flex-col items-center gap-5 ${effectiveTranscript ? 'justify-start py-2' : 'justify-center py-12'}`}>
        {archivePending && (
          <RecordingArchiveProgress
            hasPlayback
            hasTranscript={Boolean(effectiveTranscript)}
            startedAt={entry.createdAt}
            waitingForRetry={archiveWaitingForRetry}
            entryId={entry.id}
          />
        )}
        {/* 已有转录笔记 → 歌词滚轮跟读播放器（当前句居中高亮、点句跳播）；否则纯播放器 */}
        {effectiveTranscript ? (
          <AudioDocumentPreview
            src={fileUrl}
            noteMd={effectiveTranscript}
            styleKey={entry.metadata?.transcribe_style_key}
            onSaveNote={onSaveTranscriptNote}
            onAskRecording={onAskRecording}
          />
        ) : <AudioWavePlayer src={fileUrl} />}
      </div>
    );
  }

  // 对象存储暂不可用时，服务端会先创建待归档音频条目。此时不能把它渲染成
  // “暂无内容”：有实时原文就先展示原文，没有则明确说明后台状态。播放器会在
  // 本机保险音频或云端地址任一可用后自动出现。
  if (isAudio && archivePending) {
    return (
      <div className="mx-auto flex h-full w-full max-w-[760px] flex-col gap-4 py-4">
        <RecordingArchiveProgress
          hasPlayback={false}
          hasTranscript={Boolean(liveTranscript)}
          startedAt={entry.createdAt}
          waitingForRetry={archiveWaitingForRetry}
          entryId={entry.id}
        />
        {liveTranscript ? (
          <section
            className="rounded-[14px] p-4"
            style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)' }}>
            <p className="mb-3 text-[12px] font-semibold text-token-secondary">实时原文</p>
            <MarkdownViewer content={liveTranscript} />
          </section>
        ) : (
          <p className="text-center text-[12px] text-token-muted">正在等待完整音频生成原文</p>
        )}
      </div>
    );
  }

  // PDF 预览（iframe 嵌入，浏览器原生支持）
  if (kind === 'pdf' && fileUrl) {
    return (
      <iframe
        src={fileUrl}
        title={entry.title}
        className="w-full rounded-lg border border-token-subtle"
        style={{ height: '100%', minHeight: 420 }}
      />
    );
  }

  // HTML 预览：sandbox iframe 真渲染（禁脚本/表单/同源，仅静态 HTML+CSS，防 XSS）。
  // 上传的 .html 文件走 fileUrl；导入/手写的 HTML 正文（存于 document content）走 srcDoc，
  // 两者都渲染成页面而非源码（编辑态仍可改源码）。registry kind 之外再兜底按 contentType/扩展名识别。
  const isHtmlFile = kind === 'html'
    || (entry.contentType ?? '').toLowerCase().includes('html') || /\.html?$/i.test(entry.title);
  if (isHtmlFile && (fileUrl || text)) {
    // 移动端"报告很小"根因：HTML 报告缺 <meta viewport> 时，移动端 WebKit 按 980px 桌面
    // 视口排版再缩放进窄 iframe → 整页看起来很小。srcDoc 正文可注入 viewport + 流式 CSS
    // 让其按设备宽度重排（fileUrl 上传文件无法注入，由生成端补 viewport 兜底）。
    const srcDocHtml = !fileUrl ? ensureResponsiveHtml(text ?? '') : null;
    return (
      <iframe
        {...(fileUrl ? { src: fileUrl } : { srcDoc: srcDocHtml ?? '' })}
        title={entry.title}
        // srcDoc（导入/手写 HTML，与父同源可量高）：用 allow-same-origin（仍未给 allow-scripts，
        // 脚本不执行、无 XSS），onLoad 量内容高度让 iframe 自增高、自身不再内部滚动 → 只剩外层
        // 阅读区一条滚动条（修复「白底 iframe + 暗底外层」双滚动条）。
        // 正文里的链接不放宽 sandbox，改由父页拦截点击后 window.open（见下方 onLoad）：
        // 既不用给 allow-popups(-to-escape-sandbox) 扩权，又能覆盖所有存量 HTML 条目
        // （包括没写 target=_blank 的旧正文）。
        // fileUrl（上传 .html，跨源不可量高）：保持最严 sandbox="" + 100% 高，行为不变。
        sandbox={fileUrl ? '' : 'allow-same-origin'}
        // srcDoc 必须 scrolling="no"：自增高偶有 1px 量差时 iframe 会变成"可滚几个像素"，
        // 滚轮手势悬在其上会被 iframe 吃掉并 latch（滚一下卡住、停顿后才轮到外层）——
        // 用户实测手感"像非牛顿流体"。内部滚动一律禁死，滚轮永远直达外层阅读区。
        scrolling={fileUrl ? undefined : 'no'}
        onLoad={fileUrl ? undefined : (e) => {
          try {
            const ifr = e.currentTarget as HTMLIFrameElement & {
              __roFit?: ResizeObserver; __fitH?: number; __fitN?: number;
            };
            const d = ifr.contentDocument;
            if (!d || !d.documentElement) return;
            // 失控熔断：正常内容量高会在几帧内收敛（±2px 阈值兜住抖动）。若**连续**写高
            // 迟迟不收敛，说明内容高度反过来依赖 iframe 高度（如 100vh 布局）形成正反馈——
            // 此时必须停手，否则 RO 每帧触发，主线程被打满、整页卡死。
            // 宁可高度量得不完美，不可锁死页面。
            ifr.__fitN = 0;
            const fit = () => {
              const h = Math.max(d.documentElement?.scrollHeight || 0, d.body?.scrollHeight || 0);
              if (h <= 0) return;
              // +2px 缓冲吃掉小数像素舍入；±2px 阈值防振荡——否则"外层滚动条出现/消失
              // → 内容重排 → 高度再变 → RO 再触发"会形成往复写高，滚动锚定跟着来回
              // 调 scrollTop，与用户手势打架（"某个东西牵动某个东西"的阻滞感）。
              const target = Math.ceil(h) + 2;
              if (ifr.__fitH !== undefined && Math.abs(target - ifr.__fitH) <= 2) {
                // 收敛：这次量到的高度和已写入的一致，说明内容不再反过来推高度。
                // 熔断计数在这里清零——它数的是「连续未收敛的写高」，不是频率。
                ifr.__fitN = 0;
                return;
              }
              // 熔断只数**真正写高**的次数，不数 fit() 调用次数：图多的文档 1 秒内
              // 几十张图 load 完会各触发一次 fit，但那是收敛过程、不是反馈循环，
              // 按调用数熔断会把它们误伤成「量高中途断开 + 内容被永久截断」
              // （scrolling="no" 之下用户还滚不到）。写高才计数，且熔断前必定
              // 先把这一次量到的高度写进去，不留半截。
              //
              // 计数**不按时间窗清零**：按「1 秒内超 N 次」判定会留一条低速逃逸路径——
              // 页面被正反馈拖到 40fps 以下时每秒不足 41 次写高，计数每秒清零，
              // 循环可以永远跑下去，熔断形同虚设。改为按「连续未收敛」计数：
              // 正常内容每次写高后 RO 会再触发一次，那一次必然命中上面的收敛分支并清零；
              // 只有真正的正反馈才会一直写不收敛。这样与帧率无关，慢速循环照样兜住。
              ifr.__fitH = target;
              ifr.style.height = target + 'px';
              if ((ifr.__fitN = (ifr.__fitN || 0) + 1) > 60) {
                ifr.__roFit?.disconnect();
                ifr.__roFit = undefined;
              }
            };
            fit();
            // 关键：内容会在 onLoad 之后继续变高（base64 图片/字体异步加载、响应式重排），
            // 一次量高必偏矮 → 内层又冒出滚动条（用户实测"随机出现两个滚动条"）。
            // allow-same-origin 下父窗口可直接观察 iframe 文档，用 ResizeObserver 持续把 iframe
            // 高度跟内容同步 → iframe 永不内部滚动，只剩外层一条（用户要的"固定外面那条"）。
            ifr.__roFit?.disconnect();
            if (typeof ResizeObserver !== 'undefined') {
              const ro = new ResizeObserver(() => fit());
              ro.observe(d.documentElement);
              if (d.body) ro.observe(d.body);
              ifr.__roFit = ro;
            }
            // 兜底：图片自然尺寸到来后再量一次（个别浏览器 RO 不覆盖 img load）。
            d.querySelectorAll?.('img').forEach((img) => {
              const im = img as HTMLImageElement;
              if (!im.complete) im.addEventListener('load', fit, { once: true });
            });

            // 正文链接一律新标签打开，绝不在本 iframe 内导航。
            // 2026-07-29 事故：周报正文的日报深链没写 target，点击后这个自增高 iframe 直接
            // 导航到整个 MAP SPA；SPA 是 100vh 布局，内容高度反过来依赖 iframe 高度，与上面的
            // fit() 互相喂高，ResizeObserver 每帧触发，主线程被打满、整页卡死（控制台刷出
            // 210 条 "ResizeObserver loop completed"）。
            // 这里在父页（未被 sandbox 限制）拦截点击再 window.open：不必给 iframe 放
            // allow-popups/allow-popups-to-escape-sandbox 扩权，且对**存量**没写 target 的
            // 旧 HTML 条目同样生效。
            // 只拦「真的会把本 frame 导航走」的链接：http(s) 且非 download。
            // mailto: / tel: / 自定义协议交给浏览器原生处理（它们不导航本 frame），
            // download 链接保留原生下载语义——一律 preventDefault 会把这些链接变成哑巴。
            // 一律读 href **属性**再自己解析，不读 a.href：内联 SVG 里的 <a> 是
            // SVGAElement，其 .href 是 SVGAnimatedString 而不是字符串，拿去做正则会
            // 判失败 → 这类链接就漏出拦截、照样把 frame 导航走。读属性 + new URL()
            // 同时覆盖 HTML/SVG 锚点，也顺带把相对路径解析成绝对地址。
            // 覆盖所有「能导航本 frame」的锚点形态，不逐个补丁：
            //   a[href]（HTML / SVG2）、a[xlink:href]（SVG1.1 遗留）、area[href]（图像映射）
            // 表单提交不在其列——sandbox 未给 allow-forms，浏览器直接阻断；
            // <base> 与 <meta refresh> 由发布闸整标签禁用。
            const XLINK = 'http://www.w3.org/1999/xlink';
            // 协议判定必须是**白名单豁免**，不能是「非 http 就放行」：
            // data: / about: / blob: / javascript: / filesystem: 都会导航当前浏览上下文，
            // 「非 http 一律放行」等于把它们全放进来，照样能把 frame 导航走。
            // 只有交给外部处理器、不动本 frame 的协议才豁免。
            // 这里判「会不会导航本 frame」——该集合是**可枚举**的，所以按它判定，
            // 而不是反过来白名单列举外部协议：那样会把 vscode: / weixin: 这类已注册的
            // 自定义协议一并 preventDefault 又不 open，链接直接变哑巴（上一轮的回归）。
            // 未在此列的协议交由浏览器分派给系统处理器，本 frame 不动。
            // ws:/wss: 也在列：它们是 URL 标准里的 special scheme，点击会真的发起一次
            // 本 frame 导航（结果是错误文档），照样把 srcdoc 内容顶掉。发布闸那侧本来就
            // 要求它们带 target，两边判据必须一致，否则闸门放行的形态运行时反而漏拦。
            const SELF_NAVIGATING = new Set([
              'http:', 'https:', 'file:', 'ftp:', 'ws:', 'wss:',
              'data:', 'about:', 'blob:', 'filesystem:', 'javascript:', 'vbscript:',
            ]);
            d.addEventListener('click', (ev) => {
              const a = (ev.target as Element | null)?.closest?.('a, area');
              if (!a) return;
              // 必须区分「没有 href 属性」和「有 href 但是空串」：
              //   - 没有属性（<a name="x"> / <area> 占位）不是链接，放行；
              //   - href="" 是**空相对引用**，按 baseURI 解析。srcdoc 文档的 base URL
              //     继承自父页，所以它解析出的正是宿主 SPA 的地址，点一下就把 iframe
              //     导航过去 —— 正是本修复要防的那条路径。当成 no-op 放行等于留了个后门。
              // SVG2 起 href 优先于 xlink:href，两者都在时取 href（与浏览器一致）。
              const rawAttr = a.getAttribute('href')
                ?? a.getAttributeNS(XLINK, 'href')
                ?? a.getAttribute('xlink:href');
              if (rawAttr === null) return;                                 // 无导航属性，不是链接
              const raw = rawAttr.trim();
              if (raw.startsWith('#')) return;                              // 页内锚点
              let url: URL;
              try { url = new URL(raw, d.baseURI); } catch { return; }
              if (!SELF_NAVIGATING.has(url.protocol)) return;               // 交给系统处理器（含 vscode:/weixin: 等）
              // download 不能无条件放行：浏览器对**跨源** http(s) 会忽略 download，
              // 按普通导航处理——那正好是要拦的情形。只有同源才真的走原生下载。
              if (a.hasAttribute('download')) {
                let baseOrigin = '';
                try { baseOrigin = new URL(d.baseURI).origin; } catch { /* 取不到就按跨源处理 */ }
                if (baseOrigin && url.origin === baseOrigin) return;        // 同源，原生下载
              }
              ev.preventDefault();                                          // 会导航本 frame 的，一律拦
              // 只有 http(s) 值得开新标签；data:/javascript:/about: 等拦掉即止，
              // 在新标签里打开它们本身就是风险面。
              if (url.protocol === 'http:' || url.protocol === 'https:') {
                window.open(url.href, '_blank', 'noopener,noreferrer');
              }
            });
          } catch { /* 跨源不可量，保持默认高度 */ }
        }}
        className="w-full rounded-lg border border-token-subtle"
        // overflowAnchor none：把 iframe 从外层滚动器的 scroll anchoring 候选里摘出去，
        // 自增高过程中浏览器不再为"补偿高度变化"回调 scrollTop（滚动阻滞感的另一半根因）。
        style={{ height: fileUrl ? '100%' : 'auto', minHeight: 480, background: '#fff', overflowAnchor: 'none' }}
      />
    );
  }

  // 文本预览（Markdown / 提取后的 Office 文本 / 代码）
  if ((kind === 'text' || kind === 'html') && text) {
    return <MarkdownViewer content={text} />;
  }

  // 引用类条目（如"转存自网页托管"）：本地没有 attachment / document content，
  // 但 metadata 里带了公开 sourceUrl —— 直接 iframe 嵌入该公开链接作预览
  const referenceUrl = entry.metadata?.sourceUrl;
  if (!fileUrl && !text && referenceUrl) {
    return (
      <div className="flex h-full w-full flex-col">
        <div className="mb-2 flex items-center justify-between gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <span className="truncate">引用自：{referenceUrl}</span>
          <a
            href={referenceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-6 items-center gap-1 rounded-[6px] px-2 text-[11px] transition-colors hover-bg-soft"
            style={{ color: 'var(--accent-primary)' }}
          >
            新窗口打开
          </a>
        </div>
        <iframe
          src={referenceUrl}
          title={entry.title}
          className="w-full rounded-lg border border-token-subtle"
          style={{ height: 'calc(100vh - 240px)' }}
        />
      </div>
    );
  }

  // 兜底：有 fileUrl 但无可用预览方式 → 显示下载链接
  if (fileUrl) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <cfg.icon size={48} style={{ color: cfg.color }} />
        <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{entry.title}</p>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{cfg.label} 文件不支持在线预览</p>
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={entry.title}
          className="h-8 px-4 rounded-[8px] text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
          style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: 'rgba(59,130,246,0.9)' }}
        >
          下载文件
        </a>
      </div>
    );
  }

  // GitHub 目录订阅父条目：本身无正文（它是一个目录容器，正文在它同步下来的各文件里）。
  // 历史上它被建成"无内容的可点击叶子"，点开就空白 ——这里给一张目录卡片，
  // 展示仓库/路径/分支 + 跳转 GitHub，避免"打不开"。
  const md = entry.metadata ?? {};
  const isGithubDir = entry.sourceType === 'github_directory' || entry.contentType === 'application/x-github-directory';
  if (isGithubDir) {
    const owner = md.github_owner;
    const repo = md.github_repo;
    const path = md.github_path;
    const branch = md.github_branch || 'main';
    const ghUrl = owner && repo
      ? `https://github.com/${owner}/${repo}/tree/${branch}/${path ?? ''}`.replace(/\/$/, '')
      : (md.sourceUrl || entry.metadata?.sourceUrl);
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
        <cfg.icon size={44} style={{ color: cfg.color }} />
        <p className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{entry.title}</p>
        <p className="text-[12px] max-w-[420px]" style={{ color: 'var(--text-muted)' }}>
          这是一个 GitHub 目录订阅。它本身不含正文——同步下来的文件已作为独立文档收录在本知识库中，可在左侧目录里查看。
        </p>
        {(owner && repo) && (
          <div className="text-[11px] font-mono px-3 py-2 rounded-[8px] bg-token-nested"
            style={{ color: 'var(--text-secondary)', border: '1px solid var(--border-faint)' }}>
            {owner}/{repo} · {path || '/'} · {branch}
          </div>
        )}
        {ghUrl && (
          <a href={ghUrl} target="_blank" rel="noopener noreferrer"
            className="h-8 px-4 rounded-[8px] text-[12px] font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
            style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', color: 'rgba(59,130,246,0.9)' }}>
            在 GitHub 打开
          </a>
        )}
      </div>
    );
  }

  // 完全无内容
  return (
    <div className="text-center py-12 text-[12px]" style={{ color: 'var(--text-muted)' }}>
      暂无可预览的内容
    </div>
  );
}

function AudioDocumentPreview({ src, noteMd, styleKey, onSaveNote, onAskRecording }: {
  src: string;
  noteMd: string;
  styleKey?: string;
  onSaveNote?: (nextNoteMd: string) => Promise<boolean | void>;
  onAskRecording?: () => void;
}) {
  const summary = extractTranscriptSummary(noteMd);
  const [tab, setTab] = useState<'raw' | 'organized'>('raw');
  const [styleLabel, setStyleLabel] = useState('整理结果');

  useEffect(() => {
    if (!styleKey) return;
    void listTranscribeStyles().then((res) => {
      if (!res.success) return;
      setStyleLabel(res.data.items.find(item => item.key === styleKey)?.label || '整理结果');
    });
  }, [styleKey]);

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {summary && (
      <div className="flex min-h-11 w-full max-w-[760px] items-center gap-1 rounded-[11px] p-1" style={{ background: 'var(--bg-nested)' }}>
        <button
          type="button"
          onClick={() => setTab('raw')}
          className="min-h-11 flex-1 rounded-[8px] px-3 text-[12px] font-semibold"
          style={tab === 'raw' ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)' } : { color: 'var(--text-muted)' }}>
          原文
        </button>
        <button
          type="button"
          onClick={() => setTab('organized')}
          className="min-h-11 flex-1 rounded-[8px] px-3 text-[12px] font-semibold"
          style={tab === 'organized' ? { background: 'var(--bg-elevated)', color: 'var(--text-primary)' } : { color: 'var(--text-muted)' }}>
          {styleLabel}
        </button>
      </div>
      )}
      {tab === 'organized' && summary ? (
        <>
          <AudioWavePlayer src={src} />
          <section className="w-full max-w-[760px] rounded-[14px] p-4" style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)' }}>
            <MarkdownViewer content={summary} />
          </section>
        </>
      ) : (
        <TranscriptKaraoke
          src={src}
          noteMd={noteMd}
          documentMode
          onSaveNote={onSaveNote}
          onAskRecording={onAskRecording}
        />
      )}
    </div>
  );
}

export default FilePreview;
