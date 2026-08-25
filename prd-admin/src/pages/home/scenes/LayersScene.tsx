import type { ReactNode } from 'react';
import { SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * LayersScene —— 三层一体：MAP / LLMGW / CDS。
 *
 * 每一块画的不是三句口号，而是**那一层真实那一屏的切片**：
 *   MAP    = 启动器的「台面」（状态行 + 命令条 + 近 7 日 + 常去 + 在办）；
 *   LLMGW  = 系统运维页（配置概览计数 + 运行闸门 + 容器拓扑折叠行）；
 *   CDS    = 分支卡网格（分支名 + 状态徽标 / 元信息 / 操作条，构建中时环境光斜掠整卡）。
 *
 * 一层一支墨色：陶土 16 / 钢青 196 / 钢蓝 214。
 */

const clay = inkTone(SCENE_HUE.clay);
const steel = inkTone(SCENE_HUE.steel);
const slate = inkTone(SCENE_HUE.slate);
const pine = inkTone(SCENE_HUE.pine);
const amber = inkTone(SCENE_HUE.amber);

const TILE_ICONS = [
  'M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2v-1a2 2 0 0 1 2-2h1c1.1 0 2-.9 2-2a10 10 0 0 0-7-11zM7.5 11.5h.01M12 7.5h.01M16.5 9.5h.01',
  'M18.4 2.6a2 2 0 0 1 3 3L9 18l-4 1 1-4zM14 6l4 4',
  'M4 5a2 2 0 0 1 2-2h11v18H6a2 2 0 0 1-2-2zM17 3v18',
  'M8 6h8v3a4 4 0 0 1-8 0zM6 13h12M4 10h2M18 10h2M5 17h3M16 17h3',
];
const TILE_HUES = [SCENE_HUE.clay, SCENE_HUE.pine, SCENE_HUE.olive, 32];

const OK_ICON = 'M20 6L9 17l-5-5';
const WARN_ICON = 'M12 8v5M12 17v.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z';
const BRANCH_ICON = 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9';

/** 卡片左上角的品类渗光（每层一支色）。 */
function tint(hue: number) {
  return `radial-gradient(150px 100px at 12% 0%, hsla(${hue}, 54%, 58%, 0.09) 0%, transparent 100%), ${SCENE.tile}`;
}

export function LayersScene() {
  const { t } = useLanguage();
  const s = t.scenes.layers;

  return (
    <SceneFrame
      id="scene-layers"
      hue={SCENE_HUE.clay}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div className="relative grid grid-cols-1 lg:grid-cols-3 gap-3.5" style={{ padding: '14px' }}>
        {/* ── MAP：工位与团队 ── */}
        <LayerCard hue={SCENE_HUE.clay} name="MAP" role={s.map.role} meta={s.map.meta} lead={s.map.lead} tone={clay}>
          <div className="flex flex-col flex-1 min-h-0">
            <SceneMono size={13}>{s.map.statusLine}</SceneMono>

            <div className="flex items-center gap-2" style={{ marginTop: '9px' }}>
              <div
                className="flex-1 min-w-0 flex items-center"
                style={{
                  height: '32px',
                  borderRadius: '9px',
                  background: SCENE.tileHi,
                  border: `1px solid ${SCENE.line}`,
                  padding: '0 10px',
                  fontSize: '12px',
                  color: SCENE.inkFaint,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                {s.map.command}
              </div>
              <SceneMono size={13.5} color={SCENE.inkDim} style={{ whiteSpace: 'nowrap' }}>
                {s.map.usage}
              </SceneMono>
            </div>

            <GroupLabel>{s.map.frequentLabel}</GroupLabel>
            <div className="grid grid-cols-2 gap-1.5" style={{ marginTop: '7px' }}>
              {s.map.frequent.map((label, i) => (
                <span
                  key={label}
                  className="flex items-center gap-2 overflow-hidden"
                  style={{
                    height: '40px',
                    borderRadius: '9px',
                    padding: '0 10px',
                    background: tint(TILE_HUES[i]),
                    border: `1px solid ${SCENE.edge}`,
                    fontSize: '11.5px',
                    color: SCENE.inkSoft,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <SceneIcon d={TILE_ICONS[i]} size={14} style={{ color: `hsl(${TILE_HUES[i]} 54% 62%)` }} />
                  {label}
                </span>
              ))}
            </div>

            <GroupLabel>{s.map.activeLabel}</GroupLabel>
            <div className="flex flex-col gap-1.5" style={{ marginTop: '6px' }}>
              {s.map.active.map((task, i) => (
                <span key={task.title} className="flex items-center gap-2" style={{ fontSize: '11.5px', color: SCENE.inkMid }}>
                  <span
                    className="block w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ background: i === 0 ? amber.solid : pine.solid }}
                  />
                  <span className="min-w-0 truncate">{task.title}</span>
                  <SceneMono size={13} className="ml-auto shrink-0" color={SCENE.inkGhost}>
                    {task.at}
                  </SceneMono>
                </span>
              ))}
            </div>
          </div>
        </LayerCard>

        {/* ── LLMGW：人事与算力 ── */}
        <LayerCard hue={SCENE_HUE.steel} name="LLMGW" role={s.gateway.role} meta={s.gateway.meta} lead={s.gateway.lead} tone={steel}>
          <div className="flex flex-col flex-1 min-h-0">
            <div className="grid grid-cols-3 gap-1.5">
              {s.gateway.counts.map((item) => (
                <span
                  key={item.label}
                  className="flex flex-col gap-0.5"
                  style={{
                    borderRadius: '9px',
                    background: SCENE.ghost,
                    border: `1px solid ${SCENE.hair}`,
                    padding: '8px 9px',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: '19px',
                      fontWeight: 500,
                      letterSpacing: '-0.02em',
                      color: SCENE.ink,
                    }}
                  >
                    {item.value}
                  </span>
                  <span style={{ fontSize: '10.5px', color: SCENE.inkDim, whiteSpace: 'nowrap' }}>{item.label}</span>
                </span>
              ))}
            </div>

            <GroupLabel>{s.gateway.gatesLabel}</GroupLabel>
            <div className="flex flex-col gap-1.5" style={{ marginTop: '7px' }}>
              {s.gateway.gates.map((gate, i) => {
                const ok = i < 2;
                const tone = ok ? pine : amber;
                return (
                  <span
                    key={gate.title}
                    className="flex items-center gap-2"
                    style={{
                      padding: '7px 9px',
                      borderRadius: '8px',
                      background: tone.faint,
                      border: `1px solid ${tone.border}`,
                      fontSize: '11.5px',
                      color: SCENE.inkSoft,
                    }}
                  >
                    <SceneIcon d={ok ? OK_ICON : WARN_ICON} size={13} strokeWidth={2} style={{ color: tone.bright }} />
                    <span className="min-w-0 truncate">{gate.title}</span>
                    <SceneMono size={13} className="ml-auto shrink-0" color={tone.bright}>
                      {gate.state}
                    </SceneMono>
                  </span>
                );
              })}
            </div>

            {/* 容器拓扑：静态参考，默认收起 */}
            <div
              className="flex items-center gap-2 mt-auto"
              style={{
                paddingTop: '10px',
                fontSize: '11.5px',
                color: SCENE.inkDim,
                borderTop: `1px solid ${SCENE.hair}`,
              }}
            >
              <SceneIcon d="M9 6l6 6-6 6" size={12} strokeWidth={2} />
              {s.gateway.topology}
            </div>
          </div>
        </LayerCard>

        {/* ── CDS：交付与验收 ── */}
        <LayerCard
          hue={SCENE_HUE.slate}
          name="CDS"
          role={s.cds.role}
          meta={s.cds.meta}
          lead={s.cds.lead}
          tone={slate}
          bare
        >
          <div className="flex flex-col flex-1 min-h-0 gap-2">
            {s.cds.branches.map((branch, i) => {
              const busy = i === 0;
              const badge = busy ? amber : pine;
              return (
                <div
                  key={branch.name}
                  className="relative overflow-hidden"
                  style={{
                    borderRadius: '11px',
                    border: `1px solid ${busy ? amber.border : SCENE.edge}`,
                    background: SCENE.inset,
                    padding: '11px 12px',
                  }}
                >
                  {/* AI 活跃时的环境光：光带缓慢斜掠整卡 */}
                  {busy && (
                    <span
                      className="absolute pointer-events-none map-scene-anim"
                      style={{
                        top: '-20%',
                        bottom: '-20%',
                        left: 0,
                        width: '46%',
                        background: `linear-gradient(104deg, transparent, hsla(${SCENE_HUE.slate}, 54%, 72%, 0.10) 50%, transparent)`,
                        animation: 'mapSceneSweep 3.4s linear infinite',
                      }}
                    />
                  )}

                  <div className="relative flex items-center gap-2">
                    <SceneIcon d={BRANCH_ICON} size={13} strokeWidth={1.9} style={{ color: SCENE.inkFaint }} />
                    <span className="min-w-0 truncate" style={{ fontSize: '12px', color: SCENE.ink }}>
                      {branch.name}
                    </span>
                    <span
                      className="ml-auto flex items-center gap-1 shrink-0"
                      style={{
                        height: '19px',
                        padding: '0 7px',
                        borderRadius: '5px',
                        fontSize: '10px',
                        background: badge.soft,
                        color: badge.bright,
                      }}
                    >
                      <span className="block w-[5px] h-[5px] rounded-full" style={{ background: badge.bright }} />
                      {branch.status}
                    </span>
                  </div>

                  <SceneMono
                    size={13}
                    className="relative flex flex-col gap-1"
                    style={{ marginTop: '8px', letterSpacing: '0.06em' }}
                  >
                    <span>{branch.meta1}</span>
                    <span>{branch.meta2}</span>
                  </SceneMono>

                  <div className="relative flex items-center gap-1.5" style={{ marginTop: '9px' }}>
                    {s.cds.branchActions.map((label, ai) => (
                      <span
                        key={label}
                        className="flex items-center"
                        style={{
                          height: '23px',
                          padding: '0 9px',
                          borderRadius: '6px',
                          fontSize: '11px',
                          background: ai === 0 ? slate.soft : SCENE.ghost,
                          border: `1px solid ${ai === 0 ? slate.border : SCENE.edge}`,
                          color: ai === 0 ? slate.bright : SCENE.inkMid,
                        }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* 预览地址由 CDS 下发，不由前端拼（CLAUDE.md §11 的 SSOT） */}
            <div className="mt-auto" style={{ fontSize: '11.5px', color: SCENE.inkFaint, lineHeight: 1.6 }}>
              {s.cds.footnote}
            </div>
          </div>
        </LayerCard>
      </div>
    </SceneFrame>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <SceneMono
      size={13}
      color={SCENE.inkGhost}
      style={{ display: 'block', marginTop: '12px', letterSpacing: '0.16em', textTransform: 'uppercase' }}
    >
      {children}
    </SceneMono>
  );
}

function LayerCard({
  hue,
  name,
  role,
  meta,
  lead,
  tone,
  bare = false,
  children,
}: {
  hue: number;
  name: string;
  role: string;
  meta: string;
  lead: string;
  tone: ReturnType<typeof inkTone>;
  /** CDS 那块的内容本身就是一叠卡片，不再套一层内框 */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        borderRadius: '14px',
        border: `1px solid ${SCENE.edge}`,
        background: tint(hue),
        padding: '18px',
        minHeight: '404px',
      }}
    >
      <div className="flex items-baseline gap-2.5">
        <span
          style={{ fontFamily: 'var(--font-display)', fontSize: '15px', fontWeight: 500, color: tone.bright }}
        >
          {name}
        </span>
        <span style={{ fontSize: '12.5px', color: SCENE.inkMid }}>{role}</span>
        <SceneMono size={13} className="ml-auto shrink-0" color={SCENE.inkGhost}>
          {meta}
        </SceneMono>
      </div>
      <div style={{ marginTop: '7px', fontSize: '12px', lineHeight: 1.7, color: SCENE.inkDim }}>{lead}</div>

      <div
        className="flex flex-col flex-1 min-h-0"
        style={
          bare
            ? { marginTop: '14px' }
            : {
                marginTop: '14px',
                borderRadius: '11px',
                border: `1px solid ${SCENE.hair}`,
                background: SCENE.inset,
                padding: '12px',
              }
        }
      >
        {children}
      </div>
    </div>
  );
}
