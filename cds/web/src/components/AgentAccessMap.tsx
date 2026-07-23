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

export type AgentAccessMapSelection =
  | { kind: 'system' }
  | { kind: 'project'; projectId: string }
  | { kind: 'new' };

interface AgentMapMission {
  id: AgentPageContextId;
  label: string;
  icon: LucideIcon;
  slot: 'north-west' | 'north-east' | 'east' | 'south' | 'west';
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
  { id: 'auth', label: '登录与 SSO', icon: KeyRound, slot: 'north-west' },
  { id: 'github', label: 'GitHub 接入', icon: Github, slot: 'north-east' },
  { id: 'maintenance', label: '更新与维护', icon: Wrench, slot: 'east' },
  { id: 'settings', label: '系统设置', icon: SlidersHorizontal, slot: 'south' },
  { id: 'projects', label: '项目总览', icon: FolderKanban, slot: 'west' },
];

const PROJECT_MISSIONS: AgentMapMission[] = [
  { id: 'branches', label: '分支部署', icon: GitBranch, slot: 'north-west' },
  { id: 'project-settings', label: '项目配置', icon: Settings2, slot: 'north-east' },
  { id: 'release', label: '正式发布', icon: Rocket, slot: 'east' },
  { id: 'tasks', label: '任务调度', icon: CalendarClock, slot: 'south' },
  { id: 'reports', label: '验收报告', icon: FileCheck2, slot: 'west' },
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
  const terrainIndex = selection.kind === 'system'
    ? 4
    : selection.kind === 'new'
      ? 5
      : projectTerrain(selection.projectId);
  const mapName = selection.kind === 'system'
    ? 'CDS 控制中枢'
    : selection.kind === 'new'
      ? '新项目勘探区'
      : selectedProject?.name || selection.projectId;
  const mapCode = selection.kind === 'system'
    ? 'SYSTEM'
    : selection.kind === 'new'
      ? 'NEW WORLD'
      : selectedProject?.slug || selection.projectId;
  const terrainName = selection.kind === 'system'
    ? '系统控制区'
    : selection.kind === 'new'
      ? '待命名区域'
      : TERRAIN_NAMES[terrainIndex];

  return (
    <section className="cds-agent-map-shell" aria-labelledby="agent-map-title">
      <div className="cds-agent-map-heading">
        <div>
          <div className="cds-agent-map-kicker">
            <MapIcon aria-hidden="true" />
            <span>Agent 接入地图</span>
          </div>
          <h3 id="agent-map-title">先选择地图，再选择任务地标</h3>
        </div>
        <div className="cds-agent-map-legend" aria-label="地图图例">
          <span><i data-legend="map" />项目地图</span>
          <span><i data-legend="mission" />Agent 任务</span>
        </div>
      </div>

      <div className="cds-agent-world-strip" aria-label="选择项目地图">
        <button
          type="button"
          className="cds-agent-world-card"
          data-selected={selection.kind === 'system' ? 'true' : 'false'}
          data-terrain="4"
          aria-pressed={selection.kind === 'system'}
          onClick={() => onSelectionChange({ kind: 'system' })}
        >
          <span className="cds-agent-world-card-map" aria-hidden="true"><MapPinned /></span>
          <span><strong>CDS 控制中枢</strong><small>认证、GitHub 与系统维护</small></span>
        </button>
        {projects.map((project) => {
          const selected = isSelectedProject(selection, project.id);
          return (
            <button
              key={project.id}
              type="button"
              className="cds-agent-world-card"
              data-selected={selected ? 'true' : 'false'}
              data-terrain={String(projectTerrain(project.id))}
              aria-pressed={selected}
              onClick={() => onSelectionChange({ kind: 'project', projectId: project.id })}
            >
              <span className="cds-agent-world-card-map" aria-hidden="true"><MapPinned /></span>
              <span><strong>{project.name}</strong><small>{project.slug}</small></span>
            </button>
          );
        })}
        <button
          type="button"
          className="cds-agent-world-card cds-agent-world-card-new"
          data-selected={selection.kind === 'new' ? 'true' : 'false'}
          data-terrain="5"
          aria-pressed={selection.kind === 'new'}
          onClick={() => onSelectionChange({ kind: 'new' })}
        >
          <span className="cds-agent-world-card-map" aria-hidden="true"><Plus /></span>
          <span><strong>开辟新地图</strong><small>创建完成后切换项目权限</small></span>
        </button>
      </div>

      <div
        className="cds-agent-map"
        data-terrain={String(terrainIndex)}
        data-empty={selection.kind === 'new' ? 'true' : 'false'}
      >
        <div className="cds-agent-map-topography" aria-hidden="true" />
        <svg className="cds-agent-map-routes" viewBox="0 0 100 64" preserveAspectRatio="none" aria-hidden="true">
          <path d="M50 32 C38 24 31 19 20 17" />
          <path d="M50 32 C62 23 68 16 79 14" />
          <path d="M50 32 C69 34 78 38 88 42" />
          <path d="M50 32 C51 44 51 50 50 57" />
          <path d="M50 32 C35 37 25 41 13 44" />
        </svg>

        <div className="cds-agent-map-label">
          <span>{terrainName}</span>
          <strong>{mapName}</strong>
          <code>{mapCode}</code>
        </div>

        {selection.kind === 'new' ? (
          <button
            type="button"
            className="cds-agent-map-new-world"
            onClick={() => onMissionChange('projects')}
            aria-pressed={context.id === 'projects'}
          >
            <span><Plus aria-hidden="true" /></span>
            <strong>创建项目并生成地图</strong>
            <small>Agent 识别仓库后申请一次性创建权限</small>
          </button>
        ) : (
          <>
            <div className="cds-agent-map-hub" aria-hidden="true">
              <span><MapPinned /></span>
              <small>Agent Hub</small>
            </div>
            {missions.map((mission) => {
              const Icon = mission.icon;
              const selected = context.id === mission.id;
              const fromCurrentPage = sourceContextId === mission.id;
              return (
                <button
                  key={mission.id}
                  type="button"
                  className="cds-agent-map-mission"
                  data-slot={mission.slot}
                  data-selected={selected ? 'true' : 'false'}
                  aria-pressed={selected}
                  onClick={() => onMissionChange(mission.id)}
                  style={{ '--mission-order': missions.indexOf(mission) } as CSSProperties}
                >
                  <span className="cds-agent-map-mission-icon"><Icon aria-hidden="true" /></span>
                  <span className="cds-agent-map-mission-copy">
                    <strong>{mission.label}</strong>
                    <small>{fromCurrentPage ? '当前位置' : '可交给 Agent'}</small>
                  </span>
                </button>
              );
            })}
          </>
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
