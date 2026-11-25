/**
 * 模板画面（作品本身的配色与版式）。
 * 这是唯一允许写作品配色的文件：作品配色与 MAP 界面主题互不影响（框架规则 R-02 的例外，范围只到本文件）。
 * 画面按容器宽度等比缩放（cqw），同一份代码用于模板缩略图、分镜、成片预览和发布页。
 */
import type { CSSProperties, ReactNode } from 'react';
import type { FrameKey, QcWebSection } from './types';

const hand = "'Kaiti SC', 'STKaiti', 'KaiTi', 'Songti SC', serif";
const sans = "Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif";
const mono = "'JetBrains Mono', ui-monospace, monospace";

function Stage({ style, children, label }: { style: CSSProperties; children: ReactNode; label: string }) {
  return (
    <div role="img" aria-label={label} style={{ width: '100%', aspectRatio: '16 / 9', containerType: 'inline-size', position: 'relative', overflow: 'hidden', ...style }}>
      {children}
    </div>
  );
}

const marker = (color: string): CSSProperties => ({ background: `linear-gradient(transparent 58%, ${color} 58%, ${color} 92%, transparent 92%)`, padding: '0 0.5cqw' });

/* ---------- 视觉笔记：点阵纸、手绘线、暖黄强调 ---------- */
function VisualNote({ scene }: { scene: number }) {
  const paper: CSSProperties = { backgroundColor: '#FBF7EC', backgroundImage: 'radial-gradient(#D6CCB4 1px, transparent 1.4px)', backgroundSize: '2.4cqw 2.4cqw', color: '#2B2A26', fontFamily: hand };
  const card = (n: number, title: string, sub: string, rot: number, filled?: boolean) => (
    <div style={{ border: '0.32cqw solid #2B2A26', borderRadius: '2.2cqw 1.2cqw 2.6cqw 1cqw', padding: '2.4cqw', transform: `rotate(${rot}deg)`, background: '#FFFDF6' }}>
      <div style={{ width: '5cqw', height: '5cqw', borderRadius: '50%', border: '0.3cqw solid #2B2A26', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2.8cqw', background: filled ? '#F4C84A' : 'transparent' }}>{n}</div>
      <div style={{ fontSize: '3.2cqw', marginTop: '1.6cqw' }}>{title}</div>
      <div style={{ fontFamily: sans, fontSize: '1.7cqw', color: '#6B6455', marginTop: '0.8cqw' }}>{sub}</div>
    </div>
  );
  if (scene === 2) {
    return (
      <Stage label="视觉笔记 · 三个重点" style={paper}>
        <div style={{ position: 'absolute', left: '7cqw', top: '6cqw', fontSize: '4.6cqw' }}>先记住<span style={marker('#F4C84A')}>三件事</span></div>
        <div style={{ position: 'absolute', left: '7cqw', right: '7cqw', top: '19cqw', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '3cqw' }}>
          {card(1, '先读目标', '这次要解决谁的问题', -1.2, true)}
          {card(2, '再画边界', '哪些这次不做', 0.8)}
          {card(3, '最后对验收', '怎样算真的做完', -0.6)}
        </div>
      </Stage>
    );
  }
  if (scene === 3) {
    const box = (text: string, fill: string, r: string) => (
      <div style={{ border: '0.32cqw solid #2B2A26', borderRadius: r, padding: '2cqw 3cqw', fontSize: '3cqw', background: fill }}>{text}</div>
    );
    return (
      <Stage label="视觉笔记 · 先读目标" style={paper}>
        <div style={{ position: 'absolute', left: '7cqw', top: '6cqw', fontFamily: sans, fontSize: '1.9cqw', letterSpacing: '0.08em', color: '#8A8170' }}>习惯一</div>
        <div style={{ position: 'absolute', left: '7cqw', top: '10cqw', fontSize: '5.2cqw' }}>先读<span style={marker('#F4C84A')}>目标</span>，再看方案</div>
        <div style={{ position: 'absolute', left: '7cqw', top: '26cqw', display: 'flex', alignItems: 'center', gap: '2cqw' }}>
          {box('用户遇到的问题', '#FFFDF6', '1.6cqw 2.4cqw 1.2cqw 2cqw')}
          <svg viewBox="0 0 80 30" aria-hidden="true" style={{ width: '9cqw', height: '3.4cqw' }} fill="none" stroke="#2B2A26" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 16 C 24 10, 48 20, 72 14" /><path d="M62 6 l 10 8 l -11 7" /></svg>
          {box('要达成的结果', '#F4C84A', '2.4cqw 1.2cqw 2cqw 1.6cqw')}
        </div>
        <div style={{ position: 'absolute', left: '7cqw', top: '42cqw', fontFamily: sans, fontSize: '1.8cqw', color: '#6B6455' }}>评审第一分钟，只问一句：做完之后，谁的什么会变好？</div>
      </Stage>
    );
  }
  return (
    <Stage label="视觉笔记 · 片头" style={paper}>
      <div style={{ position: 'absolute', left: '7cqw', top: '6cqw', fontFamily: sans, fontSize: '1.9cqw', letterSpacing: '0.08em', color: '#8A8170' }}>团队手册 · 第 2 讲</div>
      <div style={{ position: 'absolute', left: '7cqw', top: '17cqw', fontSize: '7cqw', lineHeight: 1.15 }}>需求评审的<br /><span style={marker('#F4C84A')}>三个习惯</span></div>
      <div style={{ position: 'absolute', left: '7cqw', top: '39cqw', fontSize: '2.8cqw', color: '#5E584C' }}>给新同事的 90 秒速览</div>
      <svg viewBox="0 0 200 120" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', right: '7cqw', top: '13cqw', width: '30cqw', height: '22cqw' }} fill="none" stroke="#2B2A26" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 30 C 60 18, 140 22, 182 34 C 186 70, 180 92, 176 104 C 120 110, 60 108, 22 100 C 16 70, 14 48, 18 30 Z" />
        <path d="M40 52 H 150" /><path d="M40 70 H 128" /><path d="M40 88 H 110" />
        <path d="M156 78 l 8 8 l 14 -18" stroke="#C9A12C" strokeWidth="3" />
      </svg>
    </Stage>
  );
}

/* ---------- 白板速讲：白底、蓝色马克笔，一屏一个结论 ---------- */
function Whiteboard({ scene }: { scene: number }) {
  const base: CSSProperties = { background: '#F7F8FA', color: '#1F2A44', fontFamily: sans };
  const lines = scene === 2 ? ['目标', '边界', '验收'] : scene === 3 ? ['先问：谁会变好', '再问：不做什么'] : [];
  return (
    <Stage label="白板速讲" style={base}>
      <div style={{ position: 'absolute', left: '8cqw', top: '10cqw', fontSize: scene === 1 ? '6.4cqw' : '4.8cqw', fontWeight: 700, color: '#2257D6' }}>{scene === 1 ? '三条可以立刻做的改进' : scene === 2 ? '只记三件事' : '评审的第一分钟'}</div>
      <div style={{ position: 'absolute', left: '8cqw', top: scene === 1 ? '21cqw' : '18cqw', width: '30cqw', height: '0.7cqw', borderRadius: '0.4cqw', background: '#2257D6' }} />
      {lines.map((t, i) => (
        <div key={t} style={{ position: 'absolute', left: '8cqw', top: `${25 + i * 7}cqw`, display: 'flex', alignItems: 'center', gap: '2cqw', fontSize: '3.2cqw' }}>
          <span style={{ width: '4cqw', height: '4cqw', borderRadius: '50%', border: '0.35cqw solid #2257D6', color: '#2257D6', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '2.2cqw', fontWeight: 700 }}>{i + 1}</span>{t}
        </div>
      ))}
      {scene === 1 && <div style={{ position: 'absolute', left: '8cqw', top: '27cqw', fontSize: '2.6cqw', color: '#4A5568' }}>白板速讲 · 复盘与汇报</div>}
    </Stage>
  );
}

/* ---------- 深色讲义：深底等宽，技术约定 ---------- */
function DarkNotes({ scene }: { scene: number }) {
  return (
    <Stage label="深色讲义" style={{ background: '#1B2430', color: '#E6EDF3', fontFamily: mono }}>
      <div style={{ position: 'absolute', left: '8cqw', top: '10cqw', fontSize: '2.2cqw', color: '#7DD3C0' }}>{`0${scene} / 约定`}</div>
      <div style={{ position: 'absolute', left: '8cqw', top: '15cqw', fontSize: '5cqw', fontWeight: 500 }}>{scene === 1 ? '接口命名约定' : scene === 2 ? '名词用复数' : '动作用动词'}</div>
      <div style={{ position: 'absolute', left: '8cqw', top: '27cqw', padding: '2cqw 3cqw', borderRadius: '1cqw', background: '#243042', fontSize: '2.4cqw', color: '#A5B4C8' }}>
        {scene === 3 ? 'POST /runs/{id}/retry' : 'GET /api/quick-creation/works'}
      </div>
    </Stage>
  );
}

/* ---------- 网页：导读长页 ---------- */
function GuidePage({ scene }: { scene: number }) {
  return (
    <Stage label="导读长页" style={{ background: '#FFFFFF', color: '#1C1B19', fontFamily: sans }}>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '22cqw 1fr' }}>
        <div style={{ background: '#F4F1EA', padding: '4cqw 3cqw', display: 'flex', flexDirection: 'column', gap: '1.6cqw', fontSize: '1.7cqw', color: '#6B655A' }}>
          <div style={{ fontWeight: 700, color: '#1C1B19', fontSize: '1.9cqw' }}>目录</div>
          {['三个重点', '先读目标', '再画边界', '最后对验收'].map((t, i) => (
            <div key={t} style={{ color: i === scene - 1 ? '#B4532A' : undefined, fontWeight: i === scene - 1 ? 600 : 400 }}>{t}</div>
          ))}
        </div>
        <div style={{ padding: '5cqw 6cqw' }}>
          <div style={{ fontSize: '1.6cqw', letterSpacing: '0.1em', color: '#B4532A' }}>团队手册 · 第 2 讲</div>
          <div style={{ fontSize: '4.6cqw', fontWeight: 700, marginTop: '1.4cqw', lineHeight: 1.2 }}>需求评审的三个习惯</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '1.6cqw', marginTop: '3cqw' }}>
            {['先读目标', '再画边界', '最后对验收'].map((t, i) => (
              <div key={t} style={{ border: '0.18cqw solid #E6E0D4', borderRadius: '1cqw', padding: '1.8cqw', fontSize: '1.9cqw' }}>
                <div style={{ color: '#B4532A', fontWeight: 700 }}>{`0${i + 1}`}</div>{t}
              </div>
            ))}
          </div>
          <div style={{ marginTop: '3cqw', height: '1cqw', width: '80%', background: '#ECE7DD', borderRadius: '0.5cqw' }} />
          <div style={{ marginTop: '1.4cqw', height: '1cqw', width: '64%', background: '#ECE7DD', borderRadius: '0.5cqw' }} />
        </div>
      </div>
    </Stage>
  );
}

/* ---------- 网页：卡片速览 ---------- */
function CardDigest() {
  return (
    <Stage label="卡片速览" style={{ background: '#F2F5F9', color: '#16202E', fontFamily: sans }}>
      <div style={{ position: 'absolute', left: '6cqw', top: '5cqw', fontSize: '3.6cqw', fontWeight: 700 }}>需求评审的三个习惯</div>
      <div style={{ position: 'absolute', left: '6cqw', right: '6cqw', top: '14cqw', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '2cqw' }}>
        {['先读目标', '再画边界', '最后对验收'].map((t, i) => (
          <div key={t} style={{ background: '#FFFFFF', borderRadius: '1.4cqw', padding: '2.4cqw', boxShadow: '0 0.4cqw 1.6cqw rgba(22,32,46,.08)' }}>
            <div style={{ width: '4cqw', height: '4cqw', borderRadius: '1cqw', background: ['#2F6FEB', '#13A57A', '#E5832B'][i], color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '2cqw' }}>{i + 1}</div>
            <div style={{ fontSize: '2.4cqw', fontWeight: 600, marginTop: '1.6cqw' }}>{t}</div>
            <div style={{ height: '0.9cqw', width: '90%', background: '#E3E8EF', borderRadius: '0.5cqw', marginTop: '1.4cqw' }} />
            <div style={{ height: '0.9cqw', width: '70%', background: '#E3E8EF', borderRadius: '0.5cqw', marginTop: '0.8cqw' }} />
          </div>
        ))}
      </div>
    </Stage>
  );
}

export function TemplateFrame({ frame, scene = 1 }: { frame: FrameKey; scene?: number }) {
  if (frame === 'whiteboard') return <Whiteboard scene={scene} />;
  if (frame === 'dark-notes') return <DarkNotes scene={scene} />;
  if (frame === 'guide-page') return <GuidePage scene={scene} />;
  if (frame === 'card-digest') return <CardDigest />;
  return <VisualNote scene={scene} />;
}

/** 网页成品的正文（作品配色）。activeAnchor 用于从重点定位到对应一节。 */
export function TemplatePageBody({ sections, activeAnchor }: { sections: QcWebSection[]; activeAnchor?: string }) {
  return (
    <div style={{ maxHeight: 220, overflowY: 'auto', padding: '16px 20px', color: '#1C1B19', fontFamily: sans, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sections.map(s => (
        <section key={s.anchor} id={`qc-${s.anchor}`} style={{ borderRadius: 6, padding: 8, outline: activeAnchor === s.anchor ? '2px solid #B4532A' : 'none', outlineOffset: 2 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{s.title}</h3>
          <p style={{ margin: '4px 0 0', fontSize: 12.5, lineHeight: 1.8, color: '#4A463F' }}>{s.body}</p>
        </section>
      ))}
    </div>
  );
}
