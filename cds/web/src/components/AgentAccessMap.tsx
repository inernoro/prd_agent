import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  Activity,
  Bot,
  Boxes,
  Braces,
  CalendarClock,
  Check,
  ChevronDown,
  CodeXml,
  Database,
  Eye,
  FileCheck2,
  FolderKanban,
  GitBranch,
  Github,
  Info,
  KeyRound,
  Plus,
  Power,
  Rocket,
  RotateCcw,
  ScrollText,
  ShieldCheck,
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
  getAgentMissionCategoriesForScope,
  getAgentMissionDefinition,
  getAgentMissionsForCategory,
  PROJECT_AGENT_CONTEXT_IDS,
  SYSTEM_AGENT_CONTEXT_IDS,
  type AgentPageContext,
  type AgentPageContextId,
  type AgentMissionCategoryId,
  type AgentMissionDefinition,
  type AgentMissionIconKey,
  type AgentMissionScope,
} from '@/lib/agent-onboarding';

export type AgentAccessMapSelection =
  | { kind: 'system' }
  | { kind: 'project'; projectId: string }
  | { kind: 'new' };

interface Props {
  projects: AgentProjectOption[];
  selection: AgentAccessMapSelection;
  context: AgentPageContext;
  sourceContextId?: AgentPageContextId;
  onSelectionChange: (selection: AgentAccessMapSelection) => void;
  onMissionChange: (contextId: AgentPageContextId) => void;
}

const MISSION_ICON_REGISTRY: Record<AgentMissionIconKey, LucideIcon> = {
  api: Braces,
  auth: ShieldCheck,
  branch: GitBranch,
  check: FileCheck2,
  code: CodeXml,
  database: Database,
  github: Github,
  health: Activity,
  key: KeyRound,
  logs: ScrollText,
  maintenance: Wrench,
  preview: Eye,
  project: FolderKanban,
  release: Rocket,
  rollback: RotateCcw,
  schedule: CalendarClock,
  service: Boxes,
  settings: SlidersHorizontal,
  startup: Power,
};

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

function missionScopeForSelection(selection: AgentAccessMapSelection): AgentMissionScope {
  return selection.kind === 'project' ? 'project' : 'system';
}

function missionsForSelection(selection: AgentAccessMapSelection): AgentMissionDefinition[] {
  if (selection.kind === 'new') return [getAgentMissionDefinition('projects')];
  const ids = selection.kind === 'system' ? SYSTEM_AGENT_CONTEXT_IDS : PROJECT_AGENT_CONTEXT_IDS;
  return ids.map((id) => getAgentMissionDefinition(id));
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
  const [draftCategoryId, setDraftCategoryId] = useState<AgentMissionCategoryId>(context.categoryId);

  useEffect(() => {
    if (!open) return;
    setDraftSelection(selection);
    setDraftMissionId(context.id);
    setDraftCategoryId(context.categoryId);
  }, [open, selection, context.id, context.categoryId]);

  const selectionLabel = selectionName(selection, projects);
  const draftSelectionLabel = selectionName(draftSelection, projects);
  const draftSelectionCode = selectionCode(draftSelection, projects);
  const draftScope = missionScopeForSelection(draftSelection);
  const allDraftMissions = missionsForSelection(draftSelection);
  const draftCategories = getAgentMissionCategoriesForScope(draftScope)
    .filter((category) => allDraftMissions.some((mission) => mission.categoryId === category.id));
  const effectiveCategoryId = draftCategories.some((category) => category.id === draftCategoryId)
    ? draftCategoryId
    : allDraftMissions[0].categoryId;
  const draftMissions = draftSelection.kind === 'new'
    ? allDraftMissions
    : getAgentMissionsForCategory(draftScope, effectiveCategoryId);
  const draftMission = allDraftMissions.find((mission) => mission.id === draftMissionId)
    || draftMissions[0]
    || allDraftMissions[0];
  const projectOptions = useMemo<Array<{
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
      metric: `${SYSTEM_AGENT_CONTEXT_IDS.length} 个任务`,
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
    const defaultMissionId = defaultMissionForMap(nextSelection);
    setDraftMissionId(defaultMissionId);
    setDraftCategoryId(getAgentMissionDefinition(defaultMissionId).categoryId);
  };

  const chooseCategory = (categoryId: AgentMissionCategoryId): void => {
    if (categoryId === effectiveCategoryId) return;
    const firstMission = getAgentMissionsForCategory(draftScope, categoryId)[0];
    if (!firstMission) return;
    setDraftCategoryId(categoryId);
    setDraftMissionId(firstMission.id);
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
            {context.id === sourceContextId ? '当前页面任务' : '已选择 Agent 任务'}
          </span>
          <strong>{context.title}</strong>
          <small>{context.summary}</small>
        </span>
        <span className="cds-agent-route-trigger-route">
          <small>{selectionLabel}</small>
          <span>选择任务</span>
        </span>
        <ChevronDown className="cds-agent-route-trigger-chevron" aria-hidden="true" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="cds-agent-world-dialog max-w-none"
          style={{
            width: 'min(960px, calc(100vw - 32px))',
            maxHeight: 'calc(100dvh - 32px)',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}
        >
          <DialogHeader className="cds-agent-world-header">
            <div className="cds-agent-world-title-icon" aria-hidden="true">
              <Bot />
            </div>
            <div>
              <DialogTitle>选择 Agent 任务</DialogTitle>
              <DialogDescription>
                先选择项目，再按分类确定要交给 Agent 的具体工作。
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
              {projectOptions.map((option) => {
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
                      {selected ? <Check /> : option.selection.kind === 'new' ? <Plus /> : <FolderKanban />}
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
                <strong>{draftSelectionLabel}</strong>
                <code>{draftSelectionCode}</code>
              </div>
            </div>

            <div className="cds-agent-mission-list">
              <div className="cds-agent-mission-list-meta">
                <span>
                  <strong>{allDraftMissions.length} 个 Agent 任务</strong>
                  <small>Agent 会先静默检查项目凭据；已有权限时不会重复要求批准。</small>
                </span>
                <ShieldCheck aria-hidden="true" />
              </div>
              {draftSelection.kind !== 'new' ? (
                <nav className="cds-agent-mission-categories" aria-label="任务分类">
                  {draftCategories.map((category) => {
                    const selected = category.id === effectiveCategoryId;
                    const count = allDraftMissions.filter((mission) => mission.categoryId === category.id).length;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        aria-pressed={selected}
                        data-selected={selected ? 'true' : 'false'}
                        onClick={() => chooseCategory(category.id)}
                      >
                        <span>{category.label}</span>
                        <small>{count}</small>
                      </button>
                    );
                  })}
                </nav>
              ) : null}
              <div
                className="cds-agent-mission-strip"
                role="listbox"
                aria-label={`${draftSelectionLabel}的 Agent 任务`}
                data-single={draftMissions.length === 1 ? 'true' : 'false'}
                style={{
                  gridTemplateColumns: `repeat(${draftMissions.length}, minmax(148px, 1fr))`,
                } as CSSProperties}
              >
                {draftMissions.map((mission, index) => {
                  const Icon = MISSION_ICON_REGISTRY[mission.icon];
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
                        <strong>{mission.shortLabel}</strong>
                        <small>{fromCurrentPage ? '当前页面入口' : mission.cardDescription}</small>
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
              <Info aria-hidden="true" />
              <span>
                <small>任务预览</small>
                <strong>{draftSelectionLabel} / {draftMission.shortLabel}</strong>
                <p>{draftMission.summary}</p>
              </span>
            </div>
            <Button type="button" onClick={confirmRoute}>
              使用这个任务
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
