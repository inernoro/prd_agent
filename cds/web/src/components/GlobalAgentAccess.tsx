import { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import { useLocation } from 'react-router-dom';

import { SkillDownloadDialog, type AgentProjectOption } from '@/components/SkillDownloadDialog';
import {
  OPEN_AGENT_ACCESS_EVENT,
  requestAgentAccess,
  resolveAgentPageContext,
  type AgentPageContextId,
} from '@/lib/agent-onboarding';
import { apiRequest } from '@/lib/api';

type AgentProjectsResponse = {
  projects?: Array<{
    id: string;
    name?: string;
    aliasName?: string | null;
    slug?: string;
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
  const [open, setOpen] = useState(false);
  const [requestedContextId, setRequestedContextId] = useState<AgentPageContextId | undefined>(undefined);
  const [projects, setProjects] = useState<AgentProjectOption[] | null>(null);
  const currentLocation = typeof window === 'undefined'
    ? routerLocation
    : {
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      };
  const context = resolveAgentPageContext(currentLocation, requestedContextId);
  const showFloatingEntry = STANDALONE_PATHS.has(currentLocation.pathname);

  useEffect(() => {
    const openAgentAccess = (event: Event): void => {
      const detail = (event as CustomEvent<{ contextId?: AgentPageContextId }>).detail;
      setRequestedContextId(detail?.contextId);
      setOpen(true);
    };
    window.addEventListener(OPEN_AGENT_ACCESS_EVENT, openAgentAccess);
    return () => window.removeEventListener(OPEN_AGENT_ACCESS_EVENT, openAgentAccess);
  }, []);

  useEffect(() => {
    if (!open || projects !== null) return undefined;
    const ctrl = new AbortController();
    apiRequest<AgentProjectsResponse>('/api/projects', { signal: ctrl.signal })
      .then((data) => {
        setProjects((data.projects || []).map((project) => ({
          id: project.id,
          name: project.aliasName || project.name || project.slug || project.id,
          slug: project.slug || project.id,
        })));
      })
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setProjects([]);
      });
    return () => ctrl.abort();
  }, [open, projects]);

  return (
    <>
      {showFloatingEntry ? (
        <button
          type="button"
          className="cds-agent-access-floating"
          onClick={() => requestAgentAccess(context.id)}
          data-agent-action="connect"
          data-agent-context={context.id}
          data-agent-page={context.pagePath}
          aria-label="接入 Agent"
        >
          <Bot />
          <span>接入 Agent</span>
        </button>
      ) : null}
      <SkillDownloadDialog
        open={open}
        onOpenChange={setOpen}
        projects={projects || []}
        context={context}
      />
    </>
  );
}
