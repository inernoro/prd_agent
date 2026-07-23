import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  FileCheck2,
  FolderKanban,
  GitBranch,
  Github,
  Info,
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

function sameSelection(left: AgentAccessMapSelection, right: AgentAccessMapSelection): boolean {
  return left.kind === right.kind
    && (left.kind !== 'project' || (right.kind === 'project' && left.projectId === right.projectId));
}

function selectionName(
  selection: AgentAccessMapSelection,
  projects: AgentProjectOption[],
): string {
  if (selection.kind === 'system') return 'CDS 控制中枢';
  if (selection.kind === 'new') return '新项目';
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
      metric: `${SYSTEM_MISSIONS.length} 类任务`,
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
      name: '创建新项目',
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
          <span>选择任务</span>
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
                先选择项目，再从一排任务入口中确定要交给 Agent 的工作。
              </DialogDescription>
            </div>
          </DialogHeader>

          <section className="cds-agent-world-step" aria-labelledby="agent-continent-title">
            <div className="cds-agent-world-step-heading">
              <span>1</span>
              <div>
                <h3 id="agent-continent-title">选择项目</h3>
                <p>先确定 Agent 要连接的项目范围。</p>
              </div>
            </div>
            <div className="cds-agent-continent-rail" role="listbox" aria-label="项目范围">
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
                <h3 id="agent-region-title">选择任务</h3>
                <p>选择 Agent 要处理的任务类别。</p>
              </div>
              <div className="cds-agent-world-current-continent">
                <small>当前项目</small>
                <strong>{draftContinentName}</strong>
                <code>{draftContinentCode}</code>
              </div>
            </div>

            <div className="cds-agent-mission-list">
              <div className="cds-agent-mission-list-meta">
                <span>
                  <strong>{draftMissions.length} 类任务入口</strong>
                  <small>这不是设置总数，进入页面后 Agent 会读取完整设置。</small>
                </span>
                <Info aria-hidden="true" />
              </div>
              <div
                className="cds-agent-mission-strip"
                role="listbox"
                aria-label={`${draftContinentName}的 Agent 任务`}
                data-single={draftMissions.length === 1 ? 'true' : 'false'}
                style={{
                  gridTemplateColumns: `repeat(${draftMissions.length}, minmax(148px, 1fr))`,
                } as CSSProperties}
              >
                {draftMissions.map((mission, index) => {
                  const Icon = mission.icon;
                  const selected = mission.id === draftMission.id;
                  const fromCurrentPage = sourceContextId === mission.id;
                  return (
                    <button
                      key={mission.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className="cds-agent-mission-card"
                      data-selected={selected ? 'true' : 'false'}
                      onClick={() => setDraftMissionId(mission.id)}
                    >
                      <span className="cds-agent-mission-card-index">{index + 1}</span>
                      <span className="cds-agent-mission-card-icon" aria-hidden="true">
                        <Icon />
                      </span>
                      <span className="cds-agent-mission-card-copy">
                        <strong>{mission.label}</strong>
                        <small>{fromCurrentPage ? '当前页面入口' : mission.description}</small>
                      </span>
                      <Check className="cds-agent-mission-card-check" aria-hidden="true" />
                    </button>
                  );
                })}
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
