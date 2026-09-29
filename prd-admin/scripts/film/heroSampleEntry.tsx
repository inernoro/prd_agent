import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BookOpen, Image as ImageIcon, Play, Volume2 } from 'lucide-react';
import '@/styles/tailwind.css';
import '@/styles/tokens.css';
import '@/styles/globals.css';

import { translations } from '@/pages/home/i18n/landing';
import { FILM } from '@/pages/home/film/filmPalette';
import { HERO_LOOP_DURATION, HERO_LOOP_ENTRY, HeroLoop, heroLoopBeat } from '@/pages/home/film/HeroLoop';
import { FILM_DURATION, formatClock } from '@/pages/home/film/filmTimeline';

/**
 * 首屏样片：把满屏循环背景和现有首屏的导航、主标题、输入框叠在一起，逐帧导出成一段录屏给人拍板。
 * 只是样片——不挂进首页，不进生产构建。?w=390&h=844 出手机竖屏版。
 */
declare global {
  interface Window {
    __film?: { ready: Promise<unknown>; duration: number; poster: number; seek: (t: number) => Promise<void>; renderAudio: () => Promise<string> };
  }
}

const q = new URLSearchParams(window.location.search);
const W = Number(q.get('w') || 1920);
const H = Number(q.get('h') || 1080);
const compact = W < 700;
const tr = translations.zh;
const PROMPTS: [string, string] = ['把仓库的 doc/ 目录同步进知识库', '为新品发布会做一张海报：暖色，留白'];
const AGENTS = [
  { icon: BookOpen, label: '知识库' },
  { icon: ImageIcon, label: '视觉创作' },
];
const NAV = ['产品', 'Agent', '工作流', '模型', '开始', '文档'];

const mount = document.getElementById('film');
if (!mount) throw new Error('#film missing');
mount.style.width = `${W}px`;
mount.style.height = `${H}px`;
document.body.style.width = `${W}px`;
document.body.style.height = `${H}px`;
const root = ReactDOM.createRoot(mount);

function Hero({ t }: { t: number }) {
  const beat = heroLoopBeat(t, PROMPTS);
  const agent = AGENTS[beat.shot];
  const Icon = agent.icon;
  const pressScale = 1 - 0.08 * Math.sin(Math.PI * beat.press);
  const s = compact ? 0.5 : 1;
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: 'Inter, "Noto Sans SC", sans-serif', color: FILM.text }}>
      <HeroLoop t={t} w={W} h={H} compact={compact} />

      {/* 导航：照现有首屏 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: compact ? 56 : 76, display: 'flex', alignItems: 'center', padding: compact ? '0 16px' : '0 40px', gap: 14 }}>
        <span style={{ width: compact ? 30 : 38, height: compact ? 30 : 38, borderRadius: 10, background: FILM.brandGradient, color: FILM.onBrand, display: 'grid', placeItems: 'center', fontSize: compact ? 10 : 12, fontWeight: 800 }}>MAP</span>
        <span style={{ fontSize: compact ? 14 : 17, fontWeight: 600 }}>米多智能体生态平台</span>
        {!compact && (
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 44, fontSize: 15, color: FILM.textDim }}>
            {NAV.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        )}
        {compact && <span style={{ flex: 1 }} />}
        <span style={{ padding: compact ? '7px 14px' : '10px 20px', borderRadius: 999, background: FILM.brandGradient, color: FILM.onBrand, fontSize: compact ? 13 : 15, fontWeight: 600 }}>登录 / 注册</span>
      </div>

      {/* 主标题 + 副标题 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: compact ? 170 : 300, textAlign: 'center', padding: '0 20px' }}>
        <div style={{ fontSize: compact ? 44 : 104, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.05, textShadow: `0 4px 40px ${FILM.spaceEdge}` }}>{tr.hero.title}</div>
        <div style={{ marginTop: compact ? 14 : 22, fontSize: compact ? 15 : 24, color: FILM.textDim, textShadow: `0 2px 20px ${FILM.spaceEdge}` }}>
          说一句话，产物落在画布或文档里，不在聊天记录里
        </div>
      </div>

      {/* 输入框：写着背后这幅画面的那句话（可灵首屏最值钱的那一处） */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: compact ? 300 : 520,
          transform: 'translateX(-50%)',
          width: compact ? W - 32 : 880,
          minHeight: compact ? 56 : 76,
          borderRadius: 999,
          background: `${FILM.panel}CC`,
          border: `1px solid ${FILM.lineStrong}`,
          backdropFilter: 'blur(14px)',
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 8 : 14,
          padding: compact ? '0 6px 0 8px' : '0 8px 0 10px',
          boxShadow: FILM.shadow,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, padding: compact ? '6px 10px' : '10px 16px', borderRadius: 999, background: FILM.panelRaised, fontSize: compact ? 12 : 15, color: FILM.text, whiteSpace: 'nowrap' }}>
          <Icon size={compact ? 14 : 18} color={FILM.sand} />
          {agent.label}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: compact ? 14 : 20, lineHeight: 1.35, padding: compact ? '8px 0' : 0, color: FILM.text, whiteSpace: compact ? 'normal' : 'nowrap', overflow: 'hidden', minHeight: compact ? 38 : undefined, display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
          {beat.shown}
          {beat.typing && Math.floor(t * 2.2) % 2 === 0 && <span style={{ display: 'inline-block', width: 2, height: compact ? 16 : 22, marginLeft: 3, background: FILM.clay, verticalAlign: 'middle' }} />}
        </span>
        <span
          style={{
            padding: compact ? '10px 14px' : '14px 30px',
            borderRadius: 999,
            background: FILM.brandGradient,
            color: FILM.onBrand,
            fontSize: compact ? 13 : 18,
            fontWeight: 700,
            whiteSpace: 'nowrap',
            transform: `scale(${pressScale})`,
            boxShadow: beat.press > 0 && beat.press < 1 ? `0 0 ${30 * s}px ${FILM.clay}` : 'none',
          }}
        >
          {tr.hero.primaryCta}
        </span>
      </div>

      {/* 右下角：完整片花入口，声音由用户决定 */}
      <div
        style={{
          position: 'absolute',
          right: compact ? 16 : 40,
          bottom: compact ? 24 : 36,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: compact ? '8px 14px 8px 8px' : '10px 20px 10px 10px',
          borderRadius: 999,
          background: `${FILM.panel}B3`,
          border: `1px solid ${FILM.lineStrong}`,
          backdropFilter: 'blur(12px)',
          fontSize: compact ? 12 : 15,
          color: FILM.text,
        }}
      >
        <span style={{ width: compact ? 26 : 34, height: compact ? 26 : 34, borderRadius: 999, background: FILM.text, color: FILM.bg, display: 'grid', placeItems: 'center' }}>
          <Play size={compact ? 12 : 15} style={{ marginLeft: 2 }} />
        </span>
        观看完整片花 · {formatClock(FILM_DURATION)}
        <Volume2 size={compact ? 13 : 16} color={FILM.textDim} />
      </div>
    </div>
  );
}

function draw(t: number) {
  flushSync(() => root.render(<Hero t={t} />));
}

async function settle() {
  document.body.getBoundingClientRect();
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

draw(HERO_LOOP_ENTRY);
window.__film = {
  ready: Promise.all(['700 40px "Noto Sans SC"', '400 20px "Noto Sans SC"', '800 40px Inter'].map((f) => document.fonts.load(f, '让创造自由呼吸说一句话产物落在画布或文档里不在聊天记录里把仓库的目录同步进知识库为新品发布会做一张海报暖色留白进入米多智能体生态平台登录注册观看完整片花产品工作流模型开始视觉创作'))),
  duration: HERO_LOOP_DURATION,
  poster: HERO_LOOP_ENTRY,
  seek: async (t: number) => {
    draw(t);
    await settle();
  },
  renderAudio: async () => '',
};
