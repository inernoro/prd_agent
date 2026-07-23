import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  FileCheck2,
  FolderKanban,
  GitBranch,
  Github,
  KeyRound,
  Map as MapIcon,
  MapPinned,
  Plus,
  Rocket,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { AgentProjectOption } from '@/components/SkillDownloadDialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  PROJECT_AGENT_CONTEXT_IDS,
  SYSTEM_AGENT_CONTEXT_IDS,
  type AgentPageContext,
  type AgentPageContextId,
} from '@/lib/agent-onboarding';

export type AgentAccessMapSelection =
  | { kind: 'system' }
  | { kind: 'project'; projectId: string }
  | { kind: 'new' };

interface AgentMapMission {
  id: AgentPageContextId;
  label: string;
  description: string;
  icon: LucideIcon;
}

interface RegionShape {
  path: string;
  labelX: number;
  labelY: number;
  nodes: Array<{ x: number; y: number }>;
  features: string[];
}

interface Props {
  projects: AgentProjectOption[];
  selection: AgentAccessMapSelection;
  context: AgentPageContext;
  sourceContextId?: AgentPageContextId;
  onSelectionChange: (selection: AgentAccessMapSelection) => void;
  onMissionChange: (contextId: AgentPageContextId) => void;
}

const SYSTEM_MISSIONS: AgentMapMission[] = [
  { id: 'auth', label: '登录与 SSO', description: '身份、回调与票据', icon: KeyRound },
  { id: 'github', label: 'GitHub 接入', description: '仓库与 Webhook', icon: Github },
  { id: 'maintenance', label: '更新与维护', description: '版本和运行状态', icon: Wrench },
  { id: 'settings', label: '系统设置', description: '全局规则与偏好', icon: SlidersHorizontal },
  { id: 'projects', label: '项目总览', description: '项目入口与状态', icon: FolderKanban },
];

const PROJECT_MISSIONS: AgentMapMission[] = [
  { id: 'branches', label: '分支部署', description: '构建与预览路线', icon: GitBranch },
  { id: 'project-settings', label: '项目配置', description: '环境与服务编排', icon: Settings2 },
  { id: 'release', label: '正式发布', description: '生产发布目标', icon: Rocket },
  { id: 'tasks', label: '任务调度', description: '计划与执行队列', icon: CalendarClock },
  { id: 'reports', label: '验收报告', description: '证据与结果归档', icon: FileCheck2 },
];

const NEW_PROJECT_MISSIONS: AgentMapMission[] = [
  { id: 'projects', label: '开辟新项目', description: '识别仓库并申请一次性权限', icon: Plus },
];

const NORTHWEST_TO_CENTER = [
  [410, 66], [434, 74], [452, 88], [471, 103], [497, 126],
  [488, 151], [476, 181], [460, 213],
] as const;

const WEST_TO_CENTER = [
  [128, 164], [151, 183], [174, 205], [201, 219], [236, 224],
  [275, 213], [317, 202], [360, 196], [405, 205], [460, 213],
] as const;

const CENTER_TO_EAST = [
  [460, 213], [497, 218], [532, 232], [568, 230],
  [607, 226], [645, 235], [680, 233], [710, 228],
] as const;

const CENTER_TO_SOUTH = [
  [460, 213], [451, 239], [438, 267], [421, 295],
] as const;

const EAST_TO_SOUTH = [
  [710, 228], [704, 252], [692, 279], [681, 301], [670, 320],
] as const;

function continuePath(points: ReadonlyArray<readonly [number, number]>): string {
  return points.slice(1).map(([x, y]) => `L${x} ${y}`).join(' ');
}

function reversePath(points: ReadonlyArray<readonly [number, number]>): string {
  return [...points].reverse().slice(1).map(([x, y]) => `L${x} ${y}`).join(' ');
}

/*
 * 五块地界共享同一组边界点，外缘使用海湾、岬角和半岛组成完整大陆。
 * 共享边界只定义一次再正反复用，避免相邻区域出现裂缝。
 */
const REGION_SHAPES: RegionShape[] = [
  {
    path: [
      'M148 88',
      'C164 74 184 77 199 64 C216 48 238 63 254 52',
      'C277 38 299 55 319 48 C351 37 379 53 410 66',
      continuePath(NORTHWEST_TO_CENTER),
      reversePath(WEST_TO_CENTER),
      'C116 151 116 139 127 128 C119 112 132 98 148 88 Z',
    ].join(' '),
    labelX: 294,
    labelY: 132,
    nodes: [{ x: 194, y: 103 }, { x: 367, y: 94 }, { x: 231, y: 181 }],
    features: [
      'M168 126 C211 92 274 82 337 91 C372 96 399 110 426 135',
      'M177 153 C225 126 279 119 332 126 C365 131 392 145 414 164',
      'M207 181 C249 161 301 157 350 166 C373 170 393 180 407 191',
    ],
  },
  {
    path: [
      'M410 66',
      'C438 56 468 47 499 55 C522 39 551 52 574 47',
      'C605 45 628 55 648 66 C683 59 714 77 735 100',
      'C755 112 753 132 758 148 C746 171 733 201 710 228',
      reversePath(CENTER_TO_EAST),
      reversePath(NORTHWEST_TO_CENTER),
      'Z',
    ].join(' '),
    labelX: 599,
    labelY: 132,
    nodes: [{ x: 488, y: 84 }, { x: 675, y: 112 }, { x: 641, y: 193 }],
    features: [
      'M485 105 L526 78 L558 111 L585 72 L615 118 L648 88 L690 128',
      'M514 158 C549 128 590 130 624 150 C651 165 677 177 712 174',
      'M495 193 C540 174 581 180 615 199 C641 213 668 214 697 205',
    ],
  },
  {
    path: [
      'M128 164',
      continuePath(WEST_TO_CENTER),
      continuePath(CENTER_TO_SOUTH),
      'C391 321 364 340 332 348 C311 364 282 367 258 359',
      'C229 372 205 357 184 347 C158 338 146 321 129 306',
      'C112 286 118 264 106 244 C101 220 112 195 118 177',
      'C120 171 123 167 128 164 Z',
    ].join(' '),
    labelX: 267,
    labelY: 284,
    nodes: [{ x: 151, y: 248 }, { x: 340, y: 242 }, { x: 219, y: 333 }],
    features: [
      'M137 238 C190 219 238 237 272 266 C300 290 337 300 384 292',
      'M145 278 C191 257 230 269 260 299 C285 323 320 333 362 326',
      'M178 326 C212 310 246 315 275 338',
    ],
  },
  {
    path: [
      'M460 213',
      continuePath(CENTER_TO_EAST),
      continuePath(EAST_TO_SOUTH),
      'C646 340 620 347 590 351 C570 367 540 374 507 382',
      'C477 373 453 351 433 326 C429 314 425 304 421 295',
      reversePath(CENTER_TO_SOUTH),
      'Z',
    ].join(' '),
    labelX: 544,
    labelY: 300,
    nodes: [{ x: 478, y: 263 }, { x: 625, y: 277 }, { x: 551, y: 351 }],
    features: [
      'M467 257 L500 244 L528 267 L561 250 L592 276 L625 260 L666 286',
      'M449 293 C489 276 528 283 559 308 C584 329 615 331 650 316',
      'M477 337 C513 319 552 326 584 351',
    ],
  },
  {
    path: [
      'M758 148',
      'C779 153 789 167 807 174 C821 191 811 208 818 224',
      'C824 248 805 266 804 286 C791 307 778 325 751 336',
      'C723 346 697 334 670 320',
      reversePath(EAST_TO_SOUTH),
      'L710 228 C733 201 746 171 758 148 Z',
    ].join(' '),
    labelX: 758,
    labelY: 242,
    nodes: [{ x: 778, y: 183 }, { x: 783, y: 282 }, { x: 723, y: 310 }],
    features: [
      'M748 172 C781 186 789 210 775 232 C763 251 766 271 791 294',
      'M728 205 C752 219 759 239 748 260 C737 279 740 298 758 318',
      'M715 254 C730 268 733 286 724 305',
    ],
  },
];

const CONTINENT_OUTLINE = [
  'M410 66',
  'C438 56 468 47 499 55 C522 39 551 52 574 47',
  'C605 45 628 55 648 66 C683 59 714 77 735 100',
  'C755 112 753 132 758 148 C779 153 789 167 807 174',
  'C821 191 811 208 818 224 C824 248 805 266 804 286',
  'C791 307 778 325 751 336 C723 346 697 334 670 320',
  'C646 340 620 347 590 351 C570 367 540 374 507 382',
  'C477 373 453 351 433 326 C429 314 425 304 421 295',
  'C391 321 364 340 332 348 C311 364 282 367 258 359',
  'C229 372 205 357 184 347 C158 338 146 321 129 306',
  'C112 286 118 264 106 244 C101 220 112 195 118 177',
  'C120 171 123 167 128 164 C116 151 116 139 127 128',
  'C119 112 132 98 148 88 C164 74 184 77 199 64',
  'C216 48 238 63 254 52 C277 38 299 55 319 48',
  'C351 37 379 53 410 66 Z',
].join(' ');

const REGION_HUES = [187, 178, 194, 207, 246];

function sameSelection(left: AgentAccessMapSelection, right: AgentAccessMapSelection): boolean {
  return left.kind === right.kind
    && (left.kind !== 'project' || (right.kind === 'project' && left.projectId === right.projectId));
}

function selectionKey(selection: AgentAccessMapSelection): string {
  return selection.kind === 'project' ? `project:${selection.projectId}` : selection.kind;
}

function selectionName(
  selection: AgentAccessMapSelection,
  projects: AgentProjectOption[],
): string {
  if (selection.kind === 'system') return 'CDS 控制中枢';
  if (selection.kind === 'new') return '未绘制大陆';
  return projects.find((project) => project.id === selection.projectId)?.name || selection.projectId;
}

function selectionCode(
  selection: AgentAccessMapSelection,
  projects: AgentProjectOption[],
): string {
  if (selection.kind === 'system') return 'SYSTEM';
  if (selection.kind === 'new') return 'NEW PROJECT';
  return projects.find((project) => project.id === selection.projectId)?.slug || selection.projectId;
}

function missionsForSelection(selection: AgentAccessMapSelection): AgentMapMission[] {
  if (selection.kind === 'system') return SYSTEM_MISSIONS;
  if (selection.kind === 'new') return NEW_PROJECT_MISSIONS;
  return PROJECT_MISSIONS;
}

function handleRegionKeyDown(
  event: KeyboardEvent<SVGGElement>,
  selectMission: () => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  selectMission();
}

export function AgentAccessMap({
  projects,
  selection,
  context,
  sourceContextId,
  onSelectionChange,
  onMissionChange,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draftSelection, setDraftSelection] = useState<AgentAccessMapSelection>(selection);
  const [draftMissionId, setDraftMissionId] = useState<AgentPageContextId>(context.id);

  useEffect(() => {
    if (!open) return;
    setDraftSelection(selection);
    setDraftMissionId(context.id);
  }, [open, selection, context.id]);

  const continentName = selectionName(selection, projects);
  const draftContinentName = selectionName(draftSelection, projects);
  const draftContinentCode = selectionCode(draftSelection, projects);
  const draftMissions = missionsForSelection(draftSelection);
  const draftMission = draftMissions.find((mission) => mission.id === draftMissionId)
    || draftMissions[0];
  const selectedShapeIndex = Math.max(
    0,
    draftMissions.findIndex((mission) => mission.id === draftMission.id),
  );
  const selectedShape = REGION_SHAPES[selectedShapeIndex];
  const continentOptions = useMemo<Array<{
    key: string;
    selection: AgentAccessMapSelection;
    name: string;
    code: string;
    metric: string;
  }>>(() => [
    {
      key: 'system',
      selection: { kind: 'system' },
      name: 'CDS 控制中枢',
      code: 'SYSTEM',
      metric: `${SYSTEM_MISSIONS.length} 块地界`,
    },
    ...projects.map((project) => ({
      key: `project:${project.id}`,
      selection: { kind: 'project', projectId: project.id } as AgentAccessMapSelection,
      name: project.name,
      code: project.slug,
      metric: `${project.branchCount || 0} 条分支`,
    })),
    {
      key: 'new',
      selection: { kind: 'new' },
      name: '开辟新大陆',
      code: 'NEW PROJECT',
      metric: '一次性权限',
    },
  ], [projects]);

  const chooseContinent = (nextSelection: AgentAccessMapSelection): void => {
    if (sameSelection(nextSelection, draftSelection)) return;
    setDraftSelection(nextSelection);
    setDraftMissionId(defaultMissionForMap(nextSelection));
  };

  const confirmRoute = (): void => {
    onSelectionChange(draftSelection);
    onMissionChange(draftMission.id);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="cds-agent-route-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-agent-context={context.id}
        data-agent-page={context.pagePath}
      >
        <span className="cds-agent-route-trigger-icon" aria-hidden="true">
          <Sparkles />
        </span>
        <span className="cds-agent-route-trigger-copy">
          <span className="cds-agent-route-trigger-kicker">
            {context.id === sourceContextId ? '当前页面任务' : '已选择地图任务'}
          </span>
          <strong>{context.title}</strong>
          <small>{context.summary}</small>
        </span>
        <span className="cds-agent-route-trigger-route">
          <small>{continentName}</small>
          <span>打开世界地图</span>
        </span>
        <ChevronDown className="cds-agent-route-trigger-chevron" aria-hidden="true" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="cds-agent-world-dialog max-w-none"
          style={{ width: 'min(960px, calc(100vw - 32px))' }}
        >
          <DialogHeader className="cds-agent-world-header">
            <div className="cds-agent-world-title-icon" aria-hidden="true">
              <MapIcon />
            </div>
            <div>
              <DialogTitle>选择 Agent 路线</DialogTitle>
              <DialogDescription>
                先选择项目大洲，再在相连的地界中确定要交给 Agent 的任务。
              </DialogDescription>
            </div>
          </DialogHeader>

          <section className="cds-agent-world-step" aria-labelledby="agent-continent-title">
            <div className="cds-agent-world-step-heading">
              <span>1</span>
              <div>
                <h3 id="agent-continent-title">选择大洲</h3>
                <p>每个项目是一块大洲，系统任务位于控制中枢。</p>
              </div>
            </div>
            <div className="cds-agent-continent-rail" role="listbox" aria-label="项目大洲">
              {continentOptions.map((option) => {
                const selected = sameSelection(option.selection, draftSelection);
                return (
                  <button
                    key={option.key}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    autoFocus={selected}
                    className="cds-agent-continent"
                    data-selected={selected ? 'true' : 'false'}
                    onClick={() => chooseContinent(option.selection)}
                  >
                    <span className="cds-agent-continent-marker" aria-hidden="true">
                      {selected ? <Check /> : <MapPinned />}
                    </span>
                    <span>
                      <strong>{option.name}</strong>
                      <code>{option.code}</code>
                    </span>
                    <small>{option.metric}</small>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="cds-agent-world-step" aria-labelledby="agent-region-title">
            <div className="cds-agent-world-step-heading">
              <span>2</span>
              <div>
                <h3 id="agent-region-title">选择地界</h3>
                <p>{draftContinentName} 的任务紧密相连，点击地界规划路线。</p>
              </div>
              <div className="cds-agent-world-current-continent">
                <small>当前大洲</small>
                <strong>{draftContinentName}</strong>
                <code>{draftContinentCode}</code>
              </div>
            </div>

            <div
              key={selectionKey(draftSelection)}
              className="cds-agent-world-stage"
              data-single-region={draftSelection.kind === 'new' ? 'true' : 'false'}
            >
              <div className="cds-agent-world-ocean-grid" aria-hidden="true" />
              <svg
                className="cds-agent-world-svg"
                viewBox="0 0 920 420"
                role="group"
                aria-label={`${draftContinentName}地界地图`}
              >
                <defs>
                  <linearGradient id="agent-electronic-ocean" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="hsl(195 94% 48%)" stopOpacity="0.16" />
                    <stop offset="0.48" stopColor="hsl(184 88% 50%)" stopOpacity="0.05" />
                    <stop offset="1" stopColor="hsl(223 84% 56%)" stopOpacity="0.12" />
                  </linearGradient>
                  <pattern id="agent-electronic-hex" width="28" height="24" patternUnits="userSpaceOnUse">
                    <path
                      d="M7 1H21L27 12L21 23H7L1 12Z"
                      fill="none"
                      stroke="hsl(187 100% 69%)"
                      strokeOpacity="0.15"
                      strokeWidth="0.8"
                    />
                  </pattern>
                  <filter id="agent-cyan-glow" x="-40%" y="-40%" width="180%" height="180%">
                    <feGaussianBlur stdDeviation="4" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="agent-amber-glow" x="-80%" y="-80%" width="260%" height="260%">
                    <feGaussianBlur stdDeviation="6" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                <g className="cds-agent-world-hud" aria-hidden="true">
                  <path d="M40 70H880M40 140H880M40 210H880M40 280H880M40 350H880" />
                  <path d="M120 30V390M260 30V390M400 30V390M540 30V390M680 30V390M820 30V390" />
                  <text x="42" y="64">60</text>
                  <text x="42" y="134">45</text>
                  <text x="42" y="204">30</text>
                  <text x="42" y="274">15</text>
                  <text x="108" y="404">-120</text>
                  <text x="248" y="404">-90</text>
                  <text x="392" y="404">-60</text>
                  <text x="532" y="404">-30</text>
                  <text x="678" y="404">0</text>
                  <text x="812" y="404">30</text>
                </g>

                <path className="cds-agent-world-depth-line cds-agent-world-depth-line--outer" d={CONTINENT_OUTLINE} aria-hidden="true" />
                <path
                  className="cds-agent-world-coastline"
                  d={CONTINENT_OUTLINE}
                  filter="url(#agent-cyan-glow)"
                  aria-hidden="true"
                />
                <path className="cds-agent-world-depth-line cds-agent-world-depth-line--inner" d={CONTINENT_OUTLINE} aria-hidden="true" />

                {draftMissions.map((mission, index) => {
                  const shape = REGION_SHAPES[index];
                  const Icon = mission.icon;
                  const selected = mission.id === draftMission.id;
                  const fromCurrentPage = sourceContextId === mission.id;
                  return (
                    <g
                      key={mission.id}
                      role="button"
                      tabIndex={0}
                      className="cds-agent-world-region"
                      data-selected={selected ? 'true' : 'false'}
                      aria-pressed={selected}
                      aria-label={`${mission.label}，${mission.description}`}
                      onClick={() => setDraftMissionId(mission.id)}
                      onKeyDown={(event) => handleRegionKeyDown(event, () => setDraftMissionId(mission.id))}
                      style={{
                        '--region-order': index,
                        '--region-hue': REGION_HUES[index],
                      } as CSSProperties}
                    >
                      <path className="cds-agent-world-region-fill" d={shape.path} />
                      <path className="cds-agent-world-region-grid" d={shape.path} />
                      <path
                        className="cds-agent-world-region-contour"
                        d={shape.path}
                        style={{ '--contour-scale': 0.94 } as CSSProperties}
                        aria-hidden="true"
                      />
                      <path
                        className="cds-agent-world-region-contour"
                        d={shape.path}
                        style={{ '--contour-scale': 0.86 } as CSSProperties}
                        aria-hidden="true"
                      />
                      {shape.nodes.map((node, nodeIndex) => (
                        <g
                          key={`${mission.id}-node-${nodeIndex}`}
                          className="cds-agent-world-data-node"
                          transform={`translate(${node.x} ${node.y})`}
                          aria-hidden="true"
                        >
                          <circle r="7" />
                          <circle r="2.2" />
                          <path d="M-12 0H-7M7 0H12M0-12V-7M0 7V12" />
                        </g>
                      ))}
                      {shape.features.map((feature, featureIndex) => (
                        <path
                          key={`${mission.id}-feature-${featureIndex}`}
                          className="cds-agent-world-region-feature"
                          d={feature}
                          aria-hidden="true"
                        />
                      ))}
                      <foreignObject
                        x={shape.labelX - 76}
                        y={shape.labelY - 30}
                        width="152"
                        height="72"
                        pointerEvents="none"
                      >
                        <div className="cds-agent-world-region-label">
                          <span><Icon aria-hidden="true" /></span>
                          <strong>{mission.label}</strong>
                          <small>{fromCurrentPage ? '当前位置' : mission.description}</small>
                        </div>
                      </foreignObject>
                    </g>
                  );
                })}

                <g className="cds-agent-world-island" aria-hidden="true">
                  <path d="M838 287 C852 277 870 281 878 294 C889 302 886 318 879 329 C869 340 850 338 839 328 C829 317 828 299 838 287 Z" />
                  <path d="M844 295 C854 288 867 292 872 301 C878 310 871 323 862 328" />
                  <circle cx="856" cy="307" r="3" />
                </g>
                <g
                  className="cds-agent-world-signal-rings"
                  transform={`translate(${selectedShape.labelX} ${selectedShape.labelY - 31})`}
                  aria-hidden="true"
                >
                  <circle r="18" style={{ '--ring-order': 0 } as CSSProperties} />
                  <circle r="30" style={{ '--ring-order': 1 } as CSSProperties} />
                  <circle r="43" style={{ '--ring-order': 2 } as CSSProperties} />
                </g>
                <path
                  className="cds-agent-world-route"
                  d={`M ${selectedShape.labelX} ${selectedShape.labelY - 30} C ${selectedShape.labelX} 62 460 88 460 42`}
                  aria-hidden="true"
                />
                <circle
                  className="cds-agent-world-route-beacon"
                  cx={selectedShape.labelX}
                  cy={selectedShape.labelY - 31}
                  r="8"
                  aria-hidden="true"
                />
                <g className="cds-agent-world-route-terminal" transform="translate(460 42)" aria-hidden="true">
                  <circle r="10" />
                  <circle r="3" />
                </g>
                <g className="cds-agent-world-compass" transform="translate(878 360)" aria-hidden="true">
                  <text x="0" y="-18">北</text>
                  <path d="M0 -12 L8 18 L0 12 L-8 18 Z" />
                </g>
              </svg>
              <div className="cds-agent-world-map-caption">
                <span><i data-kind="land" />可选地界</span>
                <span><i data-kind="route" />当前路线</span>
              </div>
            </div>
          </section>

          <div className="cds-agent-world-footer">
            <div className="cds-agent-world-route-summary" aria-live="polite">
              <MapPinned aria-hidden="true" />
              <span>
                <small>路线预览</small>
                <strong>{draftContinentName} / {draftMission.label}</strong>
                <p>{draftMission.description}</p>
              </span>
            </div>
            <Button type="button" onClick={confirmRoute}>
              使用这条路线
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function defaultMissionForMap(selection: AgentAccessMapSelection): AgentPageContextId {
  if (selection.kind === 'system') return SYSTEM_AGENT_CONTEXT_IDS[0];
  if (selection.kind === 'project') return PROJECT_AGENT_CONTEXT_IDS[0];
  return 'projects';
}
