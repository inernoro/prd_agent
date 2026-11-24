import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChevronLeft, ChevronRight, ListMinus, MessageSquare, Moon, Plus, Sun, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { DesignComment, DesignEntry, DesignRun, DesignScreen, DesignTheme, DesignVersion } from '../../../../src/shared/design-workspace';
import type { DesignWorkspace } from '../../../../src/shared/design-workspace';
import previewContract from '../../../../src/shared/design-preview-contract.json';
import { designAcceptanceTarget, designViewports } from '../../../../src/shared/design-workspace';
import { designVisualKey } from '../../../../src/shared/design-visual';
import { usePlanningRead } from '../engineering-planning/planning-ui';
import { designArtifact, designDate, designDetailPath, type DesignCommand } from './design-ui';
import { compareDesignStructure } from './design-structure';

type CompareMode = 'side' | 'slide' | 'diff';
type Point = { x: number; y: number };
type LayoutBox = Point & { id: string; stamp: number; width: number; height: number };
type LayoutChange = LayoutBox & { tone: 'added' | 'removed' | 'changed' };
const standalonePrototype: DesignScreen = { id: 'standalone', name: '独立原型', route: '#', viewport: 'desktop', themes: ['light', 'dark'], impl: null };

function boxChanges(before: LayoutBox[], after: LayoutBox[]) {
  const left = new Map(before.map(box => [box.id, box]));
  const right = new Map(after.map(box => [box.id, box]));
  const changed = (l: LayoutBox, r: LayoutBox) => l.stamp !== r.stamp ||
    Math.abs(l.x - r.x) + Math.abs(l.y - r.y) + Math.abs(l.width - r.width) + Math.abs(l.height - r.height) > .004;
  return {
    left: before.flatMap((box): LayoutChange[] => {
      const next = right.get(box.id);
      return !next ? [{ ...box, tone: 'removed' }] : changed(box, next) ? [{ ...box, tone: 'changed' }] : [];
    }),
    right: after.flatMap((box): LayoutChange[] => {
      const prior = left.get(box.id);
      return !prior ? [{ ...box, tone: 'added' }] : changed(prior, box) ? [{ ...box, tone: 'changed' }] : [];
    }),
  };
}

function regionCoverage(changes: LayoutChange[]) {
  const bins = new Set<number>(), precision = 50;
  for (const box of changes) {
    for (let x = Math.floor(box.x * precision); x < Math.ceil((box.x + box.width) * precision); x++) {
      for (let y = Math.floor(box.y * precision); y < Math.ceil((box.y + box.height) * precision); y++) bins.add(x * precision + y);
    }
  }
  return Math.min(100, Math.round(bins.size / (precision * precision) * 100));
}

async function pixelDifference(before: string, after: string) {
  async function load(src: string) {
    const image = new Image();
    image.src = src;
    await image.decode();
    return image;
  }
  const [left, right] = await Promise.all([load(before), load(after)]);
  const { naturalWidth: width, naturalHeight: height } = right;
  if (left.naturalWidth !== width || left.naturalHeight !== height) throw new Error('Screenshot size differs');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Pixel comparison unavailable');
  context.drawImage(left, 0, 0);
  const base = context.getImageData(0, 0, width, height).data;
  context.clearRect(0, 0, width, height);
  context.drawImage(right, 0, 0);
  const next = context.getImageData(0, 0, width, height).data;
  const tileSize = 32, columns = Math.ceil(width / tileSize);
  const tiles = new Set<number>();
  let count = 0;
  for (let offset = 0; offset < next.length; offset += 4) {
    if (base[offset] === next[offset] && base[offset + 1] === next[offset + 1]
      && base[offset + 2] === next[offset + 2] && base[offset + 3] === next[offset + 3]) continue;
    const index = offset / 4;
    const column = Math.floor((index % width) / tileSize);
    const row = Math.floor(index / width / tileSize);
    tiles.add(row * columns + column);
    count++;
  }
  const boxes: LayoutChange[] = [...tiles].map(index => {
    const x = (index % columns) * tileSize, y = Math.floor(index / columns) * tileSize;
    return { id: String(index), stamp: 0, tone: 'changed', x: x / width, y: y / height,
      width: Math.min(tileSize, width - x) / width, height: Math.min(tileSize, height - y) / height };
  });
  return { boxes, area: count / (width * height) * 100 };
}

type FrameProps = {
  projectId: string; version?: DesignVersion; screen?: DesignScreen; theme: DesignTheme; zoom: number | null;
  comments?: DesignComment[]; pin?: Point; placing?: boolean; onPin?: (point: Point) => void;
  onComment?: (id: string) => void; onScrollFrom?: (data: { left: number; top: number }) => void;
  scroll?: { left: number; top: number }; onKey?: (key: string) => void;
  onLayout?: (boxes: LayoutBox[]) => void; boxes?: LayoutChange[]; screenshot?: string; decorative?: boolean;
  staticOnly?: boolean; referenceId?: string;
};

type PreviewReport = { runtime: number; blocked: number; console: number; directives: string[] };
const entryFailures = {
  'control-unavailable': '找不到设定的入口控件',
  'readiness-timeout': '等待画面就绪超时',
  'prototype-error': '原型脚本出错',
  'no-response': '原型未返回就绪信息',
  'frame-denied': '安全策略无法打开内嵌原型',
} as const;
const previewCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99 ? value : 0;
function previewReport(value: Partial<PreviewReport> | undefined): PreviewReport {
  return { runtime: previewCount(value?.runtime), blocked: previewCount(value?.blocked), console: previewCount(value?.console),
    directives: Array.isArray(value?.directives) ? value.directives.slice(0, 6).filter(key => typeof key === 'string' && /^[a-z-]{1,24}$/.test(key)) : [] };
}

export function DesignFrame({ projectId, version, screen: scene, theme, zoom, comments, pin, placing, onPin, onComment, onScrollFrom, scroll, onKey, onLayout, boxes, screenshot, decorative, staticOnly, referenceId }: FrameProps) {
  const screen = scene ?? (version && !version.screens.length ? standalonePrototype : undefined);
  const outer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [preview, setPreview] = useState<{ requestId: string; identity: string; ready?: boolean; report?: PreviewReport; failure?: keyof typeof entryFailures }>();
  const pendingEntry = useRef<{ id: string; timeout: number }>();
  const [staticFor, setStaticFor] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const source = screen && version?.prototypeId
    ? `${designArtifact(projectId, version.prototypeId)}?theme=${theme}${screen.route.startsWith('#') ? screen.route : '#' + screen.route}`
    : null;
  const frameKey = source && source + '/' + screen?.id;
  const identity = frameKey && frameKey + '/' + attempt;
  const timeoutMs = screen?.entryTimeoutMs ?? previewContract.entryTimeoutMs;
  const fallback = (screen && version?.renders?.[screen.id]?.[theme]?.id) ?? referenceId;
  const check = preview?.identity === identity ? preview : undefined;
  const cannotFrame = fallback && check?.report?.directives.some(value => value === 'frame-src' || value === 'child-src');
  const failure = check?.failure ?? (cannotFrame ? 'frame-denied' : undefined);
  const inspectable = failure === 'prototype-error' || failure === 'control-unavailable' || failure === 'readiness-timeout';
  const inspecting = inspectable && staticFor === 'live:' + identity;
  const still = Boolean(staticOnly || decorative || screenshot || frameKey && staticFor === frameKey);
  const showFrame = Boolean(source && !still);
  const live = Boolean(showFrame && (check?.ready && !failure || inspecting));
  const displayed = screenshot ?? (!live && fallback ? designArtifact(projectId, fallback) : undefined);
  const retry = () => { setStaticFor(undefined); setAttempt(value => value + 1); };
  const errors = (check?.report?.runtime ?? 0) + (check?.report?.console ?? 0);
  const blocked = check?.report?.blocked ?? 0;
  const peers = screen && version?.screens.filter(row => row.route === screen.route && row.viewport === screen.viewport);
  const legacyLabel = peers && peers.length > 1 && peers[0].id !== screen?.id ? screen?.name : undefined;
  const needsEntry = Boolean(screen?.entryActions?.length || screen?.entryReadySelector || legacyLabel);
  const [space, setSpace] = useState({ width: 0, height: 0 });
  const { width, height } = designViewports[screen?.viewport ?? 'desktop'];
  const fit = space.width ? Math.min(1, space.width / width, space.height ? space.height / height : 1) : .5;
  const scale = zoom === null ? fit : zoom / 100;
  useEffect(() => {
    if (!outer.current) return;
    const box = outer.current;
    const observer = new ResizeObserver(entries => setSpace({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (data?.type === 'cds-design-scroll' && typeof data.left === 'number' && typeof data.top === 'number') {
        onScrollFrom?.({ left: data.left, top: data.top });
      }
      if (data?.type === 'cds-design-layout' && onLayout && Array.isArray(data.boxes) && data.boxes.length <= 350) {
        const sane = (number: unknown) => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 1.001;
        onLayout(data.boxes.filter((box: LayoutBox) => box && typeof box.id === 'string' && box.id.length <= 100
          && typeof box.stamp === 'number' && [box.x, box.y, box.width, box.height].every(sane)));
      }
      const request = pendingEntry.current;
      if (request && data?.type === 'cds-design-diagnostics') {
        setPreview(current => current?.requestId === request.id ? { ...current, report: previewReport(data.diagnostics) } : current);
      }
      if (request && data?.type === 'cds-design-entry-result' && data.requestId === request.id && typeof data.reached === 'boolean') {
        window.clearTimeout(request.timeout);
        const reason = typeof data.reason === 'string' && Object.hasOwn(entryFailures, data.reason) ? data.reason as keyof typeof entryFailures : 'readiness-timeout';
        setPreview(current => current?.requestId === request.id ? { ...current, ready: data.reached, report: previewReport(data.diagnostics),
          failure: data.reached ? undefined : reason } : current);
      }
      if (data?.type === 'cds-design-key' && ['ArrowLeft', 'ArrowRight', 'Escape', 'c', 'C'].includes(data.key)) onKey?.(data.key);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [onScrollFrom, onKey, onLayout]);
  useEffect(() => {
    if (scroll) frame.current?.contentWindow?.postMessage({ type: 'cds-design-scroll', ...scroll }, '*');
  }, [scroll]);
  useEffect(() => () => {
    if (pendingEntry.current) window.clearTimeout(pendingEntry.current.timeout);
    pendingEntry.current = undefined;
  }, [identity, showFrame]);
  useEffect(() => {
    if (!identity || !showFrame) return;
    const deadline = window.setTimeout(() => setPreview(current => current?.identity === identity ? current
      : { identity, requestId: '', failure: 'no-response' }), timeoutMs + 600);
    return () => window.clearTimeout(deadline);
  }, [identity, showFrame, timeoutMs]);
  const place = (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const keyboard = event.detail === 0;
    onPin?.({ x: keyboard ? .5 : (event.clientX - rect.left) / rect.width, y: keyboard ? .5 : (event.clientY - rect.top) / rect.height });
  };
  return <div className="dw-fit" ref={outer} aria-hidden={decorative || undefined}>
    {source ? <div className="dw-frame" data-preview-state={still ? 'screenshot' : failure ? 'failed' : live ? 'ready' : 'loading'}
      style={{ width: width * scale, height: height * scale, colorScheme: theme }}>
      {displayed && <img className="dw-frame-png" src={displayed} alt={screen!.name + ' · V' + version!.version} />}
      {showFrame && <iframe key={identity} ref={frame} title={screen!.name + ' · V' + version!.version} loading="eager" src={source}
          tabIndex={live ? undefined : -1} aria-hidden={!live || undefined} data-concealed={!live || undefined} hidden={Boolean(failure && !live)}
          onLoad={event => {
            if (pendingEntry.current) window.clearTimeout(pendingEntry.current.timeout);
            const id = String(performance.now());
            setPreview({ requestId: id, identity: identity! });
            pendingEntry.current = { id, timeout: window.setTimeout(() => {
              setPreview(current => current?.requestId === id ? { ...current, failure: 'no-response' } : current);
            }, timeoutMs + 600) };
            event.currentTarget.contentWindow?.postMessage({ type: 'cds-design-entry', requestId: id, timeoutMs,
              actions: screen!.entryActions, ready: screen!.entryReadySelector, legacyLabel }, '*');
          }}
          sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width, height, transform: `scale(${scale})`, colorScheme: theme }} />}
      {showFrame && !live && !failure && <div className="dw-frame-loading" role="status">
        <span>正在打开可以点的原型</span>
      </div>}
      {still && !displayed && <div className="dw-frame-loading"><span>这张画面还没有对照图</span></div>}
      {!decorative && !staticOnly && !screenshot && (failure || errors > 0 || blocked > 0 || still) && <div className="dw-entry-warning" role="status">
        {failure && <><span>{entryFailures[failure]}。</span>
          <button className="ep-text-button" type="button" data-action="prototype-retry" onClick={retry}>重试</button></>}
        {errors > 0 && <span>原型报错 {errors} 条。</span>}
        {blocked > 0 && <span>安全策略拦截 {blocked} 次{check?.report?.directives.length ? '（' + check.report.directives.join('、') + '）' : ''}。</span>}
        {displayed && <span>{screen && version?.renders?.[screen.id]?.[theme] ? '正在看交付包里的截图。' : '正在看画面截图。'}</span>}
        {fallback && (inspectable || still || !failure) && <button className="ep-text-button" type="button" onClick={() => {
          if (still) retry();
          else setStaticFor(inspectable ? (inspecting ? undefined : 'live:' + identity) : frameKey!);
        }}>{still || inspectable && !inspecting ? '看交互原型' : '看交付截图'}</button>}
        {needsEntry && failure === 'control-unavailable' && <span>请核对「{screen!.name}」的画面入口。</span>}
      </div>}
      {boxes?.map((box, index) => <span aria-hidden className="dw-difference-box" data-tone={box.tone} key={box.id + index}
        style={{ left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.width * 100 + '%', height: box.height * 100 + '%' }} />)}
      {comments?.map((comment, index) => <button type="button" className="dw-pin" key={comment.id}
        style={{ left: comment.x * 100 + '%', top: comment.y * 100 + '%' }} onClick={() => onComment?.(comment.id)}
        title={comment.body} aria-label={`查看评论 ${index + 1}`}>{index + 1}</button>)}
      {pin && <span className="dw-pin" style={{ left: pin.x * 100 + '%', top: pin.y * 100 + '%' }}>+</span>}
      {placing && <button type="button" className="dw-place" aria-label="在画面上放置评论" onClick={place} />}
    </div> : <div className="dw-frame-empty">该版本没有这张画面</div>}
  </div>;
}

function Segments<T extends string>({ options, value, onChange }: { options: readonly [T, string][]; value: T; onChange: (value: T) => void }) {
  return <div className="dw-segments">{options.map(([key, title]) =>
    <button key={key} type="button" aria-pressed={key === value} onClick={() => onChange(key)}>{title}</button>)}</div>;
}

export function CanvasSettings({ theme, onTheme, zoom, onZoom }: { theme: DesignTheme; onTheme: (theme: DesignTheme) => void;
  zoom: number | null; onZoom: (zoom: number | null) => void }) {
  const themeAction = theme === 'light' ? '切换为深色' : '切换为浅色';
  return <>
    <select className="dw-canvas-zoom" aria-label="缩放" value={zoom ?? ''} onChange={event => onZoom(Number(event.target.value) || null)}>
      <option value="">适应</option>{[25, 50, 75, 100, 125, 150].map(value => <option key={value} value={value}>{value}%</option>)}
    </select>
    <button type="button" className="ep-button ep-icon-button" aria-label={themeAction} title={themeAction}
      onClick={() => onTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Sun /> : <Moon />}</button>
  </>;
}

type CanvasProps = {
  entry: DesignEntry; version: DesignVersion; comparing: boolean; active: boolean; full?: boolean;
  command: DesignCommand; canComment: boolean; canWrite: boolean; actorId: string; steward: boolean;
  commandBusy: boolean; initialScreenId?: string; initialCommentId?: string; initialComparisonVersion?: number; selectedTheme?: DesignTheme; onThemeChange?: (theme: DesignTheme) => void; onEscape?: () => void; onReview: (comment: DesignComment, version: DesignVersion) => void;
  cornerTools?: boolean;
  onSceneChange?: (screen?: DesignScreen) => void;
  onSelectScreen?: (screen: string) => void;
  onModeChange?: (compare: boolean, screen?: string, from?: number) => void;
};

export function DesignCanvas({ entry, version, comparing, active, full, command, canComment, canWrite, actorId, steward, commandBusy, initialScreenId, initialCommentId, initialComparisonVersion, selectedTheme, onThemeChange, onReview, onEscape, cornerTools, onSceneChange, onSelectScreen, onModeChange }: CanvasProps) {
  const [localTheme, setLocalTheme] = useState<DesignTheme>('light');
  const theme = selectedTheme ?? localTheme;
  const setTheme = onThemeChange ?? setLocalTheme;
  const [zoom, setZoom] = useState<number | null>(null);
  useEffect(() => {
    if (!cornerTools) return;
    const mobile = window.matchMedia('(max-width: 899px)');
    const fit = () => { if (mobile.matches) setZoom(null); };
    fit();
    mobile.addEventListener('change', fit);
    return () => mobile.removeEventListener('change', fit);
  }, [cornerTools]);
  const [selected, select] = useState(initialScreenId ?? version.demo?.[0]?.screen ?? version.screens[0]?.id);
  const pickScreen = (id: string) => { select(id); onSelectScreen?.(id); };
  const [left, setLeft] = useState(() => entry.versions.find(row => row.version === initialComparisonVersion && row.version !== version.version)?.version
    ?? (entry.frozen !== version.version ? entry.frozen : undefined)
    ?? entry.versions.find(row => row.version === version.version - 1)?.version ?? version.version);
  const [right, setRight] = useState<string>(String(version.version));
  const [implementationRun, setImplementationRun] = useState<string>();
  const [mode, setMode] = useState<CompareMode>('side');
  const [withCompare, setWithCompare] = useState(comparing);
  const [changes, showChanges] = useState(false);
  const [all, showAll] = useState(false);
  const allGallery = useRef<HTMLDivElement>(null);
  const [galleryZoom, setGalleryZoom] = useState(25);
  const [comments, showComments] = useState(Boolean(initialCommentId));
  const [currentComment, setComment] = useState(initialCommentId);
  const [placing, setPlacing] = useState(false);
  const [pin, setPin] = useState<Point>();
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [slider, setSlider] = useState(50);
  const [leftLayout, setLeftLayout] = useState<{ key: string; boxes: LayoutBox[] }>();
  const [rightLayout, setRightLayout] = useState<{ key: string; boxes: LayoutBox[] }>();
  const [pixels, setPixels] = useState<{ key: string; value?: Awaited<ReturnType<typeof pixelDifference>> }>();
  const [leftScroll, setLeftScroll] = useState<{ left: number; top: number }>();
  const [rightScroll, setRightScroll] = useState<{ left: number; top: number }>();
  const compare = full ? withCompare : comparing;
  const real = right === 'implementation';
  const leftIndex = entry.versions.find(row => row.version === left);
  const rightIndex = entry.versions.find(row => row.version === Number(right));
  const comparison = usePlanningRead<DesignWorkspace>(compare && leftIndex && !leftIndex.prototypeId
    ? designDetailPath(entry.projectId, entry.id, left) : null, 0);
  const alternate = usePlanningRead<DesignWorkspace>(compare && !real && rightIndex && !rightIndex.prototypeId
    ? designDetailPath(entry.projectId, entry.id, Number(right)) : null, 0);
  const leftVersion = comparison.data?.designs.find(row => row.id === entry.id)?.versions.find(row => row.version === left) ?? leftIndex;
  const rightVersion = alternate.data?.designs.find(row => row.id === entry.id)?.versions.find(row => row.version === Number(right)) ?? rightIndex;
  const matchingRuns = entry.runs.filter(row => row.version === version.version);
  const run = matchingRuns.find(item => item.id === implementationRun) ?? matchingRuns.at(-1);
  const screens = compare ? Array.from(new Map([...(leftVersion?.screens ?? []), ...(rightVersion?.screens ?? version.screens)]
    .map(screen => [screen.id, screen] as const)).values()) : version.screens;
  const index = Math.max(0, screens.findIndex(screen => screen.id === selected));
  const screen = screens[index];
  useEffect(() => { if (initialScreenId) select(initialScreenId); }, [initialScreenId]);
  useEffect(() => { onSceneChange?.(all && !compare ? undefined : screen); }, [screen, all, compare, onSceneChange]);
  const visibleTheme = screen?.themes.includes(theme) ? theme : screen?.themes[0] ?? theme;
  const marks = entry.comments.filter(comment => comment.version === version.version && comment.screenId === screen?.id);
  const earlierMarks = entry.comments.filter(comment => comment.version !== version.version
    && (!comment.closed || comment.screenId === screen?.id));
  const focused = marks.find(comment => comment.id === currentComment);
  useEffect(() => {
    if (!all || !allGallery.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setGalleryZoom(Math.max(10, Math.min(27, (width - 14) / designViewports.desktop.width * 100)));
    });
    observer.observe(allGallery.current);
    return () => observer.disconnect();
  }, [all]);
  const previous = (direction: number) => {
    const next = screens[index + direction];
    if (next) { pickScreen(next.id); setPin(undefined); setPlacing(false); setComment(undefined); }
  };
  const key = (value: string) => {
    if (!active) return;
    if (value === 'Escape') onEscape?.();
    if (value === 'ArrowLeft') previous(-1);
    if (value === 'ArrowRight') previous(1);
    if (value.toLowerCase() === 'c' && !compare && screen) showComments(open => !open);
  };
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable]'))) return;
      if (['ArrowLeft', 'ArrowRight', 'c', 'C'].includes(event.key)) {
        event.preventDefault();
        key(event.key);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const compareMode = real ? (mode === 'side' ? 'side' : 'slide') : mode;
  const [leftScreen, rightScreen] = [leftVersion, rightVersion].map(row => row?.screens.find(candidate => candidate.id === screen?.id));
  const recordedVisual = run && screen ? run.visual?.[designVisualKey(screen.id, `${screen.viewport}-${visibleTheme}`)] : undefined;
  const screenshotId = recordedVisual?.measured?.path === screen?.impl && recordedVisual?.measured?.theme === visibleTheme
    ? recordedVisual?.imageId : undefined;
  const capture = screenshotId ?? (run && screen ? realEvidence(run, version, screen, visibleTheme)?.imageId : undefined);
  const installed = run?.target === 'installed';
  const localImplementation = installed && screen?.impl && /^\/(?![\/\\])/.test(screen.impl) ? screen.impl : undefined;
  const structure = useMemo(() => compare && leftVersion && rightVersion ? compareDesignStructure(leftVersion, rightVersion) : [],
    [compare, leftVersion, rightVersion]);
  const reported = Object.entries(rightVersion?.resolves ?? {});
  const commentCount = entry.comments.filter(item => !item.closed).length;
  const useLeftScroll = (next: { left: number; top: number }) => {
    if (next.left !== leftScroll?.left || next.top !== leftScroll?.top) setRightScroll(next);
  };
  const useRightScroll = (next: { left: number; top: number }) => {
    if (next.left !== rightScroll?.left || next.top !== rightScroll?.top) setLeftScroll(next);
  };
  const layoutKey = `${left}/${right}/${screen?.id ?? ''}/${visibleTheme}`;
  const layoutReady = !real && leftLayout?.key === layoutKey && rightLayout?.key === layoutKey;
  const overlays = layoutReady ? boxChanges(leftLayout.boxes, rightLayout.boxes) : undefined;
  const leftImage = leftScreen && leftVersion?.renders?.[leftScreen.id]?.[visibleTheme];
  const rightImage = rightScreen && rightVersion?.renders?.[rightScreen.id]?.[visibleTheme];
  const leftInteractive = active && Boolean(leftScreen && (real || !rightScreen || rightImage && !leftImage));
  const rightInteractive = active && !leftInteractive && !real && !(leftImage && rightImage);
  const comparePixels = compare && compareMode === 'diff' && !real && leftScreen?.viewport === rightScreen?.viewport;
  const leftShot = comparePixels && leftImage && rightImage ? designArtifact(entry.projectId, leftImage.id) : undefined;
  const rightShot = comparePixels && leftImage && rightImage ? designArtifact(entry.projectId, rightImage.id) : undefined;
  const pixelKey = leftShot && rightShot ? `${leftShot}\n${rightShot}` : undefined;
  const readyPixels = pixels?.key === pixelKey ? pixels?.value : undefined;
  const changedOnScreen = readyPixels ? readyPixels.boxes.length
    : overlays ? new Set([...overlays.left, ...overlays.right].map(box => box.id)).size : undefined;
  useEffect(() => {
    if (!pixelKey || !leftShot || !rightShot) return;
    let current = true;
    void pixelDifference(leftShot, rightShot).then(
      value => { if (current) setPixels({ key: pixelKey, value }); },
      () => { if (current) setPixels({ key: pixelKey }); },
    );
    return () => { current = false; };
  }, [pixelKey, leftShot, rightShot]);
  const leftFrame = <DesignFrame projectId={entry.projectId} version={leftVersion} screen={leftScreen} theme={visibleTheme} zoom={zoom}
    staticOnly={!leftInteractive}
    scroll={leftScroll} onScrollFrom={useLeftScroll} onKey={key} onLayout={real ? undefined : boxes => setLeftLayout({ key: layoutKey, boxes })}
    boxes={compareMode === 'side' ? overlays?.left : undefined} />;
  const rightFrame = real ? <div className="dw-fit">
    {capture ? <img className="dw-real-shot" alt={screen!.name + '真实页面截图'} src={designArtifact(entry.projectId, capture)} />
      : <div className="dw-frame-empty"><b>真实页面</b><p>{screen?.impl ? (run ? '该提交和视口缺少截图' : '已绑定地址，等待真实页面取证') : '当前画面待绑定实现地址'}</p>
        {localImplementation && <Link className="ep-link dw-implementation-link" to={localImplementation}>打开主用实现</Link>}
        <Link className="ep-link" to={`/design?${new URLSearchParams({ project: entry.projectId, design: entry.id,
          version: String(version.version), tab: 'accept', ...(screen ? { screen: screen.id } : {}) })}`}>查看做法验收</Link></div>}
  </div> : <DesignFrame projectId={entry.projectId} version={rightVersion} screen={rightScreen} theme={visibleTheme} zoom={zoom}
    staticOnly={!rightInteractive}
    scroll={rightScroll} onScrollFrom={useRightScroll} onKey={key} onLayout={boxes => setRightLayout({ key: layoutKey, boxes })}
    screenshot={readyPixels ? rightShot : undefined} boxes={readyPixels?.boxes ?? (compareMode === 'slide' ? undefined : overlays?.right)} />;
  const tools = <div className="dw-tabrow dw-canvas-tools" aria-label="画布工具">
      <div className="dw-tools">
        {(onModeChange || full) && <Segments options={ [['single', '单版'], ['compare', '对比']] as const }
          value={compare ? 'compare' : 'single'} onChange={mode => {
            const next = mode === 'compare';
            if (next === compare) return;
            if (onModeChange) onModeChange(next, screen?.id);
            else setWithCompare(next);
          }} />}
        {compare ? <>
          {entry.frozen !== undefined && entry.frozen !== version.version
            && (left !== entry.frozen || Number(right) !== version.version) &&
            <button type="button" className="ep-button" onClick={() => {
              setLeft(entry.frozen!);
              setRight(String(version.version));
              onModeChange?.(true, screen?.id, entry.frozen);
            }}>和基线 V{entry.frozen} 对比</button>}
          <select aria-label="对比左侧版本" value={left} onChange={event => setLeft(Number(event.target.value))}>
            {entry.versions.map(row => <option key={row.version} value={row.version}>V{row.version}</option>)}
          </select>
          <span aria-hidden="true">→</span>
          <select aria-label="对比右侧版本" value={right} onChange={event => setRight(event.target.value)}>
            {entry.versions.map(row => <option key={row.version} value={row.version}>V{row.version}{entry.frozen === row.version ? ' · 定稿' : ''}</option>)}
            <option value="implementation">真实页面{run ? installed ? ' · 主用构建' : ` · PR #${run.pullRequest}` : ''}</option>
          </select>
          {real && matchingRuns.length > 1 && <select aria-label="真实页面的来源和提交" value={run?.id ?? ''}
            onChange={event => setImplementationRun(event.target.value)}>
            {matchingRuns.slice().reverse().map(item => <option key={item.id} value={item.id}>
              {item.target === 'installed' ? '主用构建' : `PR #${item.pullRequest}`} · {item.commit.slice(0, 8)}</option>)}
          </select>}
          <div className="dw-segments" aria-label="对比方式">
            <button type="button" aria-pressed={compareMode === 'side'} onClick={() => setMode('side')}>并排</button>
            <button type="button" aria-pressed={compareMode === 'slide'} onClick={() => setMode('slide')}>滑动</button>
            <button type="button" aria-pressed={compareMode === 'diff'} onClick={() => setMode('diff')} disabled={real}>差异</button>
          </div>
        </> : version.screens.length ? <Segments options={ [['one','单屏'], ['all',`全部 ${version.screens.length} 屏`]] as const } value={all ? 'all' : 'one'}
          onChange={value => { showAll(value === 'all'); setPlacing(false); setPin(undefined); }} /> : null}
        <CanvasSettings theme={theme} onTheme={setTheme} zoom={zoom} onZoom={setZoom} />
        {compare ? <button type="button" className="ep-button" aria-expanded={changes} onClick={() => showChanges(!changes)}><ListMinus />
          {real ? '变化详情' : changedOnScreen === undefined ? '本屏待测量' : `本屏 ${changedOnScreen} 处变化`}
          {!real && structure.length + reported.length > 0 && <small>声明 {structure.length + reported.length}</small>}</button>
          : <button type="button" className="ep-button dw-canvas-comments" disabled={!screen} aria-expanded={comments}
            aria-label={`评论 ${commentCount}`} title={`评论 ${commentCount}`} onClick={() => { showComments(!comments); setPlacing(false); }}>
            <MessageSquare /><span>评论 {commentCount}</span></button>}
      </div>
    </div>;

  return <>
    {!cornerTools && tools}
    <div className="dw-canvas" data-corner-tools={cornerTools || undefined} data-full={full} data-panel={compare ? changes : comments}>
      {cornerTools && <div className="dw-canvas-corner">{tools}</div>}
      {compare && compareMode === 'diff' && <p className="dw-canvas-note">
        {readyPixels ? `像素差异 ${readyPixels.area.toFixed(2)}% · ${readyPixels.boxes.length} 个标记区`
          : pixelKey && pixels?.key !== pixelKey ? '正在比对两版截图'
            : overlays ? `缺少同视口截图 · 结构变化 ${overlays.right.length} 处 · 约 ${regionCoverage(overlays.right)}% 画面`
              : '缺少同视口、同主题的截图。可以在「变化」查看结构和交付差异。'}
      </p>}
      {real && compare && <p className="dw-canvas-note">{installed ? '真实页面使用主用构建的实拍。' : '真实页面使用分支实拍。'}
        {localImplementation ? <> <Link className="ep-link" to={localImplementation}>打开主用实现</Link></> : '稿件与实现请按验收核对。'}</p>}
      {compare && !screens.length ? <div className="dw-frame-empty">两版都没有声明画面。可以在预览标签打开独立原型。</div>
        : compare ? <div className={`dw-compare dw-compare-${compareMode}`} data-viewport={screen?.viewport}>
        <figure aria-hidden={compareMode === 'diff'}><figcaption>V{left} <small>{leftVersion && designDate(leftVersion.createdAt)}</small></figcaption>{leftFrame}</figure>
        <figure style={compareMode === 'slide' ? { clipPath: `inset(0 0 0 ${slider}%)` } : undefined}>
          <figcaption>{real ? '真实页面' : `V${right}`} <small>{real ? run?.commit.slice(0, 8) : rightVersion && designDate(rightVersion.createdAt)}</small></figcaption>
          {rightFrame}</figure>
        {compareMode === 'slide' && <input aria-label="对比滑动分界" className="dw-slider" type="range" min={0} max={100} value={slider} onChange={event => setSlider(Number(event.target.value))} />}
      </div> : all ? <div className="dw-all-screens" ref={allGallery}>{version.screens.map((item, i) => {
        const sampling = zoom ?? galleryZoom;
        const viewport = designViewports[item.viewport];
        const color = item.themes.includes(theme) ? theme : item.themes[0];
        const referenceId = run?.visual?.[designVisualKey(item.id, `${item.viewport}-${color}`)]?.referenceImageId;
        return <figure key={item.id} style={{ width: viewport.width * sampling / 100 }}>
          <div style={{ height: viewport.height * sampling / 100 }}><DesignFrame projectId={entry.projectId} version={version} screen={item}
            theme={color} zoom={sampling} referenceId={referenceId} staticOnly /></div>
          <figcaption>{i + 1} · {item.name}</figcaption>
          <button className="dw-gallery-open" type="button" aria-label={`查看 ${item.name}`} onClick={() => { pickScreen(item.id); showAll(false); }} />
        </figure>;
      })}</div> : <div className="dw-single">
        <DesignFrame projectId={entry.projectId} version={version} screen={screen} theme={visibleTheme} zoom={zoom} placing={placing}
          staticOnly={!active} referenceId={recordedVisual?.referenceImageId} pin={pin} comments={comments ? marks : undefined}
          onPin={point => { setPin(point); setPlacing(false); }} onKey={key} onComment={setComment} />
      </div>}

      {screen && (!all || compare) && <div className="dw-screen-nav">
        <button type="button" aria-label="上一张画面" disabled={index === 0} onClick={() => previous(-1)}><ChevronLeft /></button>
        <button type="button" aria-label="下一张画面" disabled={index + 1 >= screens.length} onClick={() => previous(1)}><ChevronRight /></button>
      </div>}
      {screen ? <div className="dw-screen-picker">
        <select aria-label="选择画面" value={screen?.id ?? ''} onChange={event => { pickScreen(event.target.value); showAll(false); setPin(undefined); setPlacing(false); }}>
          {screens.map((item, i) => <option key={item.id} value={item.id}>{i + 1} / {screens.length} · {item.name}</option>)}
        </select>
        {screen && <small>{screen.viewport === 'phone' ? '375 × 812' : '1280 × 800'} · {screen.route}</small>}
      </div> : !compare && <p className="dw-canvas-note">本版未声明画面清单，正在展示独立原型。</p>}
      {compare && changes && <aside className="dw-float" aria-label="版本变化"><header><b>变化</b><button className="ep-button ep-icon-button" aria-label="关闭变化" onClick={() => showChanges(false)}><X /></button></header>
        <h3>画面</h3>
        {screens.map(item => {
          const before = leftVersion?.screens.find(row => row.id === item.id), after = rightVersion?.screens.find(row => row.id === item.id);
          const previousImage = leftVersion?.renders?.[item.id]?.[visibleTheme];
          const nextImage = rightVersion?.renders?.[item.id]?.[visibleTheme];
          const status = real ? (item.impl ? '已绑定实现' : '缺少实现地址')
            : !before ? '新增' : !after ? '移除' : previousImage && nextImage ? (previousImage.sha256 === nextImage.sha256 ? '截图相同' : '截图有变化')
              : JSON.stringify(before) === JSON.stringify(after) ? '声明相同' : '声明变化';
          return <button type="button" className="dw-change-list" key={item.id} onClick={() => pickScreen(item.id)}>{item.name}<small>{status}</small></button>;
        })}
        <h3>结构变化</h3>{structure.length ? <ul className="dw-structure-list">{structure.map(row => <li key={row.id}>
          <small>{row.kind}</small><strong>{row.label}</strong><p>{row.text.slice(0, 200)}</p>
        </li>)}</ul> : <p>无结构变化记录</p>}
        <h3>本版处理的评论</h3>{reported.length ? reported.map(([id, detail]) => {
          const comment = entry.comments.find(row => row.id === id);
          return <button type="button" key={id} className="dw-change-list" disabled={!comment || !rightVersion} onClick={() => comment && rightVersion && onReview(comment, rightVersion)}>{detail}</button>;
        }) : <p>本版没有声明处理评论。</p>}
      </aside>}
      {!compare && comments && <aside className="dw-float" aria-label="画面评论">
        <header><b>评论 · {marks.length}</b><button className="ep-button ep-icon-button" aria-label="关闭评论" onClick={() => { showComments(false); setPlacing(false); }}><X /></button></header>
        {canComment && <button type="button" className="ep-button" onClick={() => { showAll(false); setPlacing(!placing); setPin(undefined); }}>
          <Plus />{placing ? '取消标记' : '添加评论'}</button>}
        {placing && <p>选择画面上的位置</p>}
        {pin && <form onSubmit={async event => {
          event.preventDefault();
          if (body.trim() && await command('comment.create', { designId: entry.id, version: version.version,
            screenId: screen.id, ...pin, body: body.trim() })) { setPin(undefined); setBody(''); }
        }}>
          <label>评论内容<textarea value={body} onChange={event => setBody(event.target.value)} required maxLength={4000} /></label>
          <button className="ep-button ep-button--primary" type="submit" disabled={commandBusy}>保存评论</button>
        </form>}
        {marks.map((comment, i) => {
          const claimed = [...entry.versions].reverse().find(row => Object.hasOwn(row.resolves, comment.id));
          return <article key={comment.id} className="dw-comment" data-selected={focused?.id === comment.id}>
            <button type="button" className="dw-change-list" onClick={() => setComment(comment.id)}>
              <b>{i + 1}. {comment.author.label}</b><small>{comment.closed ? '已关闭' : designDate(comment.createdAt)}</small></button>
            <p>{comment.body}</p>
            {comment.replies.map((item, i) => <p key={i}><small>{item.author.label}</small> {item.body}</p>)}
            {!comment.closed && claimed && <button className="ep-button" type="button" onClick={() => onReview(comment, claimed)}>
              {actorId === comment.author.id || steward ? '核对评论' : '查看处理声明'}</button>}
            {canWrite && !comment.closed && focused?.id === comment.id && <form onSubmit={async event => {
              event.preventDefault();
              if (reply.trim() && await command('comment.reply', { designId: entry.id, commentId: comment.id, body: reply.trim() })) setReply('');
            }}>
              <label>回复<textarea value={reply} onChange={event => setReply(event.target.value)} maxLength={4000} required /></label>
              <button className="ep-button" disabled={commandBusy}>回复</button>
            </form>}
          </article>;
        })}
        {!marks.length && !pin && !placing && <p className="dw-muted">本版此画面还没有评论</p>}
        {!!earlierMarks.length && <section className="dw-other-comments">
          <h4>其他版本的画布评论</h4>
          {earlierMarks.map(comment => <Link className="dw-change-list" key={comment.id}
            to={'/design?' + new URLSearchParams({ project: entry.projectId, design: entry.id, version: String(comment.version),
              screen: comment.screenId, comment: comment.id })}>
            <span>{comment.body.slice(0, 90)}</span><small>V{comment.version}{comment.closed ? ' · 已关闭' : ''}</small>
          </Link>)}
        </section>}
        <Link className="ep-link" to={'/design?' + new URLSearchParams({ project: entry.projectId, design: entry.id,
          version: String(version.version), tab: 'delivery', full: 'delivery', part: 'feedback' }) + '#dw-delivery-feedback'}>查看各版实施反馈</Link>
      </aside>}
    </div>
    {full && <nav className="dw-strip" aria-label="大屏画面列表">{screens.map((item, i) =>
      <button key={item.id} type="button" className="ep-button" aria-current={item.id === screen?.id} onClick={() => select(item.id)}>{i + 1} · {item.name}</button>)}</nav>}
  </>;
}

function realEvidence(run: DesignRun, version: DesignVersion, screen: DesignScreen, theme: DesignTheme) {
  return run.cells.find(cell => {
    if (!cell.imageId || !cell.measured || cell.measured.path !== screen.impl || cell.measured.theme !== theme
      || !cell.slot.startsWith(screen.viewport)) return false;
    const rule = version.acceptance.find(row => row.id === cell.itemId);
    if (!rule) return false;
    const target = designAcceptanceTarget(version, rule, cell.slot);
    return target && target.impl === screen.impl && (target.readySelector ?? null) === (screen.readySelector ?? null)
      && (!rule.screenId || rule.screenId === screen.id);
  });
}

export function DesignReviewDialog({ entry, comment, version, canReview, command, busy, onClose }: {
  entry: DesignEntry; comment: DesignComment; version: DesignVersion; canReview: boolean; command: DesignCommand; busy: boolean; onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [returning, setReturning] = useState(false);
  const before = entry.versions.find(row => row.version === comment.version);
  const prior = before?.screens.find(row => row.id === comment.screenId);
  const after = version.screens.find(row => row.id === comment.screenId);
  const reviewed = comment.reviews.some(row => row.version === version.version);
  const submit = async (decision: 'resolved' | 'rejected') => {
    if (await command('comment.review', { designId: entry.id, version: version.version, commentId: comment.id,
      body: reason.trim() || undefined, decision })) onClose();
  };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="dw-review dw-surface">
    <DialogTitle>核对评论 · V{comment.version} → V{version.version}</DialogTitle>
    <DialogDescription>{comment.author.label} · {designDate(comment.createdAt)}</DialogDescription>
    <blockquote>{comment.body}</blockquote>
    <div className="dw-review-pair">
      <figure><figcaption>原评论画面 · V{comment.version}</figcaption><DesignFrame projectId={entry.projectId} version={before} screen={prior}
        theme="light" zoom={null} pin={comment} staticOnly={Boolean(after)} onKey={key => { if (key === 'Escape') onClose(); }} /></figure>
      <figure><figcaption>本版画面 · V{version.version}</figcaption><DesignFrame projectId={entry.projectId} version={version} screen={after}
        theme="light" zoom={null} pin={comment} onKey={key => { if (key === 'Escape') onClose(); }} /></figure>
    </div>
    <p><strong>作者说明</strong> {version.resolves[comment.id]}</p>
    {returning && <label>退回原因<textarea value={reason} onChange={event => setReason(event.target.value)} required maxLength={2000}/></label>}
    {canReview && !reviewed && !comment.closed && <footer>
      <button type="button" className="ep-button" disabled={busy || (returning && !reason.trim())}
        onClick={() => returning ? void submit('rejected') : setReturning(true)}>没改好，退回</button>
      <button type="button" className="ep-button ep-button--primary" disabled={busy} onClick={() => void submit('resolved')}>改好了，关闭评论</button>
    </footer>}
  </DialogContent></Dialog>;
}
