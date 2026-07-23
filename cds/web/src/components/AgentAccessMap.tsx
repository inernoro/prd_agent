import type { CSSProperties } from 'react';
import {
  CalendarClock,
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
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { AgentProjectOption } from '@/components/SkillDownloadDialog';
import {
  PROJECT_AGENT_CONTEXT_IDS,
  SYSTEM_AGENT_CONTEXT_IDS,
  type AgentPageContext,
  type AgentPageContextId,
} from '@/lib/agent-onboarding';
import {
  createAgentTerritoryLayout,
  type AgentTerritoryRect,
} from '@/lib/agent-territory';

export type AgentAccessMapSelection =
  | { kind: 'system' }
  | { kind: 'project'; projectId: string }
  | { kind: 'new' };

interface AgentMapMission {
  id: AgentPageContextId;
  label: string;
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
  { id: 'auth', label: '登录与 SSO', icon: KeyRound },
  { id: 'github', label: 'GitHub 接入', icon: Github },
  { id: 'maintenance', label: '更新与维护', icon: Wrench },
  { id: 'settings', label: '系统设置', icon: SlidersHorizontal },
  { id: 'projects', label: '项目总览', icon: FolderKanban },
];

const PROJECT_MISSIONS: AgentMapMission[] = [
  { id: 'branches', label: '分支部署', icon: GitBranch },
  { id: 'project-settings', label: '项目配置', icon: Settings2 },
  { id: 'release', label: '正式发布', icon: Rocket },
  { id: 'tasks', label: '任务调度', icon: CalendarClock },
  { id: 'reports', label: '验收报告', icon: FileCheck2 },
];

const TERRAIN_NAMES = ['山脊工区', '海湾节点', '高原枢纽', '河谷走廊'] as const;

function projectTerrain(projectId: string): number {
  let hash = 0;
  for (let index = 0; index < projectId.length; index += 1) {
    hash = (hash * 31 + projectId.charCodeAt(index)) >>> 0;
  }
  return hash % TERRAIN_NAMES.length;
}

function isSelectedProject(selection: AgentAccessMapSelection, projectId: string): boolean {
  return selection.kind === 'project' && selection.projectId === projectId;
}

function territoryStyle(rect: AgentTerritoryRect, mobileRect: AgentTerritoryRect): CSSProperties {
  return {
    '--territory-x': rect.x,
    '--territory-y': rect.y,
    '--territory-width': rect.width,
    '--territory-height': rect.height,
    '--territory-mobile-x': mobileRect.x,
    '--territory-mobile-y': mobileRect.y,
    '--territory-mobile-width': mobileRect.width,
    '--territory-mobile-height': mobileRect.height,
  } as CSSProperties;
}

export function AgentAccessMap({
  projects,
  selection,
  context,
  sourceContextId,
  onSelectionChange,
  onMissionChange,
}: Props): JSX.Element {
  const selectedProject = selection.kind === 'project'
    ? projects.find((project) => project.id === selection.projectId)
    : undefined;
  const missions = selection.kind === 'system'
    ? SYSTEM_MISSIONS
    : selection.kind === 'project'
      ? PROJECT_MISSIONS
      : [];
  const mapName = selection.kind === 'system'
    ? 'CDS 控制中枢'
    : selection.kind === 'new'
      ? '新项目拓展区'
      : selectedProject?.name || selection.projectId;
  const mapCode = selection.kind === 'system'
    ? 'SYSTEM'
    : selection.kind === 'new'
      ? 'NEW WORLD'
      : selectedProject?.slug || selection.projectId;
  const layout = createAgentTerritoryLayout(projects);
  const mobileLayout = new Map(createAgentTerritoryLayout(projects, 0.9).map((rect) => [rect.key, rect]));
  const projectById = new Map(projects.map((project) => [project.id, project]));

  return (
    <section className="cds-agent-map-shell" aria-labelledby="agent-map-title">
      <div className="cds-agent-map-heading">
        <div>
          <div className="cds-agent-map-kicker">
            <MapIcon aria-hidden="true" />
            <span>Agent 接入地图</span>
          </div>
          <h3 id="agent-map-title">选择一块项目领土，再前往任务地标</h3>
        </div>
        <div className="cds-agent-map-legend" aria-label="地图图例">
          <span><i data-legend="map" />面积按项目规模预测</span>
          <span><i data-legend="mission" />当前路线</span>
        </div>
      </div>

      <div className="cds-agent-territory-map" aria-label="项目领土地图">
        <div className="cds-agent-territory-contours" aria-hidden="true" />
        {layout.map((rect) => {
          const mobileRect = mobileLayout.get(rect.key) || rect;
          const projectId = rect.key.startsWith('project:') ? rect.key.slice('project:'.length) : '';
          const project = projectId ? projectById.get(projectId) : undefined;
          const isSystem = rect.key === 'system';
          const isNew = rect.key === 'new';
          const selected = isSystem
            ? selection.kind === 'system'
            : isNew
              ? selection.kind === 'new'
              : Boolean(project && isSelectedProject(selection, project.id));
          const terrain = isSystem ? 4 : isNew ? 5 : projectTerrain(projectId);
          const title = isSystem ? 'CDS 控制中枢' : isNew ? '开辟新领土' : project?.name || projectId;
          const subtitle = isSystem ? '系统任务' : isNew ? '创建项目' : project?.slug || projectId;
          const countLabel = isSystem
            ? `${SYSTEM_MISSIONS.length} 类任务`
            : isNew
              ? '一次性权限'
              : `${project?.branchCount || 0} 条分支`;
          const selectionValue: AgentAccessMapSelection = isSystem
            ? { kind: 'system' }
            : isNew
              ? { kind: 'new' }
              : { kind: 'project', projectId };

          return (
            <button
              key={rect.key}
              type="button"
              className="cds-agent-territory"
              data-selected={selected ? 'true' : 'false'}
              data-terrain={String(terrain)}
              data-kind={isSystem ? 'system' : isNew ? 'new' : 'project'}
              aria-pressed={selected}
              aria-label={`${title}，${countLabel}，约占地图 ${Math.round(rect.areaPercent)}%`}
              onClick={() => onSelectionChange(selectionValue)}
              style={territoryStyle(rect, mobileRect)}
            >
              <span className="cds-agent-territory-landmark" aria-hidden="true">
                {isNew ? <Plus /> : <MapPinned />}
              </span>
              <span className="cds-agent-territory-copy">
                <strong>{title}</strong>
                <small>{subtitle}</small>
              </span>
              <span className="cds-agent-territory-metric">
                <small>{countLabel}</small>
                <strong>{Math.round(rect.areaPercent)}%</strong>
              </span>
            </button>
          );
        })}
        <div className="cds-agent-territory-compass" aria-hidden="true">
          <span>北</span>
          <i />
        </div>
      </div>

      <div className="cds-agent-map-missions" data-empty={selection.kind === 'new' ? 'true' : 'false'}>
        <div className="cds-agent-map-missions-heading">
          <span><MapPinned aria-hidden="true" /></span>
          <div>
            <small>当前领土</small>
            <strong>{mapName}</strong>
            <code>{mapCode}</code>
          </div>
        </div>
        {selection.kind === 'new' ? (
          <button
            type="button"
            className="cds-agent-map-new-world"
            onClick={() => onMissionChange('projects')}
            aria-pressed={context.id === 'projects'}
          >
            <Plus aria-hidden="true" />
            <span>
              <strong>创建项目并划定领土</strong>
              <small>Agent 识别仓库后申请一次性创建权限</small>
            </span>
          </button>
        ) : (
          <div className="cds-agent-map-mission-list" aria-label={`${mapName}任务地标`}>
            {missions.map((mission, index) => {
              const Icon = mission.icon;
              const selected = context.id === mission.id;
              const fromCurrentPage = sourceContextId === mission.id;
              return (
                <button
                  key={mission.id}
                  type="button"
                  className="cds-agent-map-mission"
                  data-selected={selected ? 'true' : 'false'}
                  aria-pressed={selected}
                  onClick={() => onMissionChange(mission.id)}
                  style={{ '--mission-order': index } as CSSProperties}
                >
                  <span className="cds-agent-map-mission-icon"><Icon aria-hidden="true" /></span>
                  <span className="cds-agent-map-mission-copy">
                    <strong>{mission.label}</strong>
                    <small>{fromCurrentPage ? '当前位置' : '可交给 Agent'}</small>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="cds-agent-map-status" aria-live="polite">
        <span><MapPinned aria-hidden="true" /></span>
        <div>
          <small>已规划路线</small>
          <strong>{mapName} / {context.title}</strong>
          <p>{context.summary}</p>
        </div>
      </div>
    </section>
  );
}

export function defaultMissionForMap(selection: AgentAccessMapSelection): AgentPageContextId {
  if (selection.kind === 'system') return SYSTEM_AGENT_CONTEXT_IDS[0];
  if (selection.kind === 'project') return PROJECT_AGENT_CONTEXT_IDS[0];
  return 'projects';
}
