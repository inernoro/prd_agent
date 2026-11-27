/* V24（用户：把「/cds 帮我设计一个页面」「/cds 帮我实现 [编号]」放进设计，替换右上角的 CLI，教用户怎么触发技能、走完开发的整个生命周期；
 * 教程要直观：一眼知道这是什么环节、该做什么、会得到什么结果，预期可控、结果也可控）。
 * 一屏一条流水线：六个环节连成一条线，点哪个看哪个（打开时自动走一遍，点了就停）。每个环节固定五块，顺序不变：
 *   你说（一句 /cds，能复制）→ 会发生什么（三步，程序做）→ 你会得到（结果的样子）→ 怎么算完成（可核对）→ 没做到会怎样（被拦在哪）。
 * 说法和 CDS 技能的路由表一致（技能 reference/menu-intents.json，由程序核对）。稿件「···」里只列和这份稿件有关的三步，编号自动填好。 */
import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, CalendarRange, Check, CheckCircle2, ClipboardCheck, Code2, Copy, PenTool, Rocket, Sparkles, TriangleAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { copyTextToClipboard } from '@/lib/clipboard';
import { reducedSurfaceMotion } from '@/lib/surfaceMotion';
import { AGENT_SETUP_PATH } from '../../../../src/shared/agent-setup';
import { designImplementationTargetVersion, type DesignEntry } from '../../../../src/shared/design-workspace';
import menuIntents from '../../../../../.claude/skills/cds/reference/menu-intents.json';
import './design-skills.css';

type DesignBuildPrompt = { version: number; command: string; path: string };
const pendingBuildHint = '请有权评审人先在「更多稿件操作」中选择「定为实施基线」。';

export function designBuildPrompt(entry: Pick<DesignEntry, 'id' | 'projectId' | 'frozen' | 'upgrade'>): DesignBuildPrompt | null {
  const version = designImplementationTargetVersion(entry);
  if (version === null) return null;
  const query = new URLSearchParams({ project: entry.projectId, design: entry.id, version: String(version), tab: 'delivery' });
  return { version, command: `/cds-build 帮我实现 ${entry.id} V${version}`, path: `/design?${query}` };
}

export function CopyDesignBuildPrompt({ prompt, compact = false }: {
  prompt: DesignBuildPrompt | null; compact?: boolean;
}) {
  const [manual, setManual] = useState('');
  const [copiedAt, setCopiedAt] = useState(0);
  const copied = copiedAt > 0;
  useEffect(() => {
    if (!copiedAt) return;
    const timer = window.setTimeout(() => setCopiedAt(0), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedAt]);

  async function copy() {
    if (!prompt) return;
    setCopiedAt(0);
    const link = new URL(prompt.path, window.location.origin);
    const text = `${prompt.command}\n${link.href}`;
    try {
      await copyTextToClipboard(text);
      setCopiedAt(Date.now());
    } catch {
      setManual(text);
    }
  }

  const Icon = copied ? Check : Copy;
  return <>
    <button type="button" className={compact ? 'ep-button ep-icon-button' : 'ep-button dw-copy-build'}
      data-action={compact ? 'copy-skill' : 'copy-build-prompt'} data-copied={copied || undefined}
      aria-label={compact && prompt ? `复制「${prompt.command}」` : '复制实现提示词'}
      title={prompt ? `${copied ? '已复制' : '复制'} V${prompt.version} 实现提示词` : pendingBuildHint}
      disabled={prompt === null} onClick={() => void copy()}>
      <Icon aria-hidden="true" />
      {!compact && <><span className="dw-copy-build-label">复制实现提示词</span><small>{prompt ? `V${prompt.version}` : '待定稿'}</small></>}
    </button>
    <span role="status" className="sr-only">{prompt && copied ? `已复制 V${prompt.version} 实现提示词` : ''}</span>
    {manual && <Dialog open onOpenChange={open => { if (!open) setManual(''); }}>
      <DialogContent>
        <DialogTitle>实现提示词</DialogTitle>
        <DialogDescription>浏览器未允许自动复制。请选择下方文字手动复制。</DialogDescription>
        <textarea className="w-full rounded border bg-background p-2 text-sm" aria-label="实现提示词" rows={4}
          readOnly value={manual} onFocus={event => event.currentTarget.select()} />
      </DialogContent>
    </Dialog>}
  </>;
}

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
    steps: ['读设计接入清单和框架', '出原型，写目标和验收项', '运行发布门禁 G-01 至 G-11，通过后私有发布'],
    result: { title: 'DSN-0043 · V1', badge: '私有', lines: ['目标 6 条 · 验收项 24 条', '交接清单.md 已生成'] },
    done: ['设计库出现这份稿件', '门禁通过，验收计划与覆盖已校验', '交接清单按目标生成'], ifNot: '门禁不过不发布，按规则编号修完再发', where: '设计' },
  { key: 'build', stage: '实现', icon: Code2, who: '实现方', say: prompts.build,
    steps: ['有权评审人定实施基线或锁定升级目标', '实现方逐条回复固定版本的验收项，检查并应用源码差异', '用演示数据模式自测'],
    result: { title: '交接回复', badge: '24/24', lines: ['接受 23 · 说明理由 1', '提交 a1b2c3 已部署到预览'] },
    done: ['每个验收项都有回复', '偏离源码差异的文件写了理由'], ifNot: '先请评审人锁定版本，再开始实现。没回复的编号视为没有接受', where: '设计 · 交付 · 反馈' },
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
const designFollowUpPrompts = (id: string, version: number) => [
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

type SkillGuideProps = { designId: string; version: number; buildPrompt: DesignBuildPrompt | null; handoffBlocks?: boolean; onAccess?: never }
  | { designId?: undefined; projectId: string; onAccess: () => void };

export function DesignSkillsMenu({ linked, dismiss, projectId, onAccess }: {
  linked: boolean; dismiss: () => void; projectId: string; onAccess: () => void;
}) {
  const [open, setOpen] = useState(linked);
  return <details className="ep-new dw-skills" data-design-panel="cli" open={linked || undefined}
    onToggle={event => {
      const visible = event.currentTarget.open;
      setOpen(visible);
      if (!visible && linked) dismiss();
    }}>
    <summary className="ep-button" data-action="design-skills"><Sparkles />用技能</summary>
    {(open || linked) && <SkillGuide projectId={projectId} onAccess={onAccess} />}
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
    <ol className="dw-sg-mini">
      <li>
        <span className="dw-sg-tag">实现</span>
        {props.buildPrompt ? <>
          <div><code>{props.buildPrompt.command}</code><small>实现方 · 按实施与验收清单执行</small></div>
          <CopyDesignBuildPrompt key={props.buildPrompt.path} prompt={props.buildPrompt} compact />
        </> : <div>
          <strong>待定稿</strong>
          <small>{props.handoffBlocks ? '请先查看交接检查。通过后请有权评审人选择「定为实施基线」。' : pendingBuildHint}</small>
        </div>}
      </li>
      {designFollowUpPrompts(props.designId, props.version).map(step => <li key={step.stage}>
        <span className="dw-sg-tag">{step.stage}</span>
        <div><code>{step.say}</code><small>{step.who} · {step.what}</small>{message(step.say)}</div>
        {copyButton(step.say)}
      </li>)}
    </ol>
  </div>;
  const stage = lifecycle[index];
  const Icon = stage.icon;
  const buildAccess = stage.key === 'build';
  const buildSetupQuery = new URLSearchParams({ target: 'existing', project: props.projectId, skills: 'cds-build' });
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
    <footer>
      <small>{buildAccess ? '首次使用时，把接入说明的链接发给智能体。' : '第一次用，先给智能体授权。'}</small>
      {buildAccess ? <a className="ep-button shrink-0 whitespace-nowrap" href={`${AGENT_SETUP_PATH}?${buildSetupQuery}`} target="_blank" rel="noreferrer">接入 Agent</a>
        : <button className="ep-button" type="button" onClick={props.onAccess}>接入 Agent</button>}
    </footer>
  </div>;
}
