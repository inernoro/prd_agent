import { SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { Reveal } from '../components/Reveal';
import { useLanguage } from '../contexts/LanguageContext';
import { HERO_GRADIENT, HERO_GRADIENT_FG } from '../sections/HeroSection';

/**
 * StartScene —— 从这里开始：三步 + 三端 + 收口。
 *
 * 取代了原来的「三步，从想法到产物」+「把整个 Agent 平台带到你的桌面」+「最终 CTA」三幕。
 * 那三幕讲的是同一件事的三半（怎么开始、在哪用、来吧），分开讲既占地方又断气。
 *
 * 这一幕没有节拍器：它是收口前的实用信息，不需要演，需要一眼读完。
 * 前面五幕已经演够了，连着再演一遍反而腻。
 */

const clay = inkTone(SCENE_HUE.clay);
const pine = inkTone(SCENE_HUE.pine);

const SURFACE_ICONS = [
  'M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM8 21h8M12 17v4',
  'M4 4h16v12H4zM2 20h20M9 8h6',
  'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1M11 18h2',
];

interface StartSceneProps {
  onGetStarted?: () => void;
}

export function StartScene({ onGetStarted }: StartSceneProps) {
  const { t } = useLanguage();
  const s = t.tail.start;
  const c = t.tail.closing;

  return (
    <SceneFrame
      id="scene-start"
      hue={SCENE_HUE.pine}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      {/*
       * 三步与三端做成等高的两栏，收口另起一条通栏 ——
       * 上一版把收口塞进左栏，左栏 655px、右栏 390px，右下角空出 270px 的洞。
       * 两栏各自 250px 上下，抽掉收口就天然齐平（content-fills-canvas）。
       */}
      <div className="relative flex flex-col gap-2.5" style={{ padding: '16px' }}>
        <div className="flex flex-col lg:flex-row gap-4">
          {/* 左：三步。序号大、动作短，读完就知道自己要干嘛 */}
          <div className="flex-1 min-w-0 flex flex-col gap-2.5">
            {s.steps.map((step, i) => (
              <Reveal key={step.title} delay={i * 120} offset={14} duration={1400}>
                <div
                  className="flex items-start gap-3.5"
                  style={{
                    padding: '15px 16px',
                    borderRadius: '12px',
                    background: SCENE.tile,
                    border: `1px solid ${SCENE.edge}`,
                  }}
                >
                  <span
                    className="flex items-center justify-center shrink-0"
                    style={{
                      width: '30px', height: '30px', borderRadius: '9px',
                      background: clay.soft, border: `1px solid ${clay.border}`, color: clay.bright,
                      fontFamily: 'var(--font-display)', fontSize: '13px', fontWeight: 500,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block" style={{ fontSize: '13.5px', color: SCENE.ink }}>{step.title}</span>
                    <span className="block" style={{ marginTop: '4px', fontSize: '12px', lineHeight: 1.7, color: SCENE.inkDim }}>
                      {step.desc}
                    </span>
                  </span>
                </div>
              </Reveal>
            ))}
          </div>

          {/* 右：三端。同一套账号同一份数据，这句话要有三块东西撑着 */}
          <div className="lg:w-[320px] lg:shrink-0 flex flex-col gap-2.5">
            {s.surfaces.map((surface, i) => (
              <Reveal key={surface.name} delay={i * 120 + 80} offset={14} duration={1400}>
                <div
                  className="flex items-start gap-3"
                  style={{
                    padding: '15px 16px',
                    borderRadius: '12px',
                    background: `radial-gradient(140px 90px at 12% 0%, ${pine.faint} 0%, transparent 100%), ${SCENE.tile}`,
                    border: `1px solid ${SCENE.edge}`,
                  }}
                >
                  <span
                    className="flex items-center justify-center shrink-0"
                    style={{ width: '30px', height: '30px', borderRadius: '9px', background: pine.faint, color: pine.solid }}
                  >
                    <SceneIcon d={SURFACE_ICONS[i]} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span style={{ fontSize: '13px', color: SCENE.ink }}>{surface.name}</span>
                      <span
                        className="ml-auto flex items-center gap-1 shrink-0"
                        style={{
                          height: '18px', padding: '0 7px', borderRadius: '5px', fontSize: '10px',
                          background: pine.soft, color: pine.bright,
                        }}
                      >
                        <span className="block w-1 h-1 rounded-full" style={{ background: pine.bright }} />
                        {surface.state}
                      </span>
                    </span>
                    <span className="block" style={{ marginTop: '4px', fontSize: '11.5px', lineHeight: 1.65, color: SCENE.inkDim }}>
                      {surface.desc}
                    </span>
                    {/*
                      * 说「可用」就得给得到它的路。桌面端不像网页那样打开就用，
                      * 原来那条「去下载」随旧的下载幕一起被删了，卡片却还挂着「可用」——
                      * 顺着导航「开始」进来的人看到一个拿不到的承诺。这条链接补回那一步。
                      */}
                    {surface.href && (
                      <a
                        href={surface.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1"
                        style={{ marginTop: '6px', fontSize: '11px', color: pine.bright, textDecoration: 'none' }}
                      >
                        {surface.hrefLabel}
                        <SceneIcon d="M7 17L17 7M9 7h8v8" size={11} strokeWidth={1.9} />
                      </a>
                    )}
                  </span>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        {/* 收口通栏：读完三步怎么开始，紧接着就是开始的按钮 */}
        <Reveal delay={360} offset={14} duration={1400}>
          <div
            className="flex flex-col gap-3"
            style={{ marginTop: '2px', padding: '20px', borderRadius: '12px', background: SCENE.tileHi, border: `1px solid ${SCENE.edge}` }}
          >
            <SceneMono className="flex items-center gap-2" style={{ letterSpacing: '0.18em', textTransform: 'uppercase' }}>
              <span className="block w-[5px] h-[5px] rounded-full" style={{ background: clay.solid }} />
              {c.eyebrow}
            </SceneMono>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.25rem, 2vw, 1.6rem)',
                fontWeight: 500,
                letterSpacing: '-0.015em',
                lineHeight: 1.4,
                color: SCENE.ink,
              }}
            >
              {c.title}
            </div>
            <div style={{ fontSize: '12.5px', lineHeight: 1.8, color: SCENE.inkMid, maxWidth: '48em' }}>{c.description}</div>
            <div className="flex items-center gap-2.5 flex-wrap" style={{ marginTop: '2px' }}>
              <button
                type="button"
                onClick={onGetStarted}
                className="flex items-center gap-2 transition-transform duration-200 hover:scale-[1.02]"
                style={{
                  height: '38px', padding: '0 20px', borderRadius: '999px',
                  background: HERO_GRADIENT, color: HERO_GRADIENT_FG,
                  fontFamily: 'var(--font-display)', fontSize: '13.5px', fontWeight: 500, cursor: 'pointer',
                }}
              >
                {c.primary}
                <SceneIcon d="M5 12h14M13 6l6 6-6 6" size={14} strokeWidth={2} />
              </button>
              <a
                // 锚点必须落在真实存在的 id 上。`#scene-roster` 是早期那一幕的名字，
                // 那一幕后来被照 /ai-toolbox 重画的百宝箱取代了，锚点没跟着改——
                // 点了只换地址栏，页面纹丝不动。守卫见 landingAnchors.test.ts
                href="#agents"
                className="flex items-center gap-2"
                style={{
                  height: '38px', padding: '0 18px', borderRadius: '999px',
                  background: SCENE.ghost, border: `1px solid ${SCENE.edge}`,
                  color: SCENE.inkMid, fontSize: '13.5px', fontFamily: 'var(--font-display)',
                }}
              >
                {c.secondary}
              </a>
            </div>
            <div style={{ fontSize: '11.5px', color: SCENE.inkFaint, lineHeight: 1.7 }}>{c.footnote}</div>
          </div>
        </Reveal>
      </div>
    </SceneFrame>
  );
}
