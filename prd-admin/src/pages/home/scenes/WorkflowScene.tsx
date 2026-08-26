import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import type { SceneVariant } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { enterAt, useSceneTimeline } from './useSceneTimeline';
import { useLanguage } from '../contexts/LanguageContext';
import type { CapsuleKind } from '../i18n/landing';

/**
 * WorkflowScene —— 工作流画布，照 `pages/workflow-agent/` 那一套画的缩微版。
 *
 * 对着真实实现取的形：
 *   - 「舱」是画布上的节点，圆角 14px、左侧 32px 图标方、名字 12px、
 *     下面一行执行态（等待 / 运行中 + 进度条 / 完成）→ `CapsuleNode.tsx`
 *   - 舱库分触发 / 处理 / 流程控制 / 输出 四类           → `capsuleRegistry.tsx`
 *     的 CAPSULE_CATEGORIES，每类的舱数就是那份注册表里的真实条数
 *   - 链上这六个舱逐个取自模板「TAPD 缺陷采集与分析」   → `workflowTemplates.ts`
 *
 * 演一次执行：点运行 → 舱一个接一个从等待转运行中（进度条跑）再转完成，
 * 连线跟着依次点亮。这一幕要讲的就是「它自己往下走，没人守着」。
 */

/** 每个舱亮起各占一拍，外加就位与收尾 —— 8 拍 */
const HOLDS = [1900, 1200, 1200, 1200, 1200, 1200, 1200, 2100];
const B = { idle: 0, run: 1 } as const;
/** 第 n 个舱在第 (B.run + n) 拍开始跑，第 (B.run + n + 1) 拍就算完成 */
const firstNodeBeat = B.run;

/**
 * 拍子有 8 个、旁白只有 4 句：这里显式写清哪一拍念哪一句。
 * 不写这张表的话 BeatNarration 会拿 beats[7] 取到 undefined 落到最后一句，
 * 而底下的进度点会一个都不亮——句子看着对、点全灭，又是一处"读到的不是生效的值"。
 */
// 末句「跑完了」只能落在最后一拍：第 6 拍时最后一个舱还在跑，提前念就成了
// 旁白说完了、画面还在转——又一处"判据与被判据对象的时序对不上"。
const NARRATION_AT = [0, 1, 1, 2, 2, 2, 2, 3];

/** 四类舱各一支墨色，与舱库图例共用一份，别让画布和图例各配各的色。 */
const KIND_HUE: Record<CapsuleKind, number> = {
  trigger: SCENE_HUE.clay,
  processor: SCENE_HUE.steel,
  control: SCENE_HUE.amber,
  output: SCENE_HUE.pine,
};

const KIND_ICON: Record<CapsuleKind, string> = {
  trigger: 'M13 2L4 14h6l-1 8 9-12h-6z',
  processor: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v4l3 2',
  control: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9v6a3 3 0 0 1-3 3h-3',
  output: 'M12 3v12M8 11l4 4 4-4M4 19h16',
};

/** 完成态统一走松绿，别在 JSX 里现算 */
const pineBright = inkTone(SCENE_HUE.pine).bright;

type NodeState = 'waiting' | 'running' | 'done';

/** 这一拍第 i 个舱处在什么状态 —— 判定只此一处，进度条、勾、连线全读它。 */
function nodeStateAt(index: number, beat: number): NodeState {
  const startsAt = firstNodeBeat + index;
  if (beat < startsAt) return 'waiting';
  if (beat === startsAt) return 'running';
  return 'done';
}

export function WorkflowScene({ variant }: { variant?: SceneVariant }) {
  const { t } = useLanguage();
  const s = t.tail.workflow;
  const { beat, ref } = useSceneTimeline(HOLDS);
  const started = beat >= B.run;
  const allDone = s.nodes.every((_, i) => nodeStateAt(i, beat) === 'done');

  return (
    <SceneFrame
      id="scene-workflow"
      variant={variant}
      hue={SCENE_HUE.steel}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div ref={ref} className="relative">
        {/* 画布顶栏：模板名 + 运行按钮，照编辑器那一条 */}
        <div
          className="flex items-center gap-2.5 flex-wrap"
          style={{ padding: '12px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
        >
          <SceneIcon d="M4 5a2 2 0 0 1 2-2h3l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" size={14} />
          <span style={{ fontSize: '12.5px', color: SCENE.ink }}>{s.templateName}</span>
          <SceneMono size={13} color={SCENE.inkGhost}>{s.nodes.length}</SceneMono>
          <span
            className="ml-auto flex items-center gap-1.5"
            style={{
              height: '27px', padding: '0 12px', borderRadius: '8px', fontSize: '12px',
              background: started ? inkTone(SCENE_HUE.pine).soft : inkTone(SCENE_HUE.clay).soft,
              border: `1px solid ${started ? inkTone(SCENE_HUE.pine).border : inkTone(SCENE_HUE.clay).border}`,
              color: started ? inkTone(SCENE_HUE.pine).bright : inkTone(SCENE_HUE.clay).bright,
              transition: 'background .4s ease, border-color .4s ease, color .4s ease',
            }}
          >
            <SceneIcon
              d={allDone ? 'M20 6L9 17l-5-5' : started ? 'M8 5v14l11-7z' : 'M8 5v14l11-7z'}
              size={11}
              strokeWidth={2.2}
            />
            {allDone ? s.doneLabel : started ? s.runningLabel : s.runLabel}
          </span>
        </div>

        <div className="flex flex-col lg:flex-row" style={{ minHeight: '300px' }}>
          {/* 左：舱库。真实编辑器左侧就是这个，按四类分组、每类标着有多少种舱 */}
          <div
            className="lg:w-[186px] lg:shrink-0 flex lg:flex-col gap-2 flex-wrap"
            style={{ padding: '14px 16px', borderRight: `1px solid ${SCENE.hair}` }}
          >
            <SceneMono size={13} color={SCENE.inkGhost} className="lg:mb-0.5 w-full" style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}>
              {s.libraryLabel}
            </SceneMono>
            {s.categories.map((cat, i) => {
              const tone = inkTone(KIND_HUE[cat.kind]);
              return (
                <span
                  key={cat.label}
                  className="flex items-center gap-2 flex-1"
                  style={{
                    padding: '8px 10px', borderRadius: '9px',
                    background: SCENE.tile, border: `1px solid ${SCENE.edge}`,
                    ...enterAt(beat, B.idle, { rise: 6, delay: i * 80 }),
                  }}
                >
                  <span
                    className="flex items-center justify-center shrink-0"
                    style={{ width: '22px', height: '22px', borderRadius: '7px', background: tone.faint, color: tone.solid }}
                  >
                    <SceneIcon d={KIND_ICON[cat.kind]} size={12} />
                  </span>
                  <span style={{ fontSize: '11.5px', color: SCENE.inkMid, whiteSpace: 'nowrap' }}>{cat.label}</span>
                  <SceneMono size={12} color={SCENE.inkGhost} className="ml-auto">{cat.count}</SceneMono>
                </span>
              );
            })}
          </div>

          {/* 右：画布。点阵底 + 一条竖着串下来的舱链 */}
          <div
            className="flex-1 min-w-0 relative"
            style={{
              padding: '16px',
              backgroundImage: SCENE.canvasDots,
              backgroundSize: '15px 15px',
            }}
          >
            <div className="flex flex-col lg:flex-row gap-4">
              {/* 舱链：真实画布上的节点是 180-240px 宽的小卡，不是通栏长条 */}
              <div className="flex flex-col lg:w-[360px] lg:shrink-0">
              {s.nodes.map((node, i) => {
                const tone = inkTone(KIND_HUE[node.kind]);
                const state = nodeStateAt(i, beat);
                const running = state === 'running';
                const done = state === 'done';
                return (
                  <div key={node.name} className="flex flex-col">
                    {/* 连线：上一个舱跑完了才点亮，跟着执行往下走 */}
                    {i > 0 && (
                      <span className="flex items-center" style={{ paddingLeft: '19px', height: '18px' }}>
                        <span
                          className="block"
                          style={{
                            width: '2px', height: '100%',
                            background: state === 'waiting' ? SCENE.edge : tone.solid,
                            opacity: state === 'waiting' ? 1 : 0.75,
                            transition: 'background .5s ease, opacity .5s ease',
                          }}
                        />
                      </span>
                    )}
                    <div
                      className="flex items-start gap-2.5"
                      style={{
                        padding: '10px 12px',
                        borderRadius: '14px',
                        background: running ? tone.soft : SCENE.tile,
                        border: `1px solid ${running ? tone.border : done ? SCENE.edgeStrong : SCENE.edge}`,
                        opacity: state === 'waiting' && started ? 0.55 : 1,
                        transition: 'background .45s ease, border-color .45s ease, opacity .45s ease',
                        ...enterAt(beat, B.idle, { rise: 8, delay: i * 70 }),
                      }}
                    >
                      <span
                        className="flex items-center justify-center shrink-0"
                        style={{ width: '30px', height: '30px', borderRadius: '10px', background: tone.faint, color: tone.solid }}
                      >
                        <SceneIcon d={KIND_ICON[node.kind]} size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 flex-wrap">
                          <span style={{ fontSize: '12.5px', color: SCENE.ink }}>{node.name}</span>
                          <span
                            className="flex items-center gap-1 shrink-0"
                            style={{
                              height: '17px', padding: '0 6px', borderRadius: '5px', fontSize: '10px',
                              background: done ? inkTone(SCENE_HUE.pine).soft : running ? tone.soft : SCENE.tileHi,
                              color: done ? inkTone(SCENE_HUE.pine).bright : running ? tone.bright : SCENE.inkGhost,
                              transition: 'background .4s ease, color .4s ease',
                            }}
                          >
                            {done && <SceneIcon d="M20 6L9 17l-5-5" size={9} strokeWidth={2.6} />}
                            {done ? s.doneLabel : running ? s.runningLabel : s.waitingLabel}
                          </span>
                        </span>
                        <span className="block" style={{ marginTop: '3px', fontSize: '11px', lineHeight: 1.6, color: SCENE.inkDim }}>
                          {node.detail}
                        </span>
                        {/* 进度条只在这个舱正在跑的时候占位，跟真实 capsule-progress-bar 一样 */}
                        <span
                          className="block overflow-hidden"
                          style={{
                            marginTop: running ? '7px' : '0px',
                            height: running ? '3px' : '0px',
                            borderRadius: '999px',
                            background: SCENE.inset,
                            transition: 'height .3s ease, margin-top .3s ease',
                          }}
                        >
                          <span
                            className="block map-scene-anim"
                            style={{
                              width: '38%', height: '100%', borderRadius: '999px', background: tone.solid,
                              animation: running ? 'mapSceneSweep 1.1s cubic-bezier(.5,0,.5,1) infinite' : undefined,
                            }}
                          />
                        </span>
                      </span>
                    </div>
                  </div>
                );
              })}
              </div>

              {/*
                * 右：本次执行的日志。真实编辑器右侧就是这块（ExecutionDetailPanel），
                * 每个舱跑完打一行「完成 (2.3s)，产出 N 个产物」——这里逐字照那个措辞。
                * 加它有两个理由：一是真页面就有，二是不加的话画布右半边整片空着。
                */}
              <div
                className="flex-1 min-w-0 flex flex-col gap-1.5 rounded-xl"
                style={{ padding: '12px 14px', background: SCENE.inset, border: `1px solid ${SCENE.hair}` }}
              >
                <SceneMono size={13} color={SCENE.inkGhost} style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}>
                  {s.runPanelLabel}
                </SceneMono>
                {!started && (
                  <span style={{ fontSize: '11.5px', color: SCENE.inkGhost, marginTop: '4px' }}>—</span>
                )}
                {s.nodes.map((node, i) => {
                  const st = nodeStateAt(i, beat);
                  if (st === 'waiting') return null;
                  const tone = inkTone(KIND_HUE[node.kind]);
                  const line = st === 'done'
                    ? s.logDone.replace('{d}', node.secs).replace('{n}', String(node.artifacts))
                    : s.logStart;
                  return (
                    <span
                      key={node.name}
                      className="flex items-baseline gap-2 map-scene-anim"
                      style={{ fontSize: '11.5px', animation: 'mapSceneBeatIn .4s cubic-bezier(.19,1,.22,1) both' }}
                    >
                      <SceneMono size={11} color={SCENE.inkGhost} style={{ whiteSpace: 'nowrap' }}>
                        {String(i + 1).padStart(2, '0')}
                      </SceneMono>
                      <span className="min-w-0 truncate" style={{ color: SCENE.inkMid }}>{node.name}</span>
                      <span className="ml-auto shrink-0" style={{ color: st === 'done' ? pineBright : tone.bright, fontSize: '11px' }}>
                        {line}
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <BeatNarration beats={s.beats} beat={NARRATION_AT[beat] ?? s.beats.length - 1} hue={SCENE_HUE.steel} />
      </div>
    </SceneFrame>
  );
}
