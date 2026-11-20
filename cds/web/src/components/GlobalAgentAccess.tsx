import { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import { SkillDownloadDialog, type AgentProjectOption } from '@/components/SkillDownloadDialog';
import type { AgentConnectDraft } from '@/components/AgentConnectPanel';
import {
  AGENT_ACCESS_QUERY,
  AGENT_ADD_REPOSITORY_QUERY,
  AGENT_REPOSITORY_QUERY,
  OPEN_AGENT_ACCESS_EVENT,
  resolveAgentPageContext,
  type AgentPageContextId,
} from '@/lib/agent-onboarding';
import { ApiError, apiRequest, isChildPreviewCdsInstance } from '@/lib/api';

type AgentProjectsResponse = {
  canManageProjects?: boolean;
  projects?: Array<{
    id: string;
    name?: string;
    aliasName?: string | null;
    slug?: string;
    githubRepoFullName?: string;
    branchCount?: number;
    runningBranchCount?: number;
    runningServiceCount?: number;
    agentProfile?: {
      role: string;
      experience: string;
      skills?: string[];
      cardTitle?: string;
      declaredAt?: string;
    };
  }>;
};

const STANDALONE_PATHS = new Set(['/', '/login', '/auth/sso', '/preview-preparing', '/hello']);

/**
 * 全站 Agent 接入控制器。
 *
 * 控制台页面使用左侧栏入口；登录、SSO 回调和首页没有控制台壳层，因此补充固定入口。
 * 两种入口都通过同一个事件打开同一个弹窗，避免页面各自复制接入协议和安全边界。
 */
export function GlobalAgentAccess(): JSX.Element {
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [requestedContextId, setRequestedContextId] = useState<AgentPageContextId | undefined>(undefined);
  const [projects, setProjects] = useState<AgentProjectOption[] | null>(null);
  const [canManageProjects, setCanManageProjects] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [projectsRequest, setProjectsRequest] = useState(0);
  const connectDraft = useRef<AgentConnectDraft>();
  const currentLocation = typeof window === 'undefined'
    ? routerLocation
    : {
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      };
  const context = resolveAgentPageContext(currentLocation, requestedContextId);
  const params = new URLSearchParams(routerLocation.search);
  const initialProjectIds = [...new Set(params.getAll(AGENT_REPOSITORY_QUERY))];
  const showFloatingEntry = STANDALONE_PATHS.has(currentLocation.pathname);

  useEffect(() => {
    const openAgentAccess = (event: Event): void => {
      const detail = (event as CustomEvent<{ contextId?: AgentPageContextId }>).detail;
      connectDraft.current = undefined;
      setRequestedContextId(detail?.contextId);
      setOpen(true);
    };
    window.addEventListener(OPEN_AGENT_ACCESS_EVENT, openAgentAccess);
    return () => window.removeEventListener(OPEN_AGENT_ACCESS_EVENT, openAgentAccess);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const ctrl = new AbortController();
    setProjects(null);
    setCanManageProjects(false);
    setProjectsError('');
    apiRequest<AgentProjectsResponse>('/api/projects', { signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
        if (!Array.isArray(data.projects)) throw new Error('Invalid projects response');
        setCanManageProjects(data.canManageProjects !== false);
        setProjects(data.projects.map((project) => ({
          id: project.id,
          name: project.aliasName || project.name || project.slug || project.id,
          slug: project.slug || project.id,
          githubRepoFullName: project.githubRepoFullName,
          branchCount: project.branchCount,
          runningBranchCount: project.runningBranchCount,
          runningServiceCount: project.runningServiceCount,
          agentProfile: project.agentProfile,
        })));
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || (err as DOMException)?.name === 'AbortError') return;
        setProjects([]);
        // Anonymous onboarding can request a first project without reading existing projects.
        // An explicit page project still remains unavailable in the dialog until resolved.
        setProjectsError(err instanceof ApiError && err.status === 401
          ? ''
          : '项目范围暂时无法确认，请重新读取；尚未生成接入口令。');
      });
    return () => ctrl.abort();
  }, [open, projectsRequest]);

  useEffect(() => {
    const routeParams = new URLSearchParams(routerLocation.search);
    if (!routeParams.has(AGENT_ACCESS_QUERY) && !routeParams.has(AGENT_ADD_REPOSITORY_QUERY)) connectDraft.current = undefined;
    setRequestedContextId(undefined);
    setOpen(routeParams.get(AGENT_ACCESS_QUERY) === '1');
  }, [routerLocation.pathname, routerLocation.search, routerLocation.hash]);

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    if (!nextOpen) setRequestedContextId(undefined);
    if (!nextOpen) connectDraft.current = undefined;
    if (!nextOpen && params.has(AGENT_ACCESS_QUERY)) {
      params.delete(AGENT_ACCESS_QUERY);
      params.delete(AGENT_REPOSITORY_QUERY);
      navigate({ pathname: routerLocation.pathname, search: params.toString(), hash: routerLocation.hash }, { replace: true });
    }
  };

  const addRepository = (projectIds: string[], draft: AgentConnectDraft): void => {
    connectDraft.current = draft;
    const next = new URLSearchParams({ [AGENT_ADD_REPOSITORY_QUERY]: '1' });
    projectIds.forEach((id) => next.append(AGENT_REPOSITORY_QUERY, id));
    navigate(`/project-list?${next}`);
  };

  return (
    <>
      {showFloatingEntry ? (
        <button
          type="button"
          className="cds-agent-access-floating"
          onClick={() => {
            setRequestedContextId(context.id);
            setOpen(true);
          }}
          data-agent-action="connect"
          data-agent-context={context.id}
          data-agent-page={context.pagePath}
          data-preview-instance={isChildPreviewCdsInstance() ? 'true' : 'false'}
          aria-label="接入 Agent"
        >
          <Bot />
          <span>接入 Agent</span>
        </button>
      ) : null}
      <SkillDownloadDialog
        open={open}
        onOpenChange={handleOpenChange}
        projects={projects || []}
        projectsLoading={projects === null}
        projectsError={projectsError}
        canManageProjectKeys={canManageProjects}
        onReloadProjects={() => setProjectsRequest((value) => value + 1)}
        context={context}
        initialProjectIds={initialProjectIds}
        initialDraft={connectDraft.current}
        onAddRepository={addRepository}
      />
    </>
  );
}
