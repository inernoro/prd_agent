import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronUp, Clock, Plus, Send, X } from 'lucide-react';
import { MapMarkGlyph } from '@/components/ui/MapBrandMark';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import AskThread from './AskThread';
import { ASK_REFUSAL_REGISTRY, resolveAskRefusal } from './askRefusal';
import {
  askDockGeometry, askHintsBottom, askMetaBottom,
  type AskDockBox, type AskDockState, type AskDockViewport,
} from './askDockGeometry';
import { ASK_ERROR_CODES, ASK_MAX_QUESTION_LENGTH, type AskSource } from './askTypes';
import { useAskQuota } from './useAskQuota';
import { useAskStream } from './useAskStream';
import './askDock.css';

/** 起手态最多同时浮出几条提示，其余收进「+N」。四条以上会绕到第二行，把正文顶掉一截 */
const HINTS_VISIBLE = 3;

/** 形变主时长；胶囊→长条那一程多 100ms，因为中间多一帧「窜过头再弹回」 */
const MORPH_MS = 560;
const MORPH_DROPLET_MS = 660;

interface Props {
  source: AskSource;
  title: string;
  welcome?: string | null;
  openingQuestions: string[];
  allowAnonymous: boolean;
  isMobile: boolean;
  /** iOS 手势条实测高度，由 AskWidget 量好传进来 */
  safeBottom: number;
  /** 上层有别的浮层（全屏演示 / 评论抽屉）时整坞藏起来，但**不卸载** */
  hidden?: boolean;
  /**
   * 形态变化时通知父级。
   *
   * 存在的理由只有一个：访客页底部中间还站着别人（幻灯片站那条「方向键翻页」邀请条），
   * 起手长条一展开就会和它叠在一起。邀请条是邀请不是控件，该让开——但它归 ShareViewPage 管，
   * 坞自己够不着，所以把形态报上去由页面决定谁让谁。
   */
  onStateChange?: (state: AskDockState) => void;
}

function boxToStyle(b: AskDockBox) {
  return {
    right: `${b.right}px`,
    bottom: `${b.bottom}px`,
    width: `${b.width}px`,
    height: `${b.height}px`,
    borderRadius: b.radius,
  };
}

/**
 * 「向我提问」的浮层坞：一个入口，四个停靠位。
 *
 *   收起（右下胶囊） → 起手（中下玻璃长条 + 浮在上方的提示） → 对话（右侧栏） → 竖条
 *
 * **形变自始至终是同一个 DOM 节点**。这是整个设计成立的前提，也是它与旧实现最大的差别：
 * 旧实现是「一个按钮 + 一个抽屉」两个元素各自淡入淡出，看着像两样东西轮流出现；
 * 现在是一件东西在改变形状，胶囊被拉长成长条、长条滑成侧栏。内容层只做透明度交叉，
 * 几何只由 morphTo 一处驱动。
 *
 * 覆盖而非推挤：推挤会改变托管页自己的排版，PPT 与宽表格站当场破相。代价是盖住右边
 * 400px，所以给了三档折叠，且每一档都留着轮次角标——不留痕的话用户会以为对话没了，
 * 回头重问一遍，白烧一次额度。
 */
export default function AskDock({
  source, title, welcome, openingQuestions, allowAnonymous, isMobile, safeBottom, hidden, onStateChange,
}: Props) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { messages, status, phaseMessage, model, gateError, clearGateError, isBusy, ask } = useAskStream(source);

  const [state, setState] = useState<AskDockState>('collapsed');
  const [moving, setMoving] = useState(false);
  const [draft, setDraft] = useState('');
  const [hintsExpanded, setHintsExpanded] = useState(false);
  const [composerFolded, setComposerFolded] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 视口尺寸进 state 而不是每次读 window：window.innerWidth 不是响应式的，
  // 读它只会在别的原因触发重渲染时才碰巧刷新一次。
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === 'undefined' ? 1440 : window.innerWidth,
    height: typeof window === 'undefined' ? 900 : window.innerHeight,
  }));

  const rootRef = useRef<HTMLDivElement>(null);
  const morphRef = useRef<HTMLDivElement | null>(null);
  const barInputRef = useRef<HTMLInputElement>(null);
  const sideInputRef = useRef<HTMLTextAreaElement>(null);
  const animRef = useRef<Animation | null>(null);
  /** 形变读的是「现在这一刻的 state」，而 morphTo 被键盘监听等长生命周期闭包持有 */
  const stateRef = useRef(state);
  stateRef.current = state;

  const viewport: AskDockViewport = useMemo(
    () => ({ ...viewportSize, isMobile, safeBottom }),
    [viewportSize, isMobile, safeBottom],
  );
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const refusal = resolveAskRefusal({ isAuthenticated, allowAnonymous, gateErrorCode: gateError?.code });
  const blocked = refusal !== null;
  const rounds = messages.filter((m) => m.role === 'user').length;

  const { quota, refresh: refreshQuota } = useAskQuota(source, !hidden && state !== 'collapsed');
  // 每问完一次（成功或失败）都重算：失败里含「读不到正文」那档，后端会把额度退回来，
  // 只在成功时减一会让用户看到一个偏小的数，而他并没有被扣。
  useEffect(() => {
    if (status === 'done' || status === 'error') void refreshQuota();
  }, [status, refreshQuota]);

  // 额度窗口过了就把那道门收起来。
  //
  // 每小时 / 每天这两档拒绝是有有效期的，卡片上也写着「过一会儿再来」。但 gateError 只在
  // ask() 开头清，而 blocked 时又不许调 ask()——门一落下就只能刷新页面才起得来，
  // 与卡片上那句话直接矛盾。这里以服务端的额度读数为准：它说还有余量，那道门就是过期的。
  const quotaCode = gateError?.code;
  const quotaBlocked = quotaCode === ASK_ERROR_CODES.quotaVisitor
    || quotaCode === ASK_ERROR_CODES.quotaSiteDaily
    || quotaCode === ASK_ERROR_CODES.quotaExceeded;
  useEffect(() => {
    if (!quotaBlocked || !quota) return;
    if (quota.visitorRemaining > 0 && quota.siteRemaining > 0) clearGateError();
  }, [quotaBlocked, quota, clearGateError]);

  const applyStatic = useCallback((next: AskDockState) => {
    const el = morphRef.current;
    if (!el) return;
    Object.assign(el.style, boxToStyle(askDockGeometry(next, viewportRef.current)));
  }, []);

  /**
   * 形变到下一态。
   *
   * 中间那一帧（横向窜过头 + 压扁）是「水珠被拉长」的全部来源，纯 CSS transition
   * 插不进这一帧，所以走 WAAPI 显式写关键帧。只有「胶囊 → 长条」这一程有它：
   * 长条→侧栏是一件东西滑过去，再加一次弹跳就成了抽搐。
   */
  const morphTo = useCallback((next: AskDockState) => {
    const el = morphRef.current;
    const prev = stateRef.current;
    if (!el || prev === next) return;

    stateRef.current = next;
    setState(next);
    if (next !== 'chat') setHistoryOpen(false);

    const to = askDockGeometry(next, viewportRef.current);
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof el.animate !== 'function') {
      Object.assign(el.style, boxToStyle(to));
      return;
    }

    // 起帧从**实测**位置取，而不是 geo(prev)：上一次形变可能被打断在半路，
    // 拿理论值当起点会让它先瞬移回去再走一遍。
    const rect = el.getBoundingClientRect();
    const from: AskDockBox = {
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      width: rect.width,
      height: rect.height,
      radius: getComputedStyle(el).borderRadius,
    };

    const droplet = prev === 'collapsed' && next === 'bar';
    const frames: Keyframe[] = [boxToStyle(from) as unknown as Keyframe];
    if (droplet) {
      frames.push({
        // 先往中间窜过头一截、压扁，再弹回落位
        right: `${(from.right + to.right) / 2 - 70}px`,
        bottom: `${to.bottom - 14}px`,
        width: `${Math.round(to.width * 0.66)}px`,
        height: '44px',
        borderRadius: '999px',
        offset: 0.3,
      } as unknown as Keyframe);
    }
    frames.push(boxToStyle(to) as unknown as Keyframe);

    animRef.current?.cancel();
    setMoving(true);
    const spring = getComputedStyle(rootRef.current ?? el).getPropertyValue('--ask-spring').trim();
    const anim = el.animate(frames, {
      duration: droplet ? MORPH_DROPLET_MS : MORPH_MS,
      easing: spring || 'ease',
      fill: 'forwards',
    });
    animRef.current = anim;
    anim.onfinish = () => {
      anim.cancel();
      animRef.current = null;
      // cancel 会把 fill:forwards 的效果一起撤掉，所以必须把终态写回 style
      Object.assign(el.style, boxToStyle(askDockGeometry(stateRef.current, viewportRef.current)));
      setMoving(false);
    };
  }, []);

  const submit = useCallback((text: string) => {
    const q = text.trim();
    if (!q || isBusy || blocked) return;
    setDraft('');
    setComposerFolded(false);
    if (stateRef.current !== 'chat') morphTo('chat');
    void ask(q);
  }, [ask, isBusy, blocked, morphTo]);

  const openFromPill = useCallback(() => {
    // 已经知道问不了（未登录且站点不许匿名）时不走起手态：那条长条只会让人打完一句
    // 才发现发不出去。直接进对话栏，拒绝卡在那里把理由和下一步一起讲清。
    if (blocked) { morphTo('chat'); return; }
    morphTo('bar');
    window.setTimeout(() => barInputRef.current?.focus(), 240);
  }, [blocked, morphTo]);

  // 落位：首次挂载、视口变化、从隐藏态回来，都要把几何重新贴一次
  useEffect(() => { applyStatic(stateRef.current); }, [applyStatic, viewport, hidden]);

  useEffect(() => {
    const onResize = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // 键盘：⌘K 唤起 / 逐级后退。hidden 时不抢——那会儿盖在最上面的不是我们。
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (stateRef.current === 'collapsed') openFromPill();
        else if (stateRef.current === 'rail') morphTo('chat');
        else if (stateRef.current === 'bar') barInputRef.current?.focus();
        else sideInputRef.current?.focus();
        return;
      }
      if (e.key !== 'Escape') return;
      // Esc 退一步而不是一步到底：问过话的人按 Esc 通常是「先收起来看看正文」，
      // 直接收回胶囊会让他找不到刚才那段对话。
      if (stateRef.current === 'bar') morphTo('collapsed');
      else if (stateRef.current === 'chat') morphTo(rounds > 0 ? 'rail' : 'collapsed');
      else if (stateRef.current === 'rail') morphTo('collapsed');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, openFromPill, morphTo, rounds]);

  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);

  useEffect(() => () => animRef.current?.cancel(), []);

  const hintList = hintsExpanded ? openingQuestions : openingQuestions.slice(0, HINTS_VISIBLE);
  const hiddenHints = openingQuestions.length - hintList.length;
  const barOn = state === 'bar';
  const quotaLine = quota
    ? `本页今日剩 ${quota.siteRemaining} / ${quota.siteLimit} · 你这小时剩 ${quota.visitorRemaining} / ${quota.visitorLimit}`
    : null;

  const layerBase: React.CSSProperties = {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
  };
  /**
   * 内容层的交叉淡入。
   *
   * visibility 跟着切而不是只调 opacity：只调 opacity 的话，收起态那枚 132px 胶囊里
   * 仍然叠着长条的输入框和侧栏的三个按钮——看不见，但 Tab 能停上去、读屏会念出来。
   * visibility 的过渡延到淡出之后再生效，否则一切就是硬消失，看不到那一下交叉。
   */
  const layer = (on: boolean, extra: React.CSSProperties): React.CSSProperties => ({
    ...layerBase,
    ...extra,
    opacity: on ? 1 : 0,
    visibility: on ? 'visible' : 'hidden',
    pointerEvents: on ? 'auto' : 'none',
    transition: on
      ? 'opacity .14s var(--ask-ease) .08s, visibility 0s'
      : 'opacity .09s var(--ask-ease), visibility 0s linear .09s',
  });

  const iconBtn: React.CSSProperties = {
    width: 26, height: 26, borderRadius: 7, flexShrink: 0, cursor: 'pointer',
    border: '1px solid var(--border-subtle)', background: 'transparent',
    color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
  };

  return (
    <div
      ref={rootRef}
      className="ask-dock-root"
      style={{ display: hidden ? 'none' : 'block' }}
      aria-hidden={hidden || undefined}
    >
      {/* 浮在长条上方的提示。不放进长条内部：它们要能换行、要能一颗颗弹出来，
          而长条是个会被逐帧改宽高的容器，塞进去就会跟着形变一起抽。 */}
      <div
        className="ask-dock-hints"
        data-on={barOn && !blocked && hintList.length > 0}
        style={{
          position: 'fixed', left: 0, right: 0, zIndex: 59,
          bottom: askHintsBottom(viewport),
          display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap',
          padding: '0 16px', pointerEvents: 'none',
        }}
      >
        {barOn && hintList.map((q, i) => (
          <button
            key={q}
            type="button"
            className="ask-dock-hint"
            onClick={() => submit(q)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, height: 34, padding: '0 14px',
              borderRadius: 999, border: '1px solid var(--ask-dock-glass-border)',
              background: 'var(--ask-dock-hint-bg)',
              backdropFilter: 'blur(18px) saturate(140%)',
              WebkitBackdropFilter: 'blur(18px) saturate(140%)',
              boxShadow: 'var(--ask-dock-hint-shadow)',
              color: 'var(--text-primary)', fontSize: 12.5, whiteSpace: 'nowrap',
              maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
              cursor: 'pointer', pointerEvents: 'auto', fontFamily: 'inherit', fontWeight: 400,
            }}
          >
            {i === 0 && <MapMarkGlyph size={13} tone="var(--accent-primary)" nodes={false} />}
            {q}
          </button>
        ))}
        {barOn && hiddenHints > 0 && (
          <button
            type="button"
            className="ask-dock-hint"
            onClick={() => setHintsExpanded(true)}
            style={{
              display: 'flex', alignItems: 'center', height: 34, padding: '0 12px',
              borderRadius: 999, border: '1px solid var(--ask-dock-glass-border)',
              background: 'var(--ask-dock-hint-bg)',
              backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)',
              color: 'var(--text-tertiary)', fontFamily: 'var(--font-code, ui-monospace, monospace)',
              fontSize: 11, cursor: 'pointer', pointerEvents: 'auto',
            }}
          >
            +{hiddenHints}
          </button>
        )}
      </div>

      {/* 长条下方那一行：范围约束 + 还剩几次。自带玻璃底片——托管正文多半是白纸，
          浅色字直接落上去会整行看不见。 */}
      <div
        className="ask-dock-meta"
        style={{
          position: 'fixed', left: 0, right: 0, zIndex: 59,
          bottom: askMetaBottom(viewport),
          display: 'flex', justifyContent: 'center', pointerEvents: 'none',
          opacity: barOn && !isMobile ? 1 : 0, transition: 'opacity .2s var(--ask-ease)',
        }}
      >
        <span
          style={{
            display: 'flex', alignItems: 'center', gap: 8, height: 24, padding: '0 12px',
            borderRadius: 999, background: 'var(--ask-dock-meta-bg)',
            backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid var(--border-faint)',
            fontFamily: 'var(--font-code, ui-monospace, monospace)', fontSize: 10,
            color: 'var(--text-tertiary)', whiteSpace: 'nowrap',
          }}
        >
          只依据本页正文
          {quotaLine && <span style={{ opacity: 0.42 }}>·</span>}
          {quotaLine}
        </span>
      </div>

      {/* 会形变的那一个节点。几何只由 morphTo 写，React 不参与——两边都写就会打架。 */}
      <div
        ref={(node) => {
          morphRef.current = node;
          // 首帧就把几何写上：等 effect 跑完已经过了一次绘制，那一帧坞是没有尺寸的
          if (node && !node.style.width) {
            Object.assign(node.style, boxToStyle(askDockGeometry(stateRef.current, viewportRef.current)));
          }
        }}
        className="ask-dock"
        role={state === 'collapsed' ? undefined : 'dialog'}
        aria-label="向我提问"
        style={{
          position: 'fixed', zIndex: 60, overflow: 'hidden',
          color: 'var(--text-primary)',
          cursor: state === 'collapsed' ? 'pointer' : 'default',
          ...(state === 'collapsed'
            ? {
                // 主操作面走 button-primary 这对 token：accent 底配浅色字只有 2.92:1，
                // 达不到对比度下限（守卫见 inkPalette.test.ts）
                background: 'var(--button-primary-bg)',
                border: '1px solid transparent',
                boxShadow: 'var(--shadow-glass-floating)',
              }
            : state === 'bar'
              ? {
                  // 形变途中把 blur 关掉：浮在 iframe 上跨帧合成很容易掉到 30fps
                  background: moving ? 'var(--ask-dock-moving-bg)' : 'var(--ask-dock-glass-bg)',
                  border: '1px solid var(--ask-dock-glass-border)',
                  boxShadow: 'var(--ask-dock-shadow)',
                  ...(moving ? {} : {
                    backdropFilter: 'blur(22px) saturate(140%)',
                    WebkitBackdropFilter: 'blur(22px) saturate(140%)',
                  }),
                }
              : {
                  // 对话栏必须**不透明**：半透的抽屉压在访客页顶栏上时，
                  // 「全屏演示 / 评论」那几个按钮会隔着面板幽幽透出来，看着像渲染坏了。
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: 'var(--shadow-glass-drawer)',
                }),
        }}
      >
        {/* ── 收起：胶囊 ── */}
        <button
          type="button"
          onClick={openFromPill}
          aria-label="向我提问"
          style={{
            ...layer(state === 'collapsed', { justifyContent: 'center', gap: 8 }),
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: 'var(--button-primary-fg)', fontFamily: 'inherit',
          }}
        >
          <MapMarkGlyph size={17} tone="var(--button-primary-fg)" nodes={false} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>向我提问</span>
          {/* 折起来也要留痕：不留的话用户以为对话没了，回头重问一遍白烧额度。
              角标画在胶囊**内部**——外层是 overflow:hidden，探出边界的那种角标会被整块裁掉。 */}
          {rounds > 0 && (
            <span
              style={{
                minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, flexShrink: 0,
                background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontSize: 10,
                fontFamily: 'var(--font-code, ui-monospace, monospace)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {rounds}
            </span>
          )}
        </button>

        {/* ── 起手：玻璃长条 ── */}
        <div style={layer(state === 'bar', { gap: 11, padding: isMobile ? '0 6px 0 14px' : '0 8px 0 18px' })}>
          <MapMarkGlyph size={20} tone="var(--accent-primary)" />
          <input
            ref={barInputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(draft); } }}
            // 「问点什么…」没说清能问什么，用户会拿它当通用聊天框问页面外的事，
            // 然后吃一句「页面里没有提到」。把范围写进 placeholder，问之前就知道边界。
            placeholder={blocked ? ASK_REFUSAL_REGISTRY[refusal].placeholder : '就这一页提个问题'}
            disabled={blocked}
            maxLength={ASK_MAX_QUESTION_LENGTH}
            autoComplete="off"
            aria-label="就这一页提个问题"
            style={{
              flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none',
              color: 'var(--text-primary)',
              // 16px 是 iOS 的临界值：小于它 Safari 会在聚焦时自动放大整个页面
              fontSize: isMobile ? 16 : 14, fontFamily: 'inherit',
            }}
          />
          {!isMobile && (
            <span
              style={{
                flexShrink: 0, padding: '3px 7px', borderRadius: 6,
                border: '1px solid var(--ask-dock-glass-border)',
                fontFamily: 'var(--font-code, ui-monospace, monospace)', fontSize: 10.5,
                color: 'var(--text-tertiary)',
              }}
            >
              ⌘K
            </span>
          )}
          <button
            type="button"
            onClick={() => submit(draft)}
            disabled={!draft.trim() || isBusy || blocked}
            aria-label="发送"
            style={{
              width: 38, height: 38, borderRadius: 999, border: 'none', flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: !draft.trim() || isBusy || blocked ? 'var(--bg-tertiary)' : 'var(--button-primary-bg)',
              color: !draft.trim() || isBusy || blocked ? 'var(--text-muted)' : 'var(--button-primary-fg)',
              cursor: !draft.trim() || isBusy || blocked ? 'default' : 'pointer',
            }}
          >
            {isBusy ? <MapSpinner size={14} /> : <Send size={15} />}
          </button>
        </div>

        {/* ── 对话：右侧栏 ── */}
        <div style={layer(state === 'chat', { flexDirection: 'column', alignItems: 'stretch' })}>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '11px 13px',
              borderBottom: '1px solid var(--border-faint)', flexShrink: 0,
            }}
          >
            <MapMarkGlyph size={18} tone="var(--accent-primary)" />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>向我提问</div>
              {/* 模型名必须可见（ai-model-visibility 第 1 条），且只能来自服务端 model 事件 */}
              <div
                style={{
                  fontSize: 10.5, color: 'var(--text-muted)',
                  fontFamily: 'var(--font-code, ui-monospace, monospace)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {model ? `${model.model}${model.platform ? ` · ${model.platform}` : ''}` : title}
              </div>
            </div>
            <button
              type="button" className="ask-dock-icon-btn" title="这一页问过的"
              onClick={() => setHistoryOpen((v) => !v)}
              style={{
                ...iconBtn,
                ...(historyOpen
                  ? { background: 'var(--semantic-info-soft)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }
                  : null),
              }}
            >
              <Clock size={13} />
            </button>
            <button
              type="button" className="ask-dock-icon-btn" title="折成竖条"
              onClick={() => morphTo('rail')} style={iconBtn}
            >
              <ChevronRight size={13} />
            </button>
            <button
              type="button" className="ask-dock-icon-btn" title="收回胶囊"
              onClick={() => morphTo('collapsed')} style={iconBtn}
            >
              <X size={13} />
            </button>
          </div>

          {/* 范围与额度常驻一行：它们会随对话滚走的话，恰恰是问到第三条时看不见了 */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '5px 13px',
              borderBottom: '1px solid var(--border-faint)', flexShrink: 0,
              fontFamily: 'var(--font-code, ui-monospace, monospace)', fontSize: 10,
              color: 'var(--text-tertiary)',
            }}
            title={quotaLine ? '两层独立计数：站点每日总量 + 你这一小时的额度' : undefined}
          >
            <span>只依据本页正文</span>
            {/* 读不到就整块不渲染——宁可不说，也不给一个编的数（no-rootless-tree） */}
            {quotaLine && (
              <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                {quotaLine}
              </span>
            )}
          </div>

          <AskThread
            messages={messages}
            welcome={welcome}
            title={title}
            openingQuestions={openingQuestions}
            onPick={submit}
            refusal={refusal}
            // 后端这几档的原话带着真实数字（每小时几次、还剩多久），优先于注册表兜底文案。
            // 但只在错误码确实对应当前这一档时才用——未登录压过服务端错误码那条优先级里，
            // gateError 可能是上一次会话的残留，拿它的文案去配「需要登录」的标题就串了。
            refusalServerMessage={
              resolveAskRefusal({ isAuthenticated, allowAnonymous: true, gateErrorCode: gateError?.code }) === refusal
                ? gateError?.message
                : null
            }
            onLogin={() => {
              const back = encodeURIComponent(window.location.pathname + window.location.search);
              // 参数名必须是 returnUrl——LoginPage 只认这一个，传别的读不到就回首页。
              // 访客本来是冲着「登录完接着在这一页问」来的，落到首页等于让他自己找回来。
              window.location.href = `/login?returnUrl=${back}`;
            }}
            onRetry={() => {
              // 读不到正文时后端会 RefundAsync 把额度退回来，所以重试是安全的、不烧额度
              const lastAsked = [...messages].reverse().find((m) => m.role === 'user');
              if (lastAsked) void ask(lastAsked.content);
            }}
            isBusy={isBusy}
            phaseMessage={phaseMessage}
          />

          {/* 输入区可以折起来：用户想安静看正文时，不该被一个输入框一直占着一截高度。
              折起后留一条「点这里接着问」，不是消失——消失会让人以为不能再问了。
              手机端补安全区，否则发送键落进 iOS 手势条。 */}
          <div
            style={{
              padding: '11px 13px 13px',
              paddingBottom: isMobile ? 'calc(13px + env(safe-area-inset-bottom, 0px))' : 13,
              borderTop: '1px solid var(--border-faint)', flexShrink: 0,
            }}
          >
            {composerFolded ? (
              <button
                type="button"
                onClick={() => {
                  setComposerFolded(false);
                  window.setTimeout(() => sideInputRef.current?.focus(), 0);
                }}
                style={{
                  width: '100%', height: 30, borderRadius: 9, cursor: 'pointer',
                  border: '1px dashed var(--border-subtle)', background: 'transparent',
                  color: 'var(--text-tertiary)', fontSize: 11.5, fontFamily: 'inherit',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}
              >
                <Plus size={12} />
                <span style={{ fontSize: 11.5 }}>点这里接着问</span>
              </button>
            ) : (
              <div
                style={{
                  display: 'flex', alignItems: 'flex-end', gap: 8, padding: '4px 5px 4px 14px',
                  borderRadius: 20, background: 'var(--bg-input)', border: '1px solid var(--border-subtle)',
                }}
              >
                <textarea
                  ref={sideInputRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(draft); }
                  }}
                  placeholder={blocked ? ASK_REFUSAL_REGISTRY[refusal].placeholder : '接着问'}
                  disabled={blocked}
                  rows={1}
                  maxLength={ASK_MAX_QUESTION_LENGTH}
                  aria-label="接着问"
                  style={{
                    flex: 1, minWidth: 0, resize: 'none', maxHeight: 110, padding: '7px 0',
                    background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)',
                    fontSize: isMobile ? 16 : 13.5, lineHeight: 1.5, fontFamily: 'inherit',
                  }}
                />
                <button
                  type="button" title="折起输入框"
                  onClick={() => setComposerFolded(true)}
                  style={{ ...iconBtn, width: 30, height: 30, border: 'none' }}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => submit(draft)}
                  disabled={!draft.trim() || isBusy || blocked}
                  aria-label="发送"
                  style={{
                    width: 30, height: 30, borderRadius: 999, border: 'none', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: !draft.trim() || isBusy || blocked ? 'var(--bg-tertiary)' : 'var(--button-primary-bg)',
                    color: !draft.trim() || isBusy || blocked ? 'var(--text-muted)' : 'var(--button-primary-fg)',
                    cursor: !draft.trim() || isBusy || blocked ? 'default' : 'pointer',
                  }}
                >
                  {isBusy ? <MapSpinner size={13} /> : <Send size={13} />}
                </button>
              </div>
            )}
            {draft.length >= ASK_MAX_QUESTION_LENGTH - 50 && (
              <div
                style={{
                  marginTop: 5, textAlign: 'right', fontSize: 10.5, color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {draft.length} / {ASK_MAX_QUESTION_LENGTH}
              </div>
            )}
          </div>

          {/* 这一页问过的。只有本次访问的轮次——没有做跨设备的历史，就不摆一个像有的入口。 */}
          <div
            className="ask-dock-history"
            style={{
              position: 'absolute', top: 46, left: 8, right: 8, zIndex: 3, borderRadius: 12,
              background: 'var(--overlay-panel-solid)', border: '1px solid var(--border-default)',
              boxShadow: 'var(--shadow-glass-dropdown)', overflow: 'hidden',
              opacity: historyOpen ? 1 : 0,
              transform: historyOpen ? 'none' : 'translateY(-8px) scale(.98)',
              pointerEvents: historyOpen ? 'auto' : 'none',
              transition: 'opacity .16s var(--ask-ease), transform .28s var(--ask-ease)',
            }}
          >
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                borderBottom: '1px solid var(--border-faint)', fontSize: 12, color: 'var(--text-secondary)',
              }}
            >
              <Clock size={12} />
              这一页问过的
              <span
                style={{
                  marginLeft: 'auto', fontFamily: 'var(--font-code, ui-monospace, monospace)',
                  fontSize: 10, color: 'var(--text-tertiary)',
                }}
              >
                {rounds} 轮
              </span>
            </div>
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              {messages.filter((m) => m.role === 'user').map((m, i, arr) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setHistoryOpen(false);
                    document.getElementById(`ask-msg-${m.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px',
                    border: 'none', borderBottom: '1px solid var(--border-faint)',
                    background: 'none', cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <div
                    style={{
                      fontSize: 12.5, color: 'var(--text-primary)', marginBottom: 3,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {m.content}
                  </div>
                  <div
                    style={{
                      fontSize: 10.5, color: 'var(--text-tertiary)',
                      fontFamily: 'var(--font-code, ui-monospace, monospace)',
                    }}
                  >
                    第 {i + 1} 轮{i === arr.length - 1 ? ' · 最近一条' : ''}
                  </div>
                </button>
              ))}
              {rounds === 0 && (
                <div style={{ padding: '12px', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.7 }}>
                  这一页还没问过。
                </div>
              )}
            </div>
            <div style={{ padding: '9px 12px', fontSize: 11, lineHeight: 1.6, color: 'var(--text-tertiary)' }}>
              这里只有本次访问问过的。刷新页面会重新开始 —— 跨设备的历史还没做，就不在这里假装有。
            </div>
          </div>
        </div>

        {/* ── 折成竖条 ── */}
        <div
          style={layer(state === 'rail', {
            flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
            gap: 12, padding: '12px 0',
          })}
        >
          <button
            type="button" className="ask-dock-icon-btn" title="展开"
            onClick={() => morphTo('chat')} style={iconBtn}
          >
            <ChevronLeft size={13} />
          </button>
          <MapMarkGlyph size={18} tone="var(--accent-primary)" nodes={false} />
          {/* 逐字换行而不是 writing-mode：竖条是 flex 列，vertical-rl 的块在主轴上算不出高度，
              真机量到这一格只有 4px，四个字整个被压没了（截图里竖条上是空的）。
              逐字堆叠在 44px 宽的竖条里是完全确定的，也省掉 writing-mode 的浏览器差异。 */}
          <div
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0,
              fontSize: 12, lineHeight: 1.25, color: 'var(--text-muted)',
            }}
          >
            {'向我提问'.split('').map((ch, i) => (
              <span key={`${ch}-${i}`}>{ch}</span>
            ))}
          </div>
          {rounds > 0 && (
            <div
              style={{
                minWidth: 18, height: 18, borderRadius: 9, padding: '0 5px',
                background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)',
                fontSize: 10, fontFamily: 'var(--font-code, ui-monospace, monospace)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {rounds}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
