/**
 * 音箱日志动效原型。
 *
 * 路径：/_dev/speaker-log
 * 同一轮对话就地更新；19:58:08 到 19:58:16 为 8 秒样例；19:59:51 另起一轮。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Bug, Check, FileText, Home, Library, ListTodo, Menu, Speaker } from 'lucide-react';
import { Button } from '@/components/design/Button';
import {
  KEYFRAMES,
  KEYFRAME_SEEK,
  ROUND2_MS,
  SAMPLE_DURATION_MS,
  buildScreen,
  captionHoldRemaining,
  freshCaptionIndexes,
  logScrollSignature,
  nextScrollTop,
  stampChangedChars,
  type Conversation,
  type FrameId,
  type Line,
  type PlayerSnap,
  type ScreenModel,
} from './model';
import './speaker-log.css';

const PORTRAIT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
    <rect width="80" height="80" fill="#C47B5A"/>
    <circle cx="40" cy="34" r="14" fill="#F3D2C2"/>
    <path d="M18 74c4-16 12-24 22-24s18 8 22 24" fill="#F3D2C2"/>
    <circle cx="34" cy="33" r="1.7" fill="#3A2A24"/>
    <circle cx="46" cy="33" r="1.7" fill="#3A2A24"/>
  </svg>`,
)}`;

const HOME_COLUMNS: { title: string; rows: [string, string][] }[] = [
  {
    title: '今日安排',
    rows: [
      ['对齐周报口径', '09:30'],
      ['评审缺陷回流', '11:00'],
      ['任务台走查', '14:20'],
      ['准备明早分享', '16:00'],
      ['确认发布说明', '17:40'],
    ],
  },
  {
    title: '未关闭缺陷',
    rows: [
      ['筛选后列表错位', '高'],
      ['浅色边框发虚', '中'],
      ['导出时间少八小时', '高'],
      ['评论抽屉挡住正文', '中'],
      ['空态文案仍是英文', '低'],
      ['附件名被截断', '低'],
    ],
  },
  {
    title: '最近文档',
    rows: [
      ['任务台使用说明', '林夏'],
      ['周报字段对照', '周宁'],
      ['发布检查单', '何安'],
      ['音箱联调记录', '林夏'],
    ],
  },
  {
    title: '通知',
    rows: [
      ['周报已提交', '2 分钟前'],
      ['缺陷指派给你', '18 分钟前'],
      ['知识库有新评论', '26 分钟前'],
      ['评审邀请待确认', '41 分钟前'],
      ['版本说明待补一句', '1 小时前'],
      ['任务台有一条建议', '1 小时前'],
    ],
  },
];

const TASK_COLUMNS: { title: string; rows: [string, string][] }[] = [
  {
    title: '正在做',
    rows: [['把音箱日志接到任务台', '刚刚']],
  },
  {
    title: '接下来',
    rows: [
      ['补齐浅色对比', '今天'],
      ['核对周报数字', '今天'],
      ['收回过期评审', '明天'],
      ['整理缺陷分组', '明天'],
      ['更新发布说明', '周五'],
    ],
  },
  {
    title: '最近完成',
    rows: [
      ['首页卡片对齐', '昨天'],
      ['评论通知改成中文', '昨天'],
      ['导出时区修正', '周一'],
    ],
  },
  {
    title: '等待回复',
    rows: [
      ['周报口径还差一句结论', '周宁'],
      ['缺陷回流要不要进本周', '何安'],
      ['发布说明里的时间', '林夏'],
      ['知识库评论还没回', '陈可'],
      ['评审邀请今晚过期', '系统'],
      ['任务台建议待看', '米多'],
    ],
  },
];

const NAV = [
  { id: 'home', label: '首页', icon: Home },
  { id: 'tasks', label: '任务台', icon: ListTodo },
  { id: 'bugs', label: '缺陷', icon: Bug },
  { id: 'docs', label: '知识库', icon: Library },
  { id: 'report', label: '周报', icon: FileText },
] as const;

type Actions = {
  jump: (frame: FrameId) => void;
  setRate: (rate: 1 | 0.5) => void;
  replay: () => void;
  toggleReduce: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
};

function LiveCaption({ text, settled, mark, live, reduce }: {
  text: string;
  settled: boolean;
  mark: boolean;
  live: boolean;
  reduce: boolean;
}) {
  const prevText = useRef(live && !reduce ? '' : text);
  const bornAt = useRef<number[]>([]);
  const [, refresh] = useState(0);
  if (!live || reduce) {
    prevText.current = text;
    bornAt.current = [];
  } else if (prevText.current !== text) {
    bornAt.current = stampChangedChars(bornAt.current, prevText.current, text, performance.now());
    prevText.current = text;
  }
  const fresh = live && !reduce ? freshCaptionIndexes(bornAt.current, performance.now()) : [];
  const freshKey = fresh.join(',');
  useEffect(() => {
    if (!live || reduce) return undefined;
    const left = captionHoldRemaining(bornAt.current, performance.now());
    if (left === null) return undefined;
    const id = window.setTimeout(() => refresh((value) => value + 1), left);
    return () => window.clearTimeout(id);
  }, [text, live, reduce, freshKey]);
  if (!text) return null;
  return (
    <span className="cap" data-settled={settled ? '1' : '0'}>
      {Array.from(text).map((ch, index) => (
        <span key={`${index}-${ch}`} className={fresh.includes(index) ? 'cap-new' : undefined}>{ch}</span>
      ))}
      {mark ? <span className="cap-mark">定稿</span> : null}
    </span>
  );
}

function Identity({ row, live, reduce }: { row: Line; live: boolean; reduce: boolean }) {
  return (
    <div className="id-row" data-kind={row.kind} data-text={row.text}>
      {row.kind === 'user' ? (
        <img className="avatar-user" src={PORTRAIT} alt="" />
      ) : null}
      {row.kind === 'miduo' ? (
        <span className={`avatar-speaker${row.lit ? ' is-lit' : ''}${row.flash ? ' is-flash' : ''}`} aria-hidden>
          <Speaker size={18} />
        </span>
      ) : null}
      {row.kind === 'result' ? (
        <span className="avatar-menu" aria-hidden>
          <Menu size={16} />
          <span className="avatar-check"><Check size={11} strokeWidth={3} /></span>
        </span>
      ) : null}
      <div className="id-copy">
        <div className="id-name">{row.name}</div>
        <div className="id-body">
          <LiveCaption text={row.text} settled={row.settled} mark={row.showSettleMark} live={live} reduce={reduce} />
          {row.stage ? <span className="stage-wait">{row.stage}</span> : null}
          {row.note ? <span className="stage-wait">{row.note}</span> : null}
          {row.time ? <span className="stage-wait">{row.time}</span> : null}
          {row.volume ? (
            <span className="wave" data-waveform="1" aria-hidden>
              {row.volume.map((level, index) => (
                <i key={index} style={{ height: `${Math.max(3, Math.round(level * 18))}px` }} />
              ))}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ConversationCard({ item, live, reduce }: { item: Conversation; live: boolean; reduce: boolean }) {
  return (
    <article className="log-card" data-conversation={item.id} data-phase={item.phase}>
      <header>{item.startedAt}</header>
      {item.lines.map((row) => (
        <Identity key={row.key} row={row} live={live} reduce={reduce} />
      ))}
    </article>
  );
}

function LogScroller({ signature, children }: { signature: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const before = useRef({ scrollTop: 0, scrollHeight: 0 });
  const onScroll = () => {
    const el = ref.current;
    if (!el || el.clientHeight === 0) return;
    before.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.clientHeight === 0) return;
    const top = nextScrollTop({
      scrollTop: before.current.scrollTop,
      scrollHeight: before.current.scrollHeight,
      clientHeight: el.clientHeight,
      nextScrollHeight: el.scrollHeight,
    });
    if (top !== el.scrollTop) el.scrollTop = top;
    before.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
  }, [signature]);
  return (
    <div className="log-scroll" ref={ref} onScroll={onScroll} role="log" aria-label="音箱日志记录">
      {children}
    </div>
  );
}

export function SpeakerLogScreen({ model, actions }: { model: ScreenModel; actions: Actions }) {
  const { snap } = model;
  const signature = logScrollSignature(model.conversations);
  const activeNav = model.page === 'tasks' ? 'tasks' : 'home';
  const columns = model.page === 'tasks' ? TASK_COLUMNS : HOME_COLUMNS;
  return (
    <div className={`speaker-stage${snap.reduceMotion ? ' is-reduce' : ''}`} data-theme={snap.theme === 'light' ? 'light' : undefined} data-page={model.page}>
      <aside className="speaker-side" aria-label="主导航">
        <div className="speaker-brand">MAP</div>
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.id} className="speaker-nav" aria-current={item.id === activeNav ? 'page' : undefined}>
              <Icon size={16} />
              {item.label}
            </div>
          );
        })}
      </aside>
      <main className="speaker-main">
        {model.page === 'tasks' ? <h1 className="speaker-page-title">任务台</h1> : null}
        {columns.map((column) => (
          <section key={column.title} className={`speaker-card${column.title === '通知' || column.title === '等待回复' ? ' speaker-wide' : ''}`}>
            <h2>{column.title}</h2>
            <ul>
              {column.rows.map(([title, meta]) => (
                <li key={title}><strong>{title}</strong><span className="meta">{meta}</span></li>
              ))}
            </ul>
          </section>
        ))}
      </main>
      <div className="preview-bar" role="toolbar" aria-label="原型预览">
        <span className="preview-label">关键帧</span>
        {KEYFRAMES.map((frame) => (
          <Button
            key={frame.id}
            size="sm"
            variant={snap.frame === frame.id ? 'primary' : 'secondary'}
            aria-pressed={snap.frame === frame.id}
            onClick={() => actions.jump(frame.id)}
          >
            {frame.label}
          </Button>
        ))}
        <span className="preview-label">播放</span>
        <Button size="sm" variant={snap.rate === 1 ? 'primary' : 'secondary'} aria-pressed={snap.rate === 1} onClick={() => actions.setRate(1)}>正常速度</Button>
        <Button size="sm" variant={snap.rate === 0.5 ? 'primary' : 'secondary'} aria-pressed={snap.rate === 0.5} onClick={() => actions.setRate(0.5)}>慢放</Button>
        <Button size="sm" variant="secondary" onClick={actions.replay}>重播</Button>
        <Button size="sm" variant={snap.reduceMotion ? 'primary' : 'secondary'} aria-pressed={snap.reduceMotion} onClick={actions.toggleReduce}>减少动态效果</Button>
        <span className="preview-label">面板</span>
        <Button size="sm" variant={snap.theme === 'dark' ? 'primary' : 'secondary'} aria-pressed={snap.theme === 'dark'} onClick={() => actions.setTheme('dark')}>深色</Button>
        <Button size="sm" variant={snap.theme === 'light' ? 'primary' : 'secondary'} aria-pressed={snap.theme === 'light'} onClick={() => actions.setTheme('light')}>浅色</Button>
      </div>
      <section className="speaker-log" data-opaque="1" aria-label="音箱日志">
        <div className="speaker-log-head">
          <h2>音箱日志</h2>
          <time dateTime={model.clock}>{model.clock}</time>
        </div>
        <LogScroller signature={signature}>
          {model.conversations.map((item) => (
            <ConversationCard
              key={item.id}
              item={item}
              live={item.id === 'conv-195808' || item.id === 'conv-195951' || item.id === 'conv-timeout'}
              reduce={snap.reduceMotion}
            />
          ))}
        </LogScroller>
      </section>
    </div>
  );
}

const INITIAL: PlayerSnap = {
  script: 'sample',
  ms: 0,
  round2: null,
  rate: 1,
  reduceMotion: false,
  theme: 'dark',
  playing: true,
  frame: null,
};

export default function SpeakerLogPrototype() {
  const playerRef = useRef<PlayerSnap>(INITIAL);
  const [snap, setSnap] = useState<PlayerSnap>(INITIAL);
  const [generation, setGeneration] = useState(0);
  const rateRef = useRef<1 | 0.5>(1);
  rateRef.current = snap.rate;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!media.matches) return;
    const next = { ...playerRef.current, reduceMotion: true };
    playerRef.current = next;
    setSnap(next);
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = '音箱日志';
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute('data-theme');
    if (snap.theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    return () => {
      if (previous) root.setAttribute('data-theme', previous);
      else root.removeAttribute('data-theme');
    };
  }, [snap.theme]);

  useEffect(() => {
    let handle = 0;
    let last = performance.now();
    let hold = 0;
    let stopped = false;
    const tick = (now: number) => {
      if (stopped) return;
      const current = playerRef.current;
      if (!current.playing || current.script === 'idle') return;
      const delta = Math.min(80, now - last);
      last = now;
      let next = current;
      if (current.script === 'sample') {
        if (current.ms < SAMPLE_DURATION_MS) {
          hold = 0;
          next = { ...current, ms: Math.min(SAMPLE_DURATION_MS, current.ms + delta * rateRef.current), frame: null };
        } else if (current.round2 === null) {
          hold += delta;
          if (hold >= 1_200) next = { ...current, round2: 0 };
        } else if (current.round2 < ROUND2_MS) {
          next = { ...current, round2: Math.min(ROUND2_MS, current.round2 + delta * rateRef.current) };
        } else {
          next = { ...current, playing: false };
        }
      }
      if (next !== current) {
        playerRef.current = next;
        setSnap(next);
      }
      if (playerRef.current.playing) handle = window.requestAnimationFrame(tick);
    };
    if (playerRef.current.playing) handle = window.requestAnimationFrame(tick);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(handle);
    };
  }, [generation]);

  const commit = (next: PlayerSnap) => {
    playerRef.current = next;
    setSnap(next);
  };

  const actions: Actions = {
    jump: (frame) => {
      const seek = KEYFRAME_SEEK[frame];
      commit({ ...playerRef.current, playing: false, script: seek.script, ms: seek.ms, round2: null, frame });
    },
    setRate: (rate) => commit({ ...playerRef.current, rate }),
    replay: () => {
      commit({ ...playerRef.current, playing: true, script: 'sample', ms: 0, round2: null, frame: null });
      setGeneration((value) => value + 1);
    },
    toggleReduce: () => commit({ ...playerRef.current, reduceMotion: !playerRef.current.reduceMotion }),
    setTheme: (theme) => commit({ ...playerRef.current, theme }),
  };

  return <SpeakerLogScreen model={buildScreen(snap)} actions={actions} />;
}
