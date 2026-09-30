import ReactDOM from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@/styles/tailwind.css';
import '@/styles/tokens.css';
import '@/styles/globals.css';

import { LanguageProvider } from '@/pages/home/contexts/LanguageContext';
import { FILM } from '@/pages/home/film/filmPalette';
import { HERO_LOOP_DURATION, HERO_LOOP_ENTRY, HeroLoop, heroLoopBeat } from '@/pages/home/film/HeroLoop';
import { translations } from '@/pages/home/i18n/landing';
import { HERO_SKIN_DEFAULT, HeroStage, type HeroSkin } from '@/pages/home/sections/HeroStage';

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
/** 手机版式对比稿：a = 正式版（HeroStage），b / c / d 只在样片里，拍板后再决定进不进正式代码 */
const VARIANT = (q.get('variant') || 'a') as 'a' | 'b' | 'c' | 'd';
const hero = translations.zh.hero;

/**
 * 配色对比稿（2026-09-30 用户：「整个系统的配色总是差点高级感」）。?skin=a|b|c|d，只在样片里。
 *   a 现状：陶土三段渐变按钮 + 暖桃色标题 + 星系按文档类型七彩
 *   b 素：黑白灰为主，陶土只留在光标上（Apple 发布片的做法：强调色只落一处）
 *   c 陶：全屏只用陶土一个色相，按钮改实色，星系换成同色系的深浅
 *   d 冷：白按钮 + 冷银星系，陶土完全退场
 */
const SKINS: Record<string, HeroSkin> = {
  a: HERO_SKIN_DEFAULT,
  b: {
    cta: '#F5F5F7', ctaFg: '#1D1D1F', title: '#F5F5F7', accent: '#D97757', chipIcon: '#A1A1A6', dot: '#F5F5F7',
    galaxy: { hub: '#E8E8ED', leaf: '#8E8E93', core: '#F5F5F7' },
  },
  c: {
    cta: '#D97757', ctaFg: '#1A120D', title: 'linear-gradient(180deg, #FFFFFF 0%, #F4E3D7 100%)', accent: '#D97757', chipIcon: '#D97757', dot: '#D97757',
    galaxy: { hub: '#F2BFA3', leaf: '#8A6A5C', core: '#D97757' },
  },
  d: {
    cta: '#F5F5F7', ctaFg: '#0B0B0C', title: '#F5F5F7', accent: '#A9C8FF', chipIcon: '#A9C8FF', dot: '#A9C8FF',
    galaxy: { hub: '#A9C8FF', leaf: '#5B7896', core: '#A9C8FF' },
  },
};
const SKIN = SKINS[q.get('skin') || 'a'] ?? HERO_SKIN_DEFAULT;
const serif = '"Noto Sans SC", Inter, sans-serif';

function PromptRow({ t, dense }: { t: number; dense?: boolean }) {
  const beat = heroLoopBeat(t, hero.loopPrompts);
  const caret = beat.typing && Math.floor(t * 2.2) % 2 === 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: dense ? 50 : 56, padding: '6px 6px 6px 14px', borderRadius: 18, background: `${FILM.panel}C7`, border: `1px solid ${FILM.lineStrong}`, backdropFilter: 'blur(18px)' }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 1.4, color: FILM.text }}>
        <span style={{ color: FILM.sand, marginRight: 8, fontSize: 12 }}>{hero.loopAgents[beat.shot]}</span>
        {beat.shown}
        <span style={{ display: 'inline-block', width: 2, height: 14, marginLeft: 3, verticalAlign: 'middle', background: FILM.clay, opacity: caret ? 1 : 0 }} />
      </span>
      <span style={{ padding: '10px 14px', borderRadius: 14, background: FILM.brandGradient, color: FILM.onBrand, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{hero.primaryCta}</span>
    </div>
  );
}

/** B 杂志封面：作品铺满，大标题靠左压在底部三分之一，输入框在最下 */
function VariantB({ t }: { t: number }) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <HeroLoop t={t} w={W} h={H} compact />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: H * 0.5, background: `linear-gradient(180deg, ${FILM.spaceEdge}00, ${FILM.spaceEdge}F2 55%)` }} />
      <div style={{ position: 'absolute', left: 22, right: 22, bottom: 34 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.24em', color: FILM.gray, marginBottom: 12 }}>MAP · 米多智能体生态平台</div>
        <div style={{ fontFamily: serif, fontSize: 50, fontWeight: 800, lineHeight: 1.02, letterSpacing: '-0.045em', background: FILM.titleGradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          让创造，
          <br />
          自由呼吸
        </div>
        <div style={{ marginTop: 12, marginBottom: 22, fontSize: 14, lineHeight: 1.6, color: FILM.textDim, maxWidth: 290 }}>{hero.tagline}</div>
        <PromptRow t={t} />
      </div>
    </div>
  );
}

/** C 画框：作品装进居中的圆角画框，画框下像展签一样写着那句提示词 */
function VariantC({ t }: { t: number }) {
  const beat = heroLoopBeat(t, hero.loopPrompts);
  const fw = W - 36;
  const fh = Math.round(fw * 1.12);
  return (
    <div style={{ position: 'absolute', inset: 0, background: FILM.bg }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 84, textAlign: 'center' }}>
        <div style={{ fontFamily: serif, fontSize: 34, fontWeight: 800, letterSpacing: '-0.04em', background: FILM.titleGradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{hero.title}</div>
      </div>
      <div style={{ position: 'absolute', left: 18, top: 150, width: fw, height: fh, borderRadius: 28, overflow: 'hidden', border: `1px solid ${FILM.lineStrong}`, boxShadow: `${FILM.shadow}, 0 0 80px ${FILM.clay}22` }}>
        <HeroLoop t={t} w={fw} h={fh} compact />
      </div>
      <div style={{ position: 'absolute', left: 26, right: 26, top: 150 + fh + 18, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, background: FILM.brandGradient }} />
        <div>
          <div style={{ fontSize: 11, letterSpacing: '0.2em', color: FILM.gray }}>{hero.loopAgents[beat.shot]} · 一句话生成</div>
          <div style={{ marginTop: 6, fontSize: 16, lineHeight: 1.5, color: FILM.text, minHeight: 48 }}>“{beat.shown}”</div>
        </div>
      </div>
      <div style={{ position: 'absolute', left: 18, right: 18, bottom: 28, display: 'flex', gap: 10 }}>
        <span style={{ flex: 1, textAlign: 'center', padding: '15px 0', borderRadius: 16, background: FILM.brandGradient, color: FILM.onBrand, fontSize: 15, fontWeight: 700 }}>{hero.primaryCta}</span>
        <span style={{ padding: '15px 18px', borderRadius: 16, border: `1px solid ${FILM.lineStrong}`, color: FILM.text, fontSize: 14 }}>片花 0:57</span>
      </div>
    </div>
  );
}

/** D 底部抽屉：作品满屏，标题、提示词、按钮全收进底部一块磨砂面板 */
function VariantD({ t }: { t: number }) {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <HeroLoop t={t} w={W} h={H + 120} compact />
      <div style={{ position: 'absolute', left: 10, right: 10, bottom: 10, padding: '22px 18px 18px', borderRadius: 30, background: `${FILM.panel}B8`, border: `1px solid ${FILM.lineStrong}`, backdropFilter: 'blur(24px) saturate(150%)', boxShadow: FILM.shadow }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: FILM.lineStrong, margin: '-8px auto 16px' }} />
        <div style={{ fontFamily: serif, fontSize: 30, fontWeight: 800, letterSpacing: '-0.04em', color: FILM.text }}>{hero.title}</div>
        <div style={{ marginTop: 8, marginBottom: 18, fontSize: 13.5, lineHeight: 1.6, color: FILM.textDim }}>{hero.tagline}</div>
        <PromptRow t={t} dense />
        <div style={{ marginTop: 14, textAlign: 'center', fontSize: 12.5, color: FILM.gray }}>观看完整片花 · 0:57 · 有声</div>
      </div>
    </div>
  );
}
const NAV = ['产品', 'Agent', '工作流', '模型', '开始', '文档'];

const mount = document.getElementById('film');
if (!mount) throw new Error('#film missing');
mount.style.width = `${W}px`;
mount.style.height = `${H}px`;
document.body.style.width = `${W}px`;
document.body.style.height = `${H}px`;
const root = ReactDOM.createRoot(mount);

function Hero({ t }: { t: number }) {
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: 'Inter, "Noto Sans SC", sans-serif', color: FILM.text }}>
      {VARIANT === 'a' && (
        <LanguageProvider>
          <HeroStage t={t} skin={SKIN} />
        </LanguageProvider>
      )}
      {VARIANT === 'b' && <VariantB t={t} />}
      {VARIANT === 'c' && <VariantC t={t} />}
      {VARIANT === 'd' && <VariantD t={t} />}

      {/* 导航：首页的导航在 LandingPage 里，样片页照着画一条，只为截图时位置对得上 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: compact ? 56 : 72, display: 'flex', alignItems: 'center', padding: compact ? '0 16px' : '0 40px', gap: 14 }}>
        <span style={{ width: compact ? 30 : 38, height: compact ? 30 : 38, borderRadius: 10, background: SKIN.cta, color: SKIN.ctaFg, display: 'grid', placeItems: 'center', fontSize: compact ? 10 : 12, fontWeight: 800 }}>MAP</span>
        <span style={{ fontSize: compact ? 14 : 17, fontWeight: 600 }}>米多智能体生态平台</span>
        {!compact && (
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 44, fontSize: 15, color: FILM.textDim }}>
            {NAV.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        )}
        {compact && <span style={{ flex: 1 }} />}
        <span style={{ padding: compact ? '7px 14px' : '10px 20px', borderRadius: 999, background: SKIN.cta, color: SKIN.ctaFg, fontSize: compact ? 13 : 15, fontWeight: 600 }}>登录 / 注册</span>
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
