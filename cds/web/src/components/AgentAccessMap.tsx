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

/*
 * 五块地界共享边界，组成一块完整大陆。路径按同一组边界点绘制，
 * 保证视觉上紧密相连，而不是把矩形卡片伪装成地图。
 */
const REGION_SHAPES: RegionShape[] = [
  {
    path: 'M146 80 C210 36 321 38 403 60 C442 70 472 91 495 123 L459 211 C411 206 366 191 319 199 C272 207 231 225 186 214 L132 156 C122 126 127 101 146 80 Z',
    labelX: 302,
    labelY: 128,
  },
  {
    path: 'M403 60 C495 31 611 38 691 74 C729 91 753 117 754 148 L710 229 C653 238 599 224 550 230 L459 211 L495 123 C472 91 442 70 403 60 Z',
    labelX: 604,
    labelY: 129,
  },
  {
    path: 'M132 156 L186 214 C231 225 272 207 319 199 C366 191 411 206 459 211 L423 289 C386 322 336 349 280 363 C224 375 163 349 126 310 C96 278 102 213 132 156 Z',
    labelX: 267,
    labelY: 284,
  },
  {
    path: 'M459 211 L550 230 C599 224 653 238 710 229 L672 316 C628 347 570 371 501 382 C470 365 444 333 423 289 Z',
    labelX: 535,
    labelY: 298,
  },
  {
    path: 'M754 148 C786 154 810 176 812 205 C816 248 803 290 777 322 C748 345 708 341 672 316 L710 229 Z',
    labelX: 750,
    labelY: 242,
  },
];

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
                  <linearGradient id="agent-land-forest" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="hsl(157 35% 48%)" />
                    <stop offset="1" stopColor="hsl(169 31% 29%)" />
                  </linearGradient>
                  <linearGradient id="agent-land-ridge" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="hsl(42 44% 57%)" />
                    <stop offset="1" stopColor="hsl(77 32% 34%)" />
                  </linearGradient>
                  <linearGradient id="agent-land-coast" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="hsl(178 38% 47%)" />
                    <stop offset="1" stopColor="hsl(203 42% 32%)" />
                  </linearGradient>
                  <filter id="agent-land-shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="8" stdDeviation="7" floodColor="hsl(213 42% 5%)" floodOpacity="0.38" />
                  </filter>
                </defs>

                <path
                  className="cds-agent-world-coastline"
                  d="M146 80 C210 36 321 38 403 60 C495 31 611 38 691 74 C729 91 753 117 754 148 C786 154 810 176 812 205 C816 248 803 290 777 322 C748 345 708 341 672 316 C628 347 570 371 501 382 C470 365 444 333 423 289 C386 322 336 349 280 363 C224 375 163 349 126 310 C96 278 102 213 132 156 C122 126 127 101 146 80 Z"
                  filter="url(#agent-land-shadow)"
                  aria-hidden="true"
                />

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
                      style={{ '--region-order': index } as CSSProperties}
                    >
                      <path d={shape.path} />
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
                <g className="cds-agent-world-compass" transform="translate(850 324)" aria-hidden="true">
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
