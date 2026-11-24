/* V24（用户：把「/cds 帮我设计一个页面」「/cds 帮我实现 [编号]」放进设计，替换右上角的 CLI，教用户怎么触发技能、走完开发的整个生命周期；
 * 教程要直观：一眼知道这是什么环节、该做什么、会得到什么结果，预期可控、结果也可控）。
 * 一屏一条流水线：六个环节连成一条线，点哪个看哪个（打开时自动走一遍，点了就停）。每个环节固定五块，顺序不变：
 *   你说（一句 /cds，能复制）→ 会发生什么（三步，程序做）→ 你会得到（结果的样子）→ 怎么算完成（可核对）→ 没做到会怎样（被拦在哪）。
 * 说法和 CDS 技能的路由表一致（技能 reference/menu-intents.json，由程序核对）。稿件「···」里只列和这份稿件有关的三步，编号自动填好。 */
import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, BookOpen, CalendarRange, Check, CheckCircle2, ClipboardCheck, Code2, Copy, PenTool, Rocket, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { copyTextToClipboard } from '@/lib/clipboard';
import { reducedSurfaceMotion } from '@/lib/surfaceMotion';
import menuIntents from '../../../../../.claude/skills/cds/reference/menu-intents.json';
import './design-skills.css';

const menuPhrases = new Set(menuIntents.menus.flatMap(menu => menu.intents.flatMap(intent => intent.say)));
function prompt(phrase: string) {
  if (!menuPhrases.has(phrase)) throw new Error(`CDS 技能路由表缺少「${phrase}」`);
  return `/cds ${phrase}`;
}
const prompts = {
  plan: prompt('排进落地计划'), design: prompt('帮我设计一个页面'), build: prompt('帮我实现 DSN-xxx'),
  accept: prompt('跑 DSN-xxx 的验收'), release: prompt('发布到 xx 环境'), monitor: prompt('加一个 xx 的监控'),
  revise: prompt('改 xx 模块的设计'),
};

type Stage = {
  key: string; stage: string; icon: LucideIcon; who: string; say: string; steps: [string, string, string];
  result: { title: string; badge: string; lines: string[] }; done: string[]; ifNot: string; where: string;
};
export const lifecycle: Stage[] = [
  { key: 'plan', stage: '规划', icon: CalendarRange, who: '负责人', say: prompts.plan,
    steps: ['读需求和相关的决策、债务', '在时间线上建落地计划，挂上编号关联', '写清到期日和卡在哪'],
    result: { title: 'PLN-0007 成员批量导出', badge: '截止 12-03', lines: ['挡住：ADR-021 待定', '关联：ATL-0270'] },
    done: ['时间线上能看到这条计划', '和决策、债务有编号关联'], ifNot: '没有编号关联，就不会出现在因果里', where: '工程规划' },
  { key: 'design', stage: '设计', icon: PenTool, who: '设计方', say: prompts.design,
    steps: ['读设计接入清单和框架', '出原型，写目标和验收项', '过门禁 G-01 到 G-09，私有发布'],
    result: { title: 'DSN-0043 · V1', badge: '私有', lines: ['目标 6 条 · 验收项 24 条', '交接清单.md 已生成'] },
    done: ['设计库出现这份稿件', '门禁通过，自检全绿', '交接清单按目标生成'], ifNot: '门禁不过不发布，按规则编号修完再发', where: '设计' },
  { key: 'build', stage: '实现', icon: Code2, who: '实现方', say: prompts.build,
    steps: ['按交接清单逐条回复验收项编号', '定实施基线，整份应用源码差异', '用演示数据模式自测'],
    result: { title: '交接回复', badge: '24/24', lines: ['接受 23 · 说明理由 1', '提交 a1b2c3 已部署到预览'] },
    done: ['每个验收项都有回复', '偏离源码差异的文件写了理由'], ifNot: '没回复的编号视为没有接受', where: '设计 · 交付 · 反馈' },
  { key: 'accept', stage: '验收', icon: ClipboardCheck, who: '实现方跑，设计方复核', say: prompts.accept,
    steps: ['CDS 按提交、同一份演示数据截图', '程序重算测量，逐项写结论', '设计方独立重跑，一致才签收'],
    result: { title: '验收 · DSN-0043 V1', badge: '可签收', lines: ['目标达成 6/6', '验收项 24/24 通过'] },
    done: ['每处证据带数据集、提交、由 CDS 截', '设计方复核一致'], ifNot: '缺一个字段就不算证据，签收按钮不可用', where: '设计 · 验收' },
  { key: 'release', stage: '发布', icon: Rocket, who: '负责人', say: prompts.release,
    steps: ['预检：构建、配置、回滚点', '发布，留下证据', '出问题一键回滚'],
    result: { title: '发布 #128 · 生产', badge: '已上线', lines: ['可回滚到 #127', '证据已归档'] },
    done: ['发布记录有证据', '有可用的回滚点'], ifNot: '预检不过不发布', where: '发布中心' },
  { key: 'monitor', stage: '监控', icon: Activity, who: '负责人', say: prompts.monitor,
    steps: ['选指标和阈值', '接到监控中心', '超阈值变成反馈，回到规划'],
    result: { title: '设计页首屏 < 2 秒', badge: '监控中', lines: ['告警 → 反馈 → 规划', '最近 7 天 0 次超阈值'] },
    done: ['监控中心能看到这条', '告警能变成下一个需求'], ifNot: '没有阈值就不会告警', where: '监控中心' },
];
export const designHandoffPrompts = (id: string, version: number) => [
  { stage: '实现', who: '实现方', say: prompts.build.replace('DSN-xxx', `${id} V${version}`), what: '按实施与验收清单执行' },
  { stage: '验收', who: '实现方跑，设计方复核', say: prompts.accept.replace('DSN-xxx', `${id} V${version}`), what: '程序逐项判定，由设计方独立复跑' },
  { stage: '续版', who: '设计方', say: prompts.revise.replace('xx 模块', `${id} V${version} `), what: '在原稿件读反馈并提交新版本' },
];

function useCopy() {
  const [result, setResult] = useState<{ text: string; copied: boolean }>();
  const sequence = useRef(0);
  const copy = async (text: string) => {
    const attempt = ++sequence.current;
    setResult(undefined);
    try {
      await copyTextToClipboard(text);
      if (attempt === sequence.current) setResult({ text, copied: true });
    } catch {
      if (attempt === sequence.current) setResult({ text, copied: false });
    }
  };
  return { result, copy };
}

type SkillGuideProps = { designId: string; version: number; onAccess?: never }
  | { designId?: undefined; version?: never; onAccess: () => void };

export function DesignSkillsMenu({ linked, dismiss, onAccess }: { linked: boolean; dismiss: () => void; onAccess: () => void }) {
  const [open, setOpen] = useState(linked);
  return <details className="ep-new dw-skills" data-design-panel="cli" open={linked || undefined}
    onToggle={event => {
      const visible = event.currentTarget.open;
      setOpen(visible);
      if (!visible && linked) dismiss();
    }}>
    <summary className="ep-button" data-action="design-skills"><BookOpen />用技能</summary>
    {(open || linked) && <SkillGuide onAccess={onAccess} />}
  </details>;
}

export function SkillGuide(props: SkillGuideProps) {
  const { result, copy } = useCopy();
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(() => !props.designId && typeof window !== 'undefined' && !reducedSurfaceMotion());
  const playing = auto && index < lifecycle.length - 1;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setIndex(index + 1), 4000);
    return () => window.clearTimeout(timer);
  }, [index, playing]);
  const message = (say: string) => result?.text === say && <small role="status" className="dw-sg-copy-status" data-result={result.copied ? 'copied' : 'failed'}>
    {result.copied ? '已复制' : '复制失败，请选择指令文字手动复制。'}
  </small>;
  const copyButton = (say: string) => <button type="button" className="ep-button ep-icon-button"
    aria-label={`复制「${say}」`} data-action="copy-skill" onClick={() => void copy(say)}>
    {result?.text === say && result.copied ? <Check /> : <Copy />}
  </button>;
  if (props.designId !== undefined) return <div className="dw-skill-guide" data-compact>
    <header><strong>让智能体接着做</strong><small>在接入的智能体里说这句话</small></header>
    <ol className="dw-sg-mini">{designHandoffPrompts(props.designId, props.version).map(step => <li key={step.stage}>
      <span className="dw-sg-tag">{step.stage}</span>
      <div><code>{step.say}</code><small>{step.who} · {step.what}</small>{message(step.say)}</div>
      {copyButton(step.say)}
    </li>)}</ol>
  </div>;
  const stage = lifecycle[index];
  const Icon = stage.icon;
  return <div className="dw-skill-guide" data-stage={stage.key}>
    <header><strong>用 /cds 走完整个开发流程</strong><small>在 Claude Code 或接入的智能体里说一句话；每一步做什么、得到什么、怎么算完成都在这里</small></header>
    <ol className="dw-sg-flow" aria-label="开发流程">{lifecycle.map((row, i) => { const RowIcon = row.icon;
      return <li key={row.key} data-state={i < index ? 'past' : i === index ? 'current' : 'next'}>
        <button type="button" aria-current={i === index ? 'step' : undefined} onClick={() => { setAuto(false); setIndex(i); }}>
          <span className="dw-sg-node"><RowIcon /></span><strong>{row.stage}</strong><small>{row.who}</small>
        </button>
        {i === index && playing && <i className="dw-sg-timer" aria-hidden="true" key={index} />}
      </li>; })}</ol>
    <section className="dw-sg-card" key={stage.key} aria-live="polite">
      <div className="dw-sg-say">
        <h5><Icon />{stage.stage} · 你说</h5>
        <div className="dw-sg-bubble"><code>{stage.say}</code>{copyButton(stage.say)}</div>
        {message(stage.say)}
        <h5>会发生什么</h5>
        <ol className="dw-sg-steps">{stage.steps.map((step, i) => <li key={i} style={{ animationDelay: `${i * 160}ms` }}><b>{i + 1}</b>{step}</li>)}</ol>
      </div>
      <ArrowRight className="dw-sg-arrow" aria-hidden="true" />
      <div className="dw-sg-get">
        <h5>你会得到</h5>
        <div className="dw-sg-result" aria-label="示例结果"><header><strong>{stage.result.title}</strong><span>{stage.result.badge}</span></header>
          {stage.result.lines.map(line => <p key={line}>{line}</p>)}<small>在「{stage.where}」里看</small></div>
        <h5>怎么算完成</h5>
        <ul className="dw-sg-done">{stage.done.map(item => <li key={item}><CheckCircle2 />{item}</li>)}</ul>
        <p className="dw-sg-ifnot"><TriangleAlert />没做到：{stage.ifNot}</p>
      </div>
    </section>
    <footer><small>第一次用，先给智能体授权。</small><button className="ep-button" type="button" onClick={props.onAccess}>接入 Agent</button></footer>
  </div>;
}
