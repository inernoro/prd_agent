/**
 * 验收首页第一屏的紧凑条（2026-09-14，落 B 稿）。
 *
 * 上一版紧凑态是把厂房剖面整个缩小：一张小示意图浮在一大片空卡片中间，
 * 屏越宽越难看，用户原话「这个设计可以吗，我看这个完全是看不明白」。
 * 根子是隐喻本身——厂房要占半屏、带标签才读得懂，缩到几百像素又按「少字」
 * 把标签隐去，等于把唯一的解释也拿掉了。
 *
 * 这一版换成「大数字领衔 + 微型图形」：
 *   改动总量 → 拆成三段（没起预览 / 待验收 / 已验完）→ 结论三档 → 项目分布 → 场外报告
 * 数字在任何尺寸下都读得准，图形只做补充，所以不怕宽屏也不怕数据少。
 *
 * 三条纪律：
 * 1. **每段点阵共用同一个分母**（都是 changes 个格子，点亮各自那几个），
 *    所以三段的比例可以直接对看，不需要图例。
 * 2. **点子尺寸随条数分档**：5 条时是 20px 的大方块，71 条时是 5px 的细点。
 *    数据少的时候格子变大而不是画面变空——上一版最大的毛病就在这里。
 * 3. 颜色一律走 token 且 `hsl()` 包裹（token 是 HSL 三元组，裸写整条属性静默失效）。
 */
import type { PipelineOverview, PipelineProjectRow } from '@/lib/api';

export interface CompactStripProps {
  pipeline: PipelineOverview;
  /** 三段拆分，与放大态共用同一套现推口径。 */
  split: { accepted: number; heap: number; undeployed: number };
  orphan: number;
  reclaimed: number;
  onOpenProject: (projectId: string) => void;
  /** 项目垛的悬浮内容，与放大态共用。 */
  projectTip: (p: PipelineProjectRow) => string;
}

export const STRIP_CSS = `
.cs{display:flex;flex-direction:column;gap:16px;border-radius:12px;
  border:1px solid hsl(var(--hairline));background:hsl(var(--card));
  padding:16px 18px;font-variant-numeric:tabular-nums;}
@media (min-width:1024px){
  .cs{flex-direction:row;align-items:stretch;justify-content:space-between;gap:20px;
    height:176px;padding:16px 22px;overflow:hidden;}
}

.cs .z{display:flex;min-width:0;flex-direction:column;justify-content:flex-start;}
.cs .z > :last-child{margin-top:auto;}
.cs .vr{display:none;}
@media (min-width:1024px){
  .cs .vr{display:block;flex:0 0 1px;align-self:stretch;background:hsl(var(--hairline));}
}

.cs .pad{height:10px;flex:0 0 auto;}
.cs .eyebrow{font-size:11px;line-height:13px;letter-spacing:.12em;white-space:nowrap;
  color:hsl(var(--muted-foreground));}
.cs .eyebrow b{font-weight:600;letter-spacing:0;color:hsl(var(--foreground));}

.cs .num{font-weight:600;letter-spacing:-.02em;line-height:1;}
.cs .numbox{height:64px;display:flex;align-items:flex-end;}
.cs .num-xl{font-size:64px;}
.cs .num-l{font-size:40px;}
.cs .t1{color:hsl(var(--hairline-strong));}
.cs .t2{color:hsl(var(--muted-foreground));}
.cs .t3{color:hsl(var(--foreground));}

.cs .z-total{flex:1 1 124px;max-width:180px;}
.cs .rail{display:flex;gap:1px;height:10px;width:100%;}
.cs .rail span{display:block;height:100%;}
.cs .f1{background:hsl(var(--hairline-strong));}
.cs .f2{background:hsl(var(--muted-foreground));}
.cs .f3{background:hsl(var(--foreground));}

.cs .z-stages{flex:1.4 1 432px;max-width:666px;margin-left:-2px;}
.cs .bracket{height:10px;flex:0 0 10px;margin-left:-20px;border-bottom:1px solid hsl(var(--hairline));}
.cs .stagerow{display:flex;gap:18px;width:100%;flex:1 1 auto;align-items:stretch;}
.cs .stage{position:relative;display:flex;min-width:0;flex:1 1 0;flex-direction:column;
  justify-content:space-between;}
.cs .stage .tick{position:absolute;top:-6px;left:0;width:1px;height:6px;background:hsl(var(--hairline));}
.cs .field{display:flex;flex-wrap:wrap;gap:var(--dg);align-content:flex-end;width:100%;overflow:hidden;}
.cs .d{display:block;width:var(--dot);height:var(--dot);border-radius:1px;
  background:hsl(var(--surface-sunken));}

.cs .z-verdict{flex:1 1 140px;max-width:250px;}
.cs .vlist{display:flex;flex-direction:column;gap:7px;}
.cs .vrow{display:flex;align-items:center;gap:7px;}
.cs .chip{flex:0 0 8px;height:8px;border-radius:2px;}
.cs .vlab{flex:0 0 52px;font-size:11px;white-space:nowrap;color:hsl(var(--muted-foreground));}
.cs .vbarw{flex:1 1 auto;min-width:20px;height:8px;border-radius:2px;overflow:hidden;
  background:hsl(var(--surface-sunken));}
.cs .vbar{display:block;height:100%;}
.cs .vnum{flex:0 0 16px;text-align:right;font-size:15px;font-weight:600;}
.cs .c-ok{background:hsl(var(--ok));}
.cs .c-warn{background:hsl(var(--warn));}
.cs .c-bad{background:hsl(var(--bad));}
.cs .n-ok{color:hsl(var(--ok));}
.cs .n-warn{color:hsl(var(--warn));}
.cs .n-bad{color:hsl(var(--bad));}
.cs .n-zero{color:hsl(var(--hairline-strong));}

.cs .z-proj{flex:4 1 300px;min-width:240px;max-width:990px;}
.cs .lead{display:flex;align-items:baseline;gap:8px;margin-top:5px;}
.cs .lead b{font-size:13px;font-weight:600;}
.cs .lead span{font-size:13px;color:hsl(var(--muted-foreground));}
.cs .barrow{display:flex;align-items:flex-end;gap:4px;height:92px;margin-top:5px;
  border-bottom:1px solid hsl(var(--hairline-strong));}
.cs .bar{display:flex;min-width:0;align-items:flex-end;cursor:pointer;}
.cs .track{position:relative;display:block;width:100%;height:92px;overflow:hidden;
  border:1px solid hsl(var(--hairline));border-bottom:none;border-radius:2px 2px 0 0;
  background:hsl(var(--surface-base));}
.cs .track.empty{background:transparent;border-left:1px dotted hsl(var(--hairline-strong));
  border-right:1px dotted hsl(var(--hairline-strong));}
.cs .fill{position:absolute;left:0;right:0;bottom:0;background:hsl(var(--foreground));}
.cs .bar:hover .track,.cs .bar:focus-visible .track{border-color:hsl(var(--foreground));}

.cs .z-side{flex:1 1 106px;max-width:190px;}
.cs .slist{display:flex;flex-direction:column;gap:11px;}
.cs .srow{display:grid;grid-template-columns:auto 1fr;column-gap:8px;row-gap:4px;align-items:baseline;}
.cs .slab{font-size:11px;color:hsl(var(--muted-foreground));}
.cs .snum{font-size:19px;font-weight:600;text-align:right;}
.cs .sbarw{grid-column:1 / -1;height:4px;border-radius:2px;overflow:hidden;
  background:hsl(var(--surface-sunken));}
.cs .sbar{display:block;height:100%;background:hsl(var(--hairline-strong));}

@media (max-width:1340px) and (min-width:1024px){
  .cs{gap:15px;padding:16px 18px;}
  .cs .stagerow{gap:14px;}
  .cs .z-stages{flex:1.4 1 354px;}
  .cs .bracket{margin-left:-15px;}
  .cs .num-xl{font-size:56px;}
  .cs .numbox{height:56px;}
}
`;

/**
 * 点子尺寸随条数分档。
 *
 * 不做「按容器宽高实算」是有意的：容器宽度由 flex 在运行时决定，CSS 算不出来，
 * 要算就得上 ResizeObserver，为一排小方块引一套测量循环不划算。分档表的效果
 * 一样达到了目的——5 条时每格 20px，71 条时 5px，数据少的时候格子变大。
 */
export function dotMetrics(total: number): { dot: number; gap: number; height: number } {
  const n = Math.max(0, Math.floor(total));
  if (n <= 8) return { dot: 20, gap: 3, height: 20 };
  if (n <= 24) return { dot: 12, gap: 2, height: 26 };
  if (n <= 60) return { dot: 7, gap: 2, height: 27 };
  if (n <= 140) return { dot: 5, gap: 2, height: 33 };
  if (n <= 320) return { dot: 4, gap: 1, height: 35 };
  return { dot: 3, gap: 1, height: 36 };
}

/** 一段的点阵：分母恒为总量，点亮自己那几个，其余留成底色。 */
function Field({ total, filled, tone }: { total: number; filled: number; tone: string }): JSX.Element {
  const m = dotMetrics(total);
  const n = Math.max(0, Math.floor(total));
  const lit = Math.max(0, Math.min(n, Math.floor(filled)));
  return (
    <div
      className="field"
      style={{ ['--dot' as string]: `${m.dot}px`, ['--dg' as string]: `${m.gap}px`, height: m.height }}
    >
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < lit ? `d ${tone}` : 'd'} />
      ))}
    </div>
  );
}

function Stage({
  label,
  n,
  total,
  tone,
  hint,
}: { label: string; n: number; total: number; tone: string; hint: string }): JSX.Element {
  return (
    <div className="stage" data-tip={hint}>
      <div className="tick" />
      <div className="eyebrow">{label}</div>
      <div className="numbox">
        <span className={`num num-l ${tone === 'f1' ? 't1' : tone === 'f2' ? 't2' : 't3'}`}>{n}</span>
      </div>
      <Field total={total} filled={n} tone={tone} />
    </div>
  );
}

export function CompactStrip({
  pipeline,
  split,
  orphan,
  reclaimed,
  onOpenProject,
  projectTip,
}: CompactStripProps): JSX.Element {
  const t = pipeline.total;
  const changes = Math.max(0, t.changes);
  const verdicts = [
    { key: 'ok', label: '通过', n: Math.max(0, t.pass) },
    { key: 'warn', label: '原则通过', n: Math.max(0, t.conditional) },
    { key: 'bad', label: '未通过', n: Math.max(0, t.fail) },
  ];
  const vMax = Math.max(1, ...verdicts.map((v) => v.n));
  const projects = pipeline.projects;
  const lead = projects[0];
  const sideMax = Math.max(1, orphan, reclaimed);

  return (
    <div className="cs">
      <div className="z z-total" data-tip={`在途与最近撤下的分支\n共 ${changes} 条`}>
        <div className="pad" />
        <div className="eyebrow">改动</div>
        <div className="numbox">
          <span className="num num-xl">{changes}</span>
        </div>
        <div className="rail">
          <span className="f1" style={{ flex: `${split.undeployed} 0 0`, minWidth: 3 }} />
          <span className="f2" style={{ flex: `${split.heap} 0 0`, minWidth: 3 }} />
          <span className="f3" style={{ flex: `${split.accepted} 0 0`, minWidth: 3 }} />
        </div>
      </div>

      <div className="z z-stages">
        <div className="bracket" />
        <div className="stagerow">
          <Stage
            label="没起预览"
            n={split.undeployed}
            total={changes}
            tone="f1"
            hint={`还没起预览的改动\n${split.undeployed} 条\n连部署这一步都没到`}
          />
          <Stage
            label="待验收"
            n={split.heap}
            total={changes}
            tone="f2"
            hint={`已部署、还没人验的改动\n${split.heap} 条`}
          />
          <Stage
            label="已验完"
            n={split.accepted}
            total={changes}
            tone="f3"
            hint={`跑过验收并归了档的改动\n${split.accepted} 条`}
          />
        </div>
      </div>

      <div className="vr" />

      <div className="z z-verdict">
        <div className="pad" />
        <div className="eyebrow">结论</div>
        <div className="vlist">
          {verdicts.map((v) => (
            <div className="vrow" key={v.key} data-tip={`${v.label}\n${v.n} 条改动验完判了这一档`}>
              <span className={`chip c-${v.key}`} />
              <span className="vlab">{v.label}</span>
              <span className="vbarw">
                <span className={`vbar c-${v.key}`} style={{ width: `${(v.n / vMax) * 100}%` }} />
              </span>
              <span className={`vnum ${v.n ? `n-${v.key}` : 'n-zero'}`}>{v.n}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="vr" />

      <div className="z z-proj">
        <div className="pad" />
        <div className="eyebrow">
          项目 <b>{projects.length}</b>
        </div>
        <div className="lead">
          {lead ? (
            <>
              <b>{lead.projectName}</b>
              <span>{Math.max(0, lead.funnel.changes)}</span>
            </>
          ) : (
            <span>还没有项目</span>
          )}
        </div>
        {/* 宽 ∝ 改动数、底部填充 ∝ 验过比例，于是留白面积正好等于欠验的量。 */}
        <div className="barrow">
          {projects.map((p) => {
            const ch = Math.max(0, p.funnel.changes);
            const acc = Math.max(0, Math.min(ch, p.funnel.accepted));
            return (
              <div
                key={p.projectId}
                className="bar"
                role="button"
                tabIndex={0}
                style={{ flex: ch > 0 ? `${ch} 1 8px` : '0 0 8px' }}
                data-tip={projectTip(p)}
                onClick={() => onOpenProject(p.projectId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenProject(p.projectId);
                  }
                }}
              >
                <span className={ch > 0 ? 'track' : 'track empty'}>
                  {ch > 0 ? <span className="fill" style={{ height: `${(acc / ch) * 100}%` }} /> : null}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="vr" />

      <div className="z z-side">
        <div className="pad" />
        <div className="eyebrow">报告</div>
        <div className="slist">
          <div className="srow" data-tip={`报告没记它验的是谁\n${orphan} 份\n没有 branch / commit / PR，挂不上任何改动`}>
            <span className="slab">无主</span>
            <span className="snum">{orphan}</span>
            <span className="sbarw">
              <span className="sbar" style={{ width: `${(orphan / sideMax) * 100}%` }} />
            </span>
          </div>
          <div className="srow" data-tip={`对应分支已被 CDS 回收\n${reclaimed} 份\n无从核对，是常态不是漏`}>
            <span className="slab">已回收</span>
            <span className="snum">{reclaimed}</span>
            <span className="sbarw">
              <span className="sbar" style={{ width: `${(reclaimed / sideMax) * 100}%` }} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
