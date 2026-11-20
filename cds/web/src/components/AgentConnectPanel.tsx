import { useEffect, useState } from 'react';
import { Cloud, Copy, Download, FolderPlus, Folders, Github, KeyRound, Plus, Settings2, ShieldCheck, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MotionLink } from '@/components/layout/RouteMotion';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { GitHubDeviceFlowPanel } from '@/pages/cds-settings/tabs/GitHubAppTab';
import { buildQuickAgentPrompt, type QuickAgentScope } from '@/lib/agent-onboarding';
import { AGENT_ROLE_PROFILES, type AgentRoleId } from '@/lib/agent-starter';
import type { AgentProjectOption } from '@/components/SkillDownloadDialog';

const MODES = [
  { key: 'local', label: '本地接入', icon: Terminal },
  { key: 'cloud', label: '云端接入', icon: Cloud },
] as const;
const SCOPES = [
  { key: 'new', label: '新仓库', icon: FolderPlus },
  { key: 'existing', label: '现有仓库', icon: Folders },
  { key: 'admin', label: '管理员', icon: ShieldCheck },
] as const;
const DEFAULT_SKILL: SkillChoice = { key: 'findmapskills', title: '查找 MAP 技能' };
const FIELD = 'min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm';
const CARD = 'space-y-3 rounded-xl border border-border bg-muted/30 p-3 sm:p-4';
const SEGMENT = 'flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1.5 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm';
type Mode = typeof MODES[number]['key'];
interface SkillChoice { key: string; title: string; recommendedRoles?: AgentRoleId[] }
export interface AgentConnectDraft {
  mode: Mode;
  future: boolean;
  name: string;
  advanced: boolean;
  skillIds: string[];
  role: AgentRoleId | '';
}

interface Props {
  projects: AgentProjectOption[];
  loading: boolean;
  error: string;
  canManageProjects: boolean;
  initialProjectIds: string[];
  initialDraft?: AgentConnectDraft;
  origin: string;
  loadSkills: (signal: AbortSignal) => Promise<SkillChoice[]>;
  onAddRepository?: (projectIds: string[], draft: AgentConnectDraft) => void;
  onReloadProjects?: () => void;
  onClose: () => void;
}

export function AgentConnectPanel({
  projects, loading, error, canManageProjects, initialProjectIds, initialDraft, origin, loadSkills,
  onAddRepository, onReloadProjects, onClose,
}: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>(initialDraft?.mode || 'local');
  const [scope, setScope] = useState<QuickAgentScope>('existing');
  const [projectIds, setProjectIds] = useState(initialProjectIds);
  const [future, setFuture] = useState(initialDraft?.future || false);
  const [name, setName] = useState(initialDraft?.name || '');
  const [advanced, setAdvanced] = useState(initialDraft?.advanced || false);
  const [skillOptions, setSkillOptions] = useState<SkillChoice[] | null>(null);
  const [skillsError, setSkillsError] = useState('');
  const [skillRequest, setSkillRequest] = useState(0);
  const [skillIds, setSkillIds] = useState(initialDraft?.skillIds || [DEFAULT_SKILL.key]);
  const [role, setRole] = useState<AgentRoleId | ''>(initialDraft?.role || '');
  const [githubOpen, setGithubOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [generated, setGenerated] = useState(false);

  useEffect(() => {
    if (!advanced || skillOptions) return undefined;
    const controller = new AbortController();
    setSkillsError('');
    void loadSkills(controller.signal).then((data) => {
      if (!controller.signal.aborted) setSkillOptions(data);
    }, () => {
      if (!controller.signal.aborted) setSkillsError('暂时无法读取技能清单。');
    });
    return () => controller.abort();
  }, [advanced, skillOptions, loadSkills, skillRequest]);

  const selected = scope === 'existing' ? projects.filter((project) => projectIds.includes(project.id)) : [];
  const unavailable = scope === 'existing' && selected.length !== projectIds.length;
  const allSelected = projects.length > 0 && selected.length === projects.length && !unavailable;
  const discovery = scope === 'existing' && selected.length === 0;
  const title = scope === 'admin' ? '管理员权限' : scope === 'new' ? '新仓库权限' : discovery ? '待核对仓库' : '项目权限';
  const target = scope === 'admin' ? 'CDS 实例' : scope === 'new' ? '由智能体创建' : discovery ? '当前 GitHub 仓库' : selected.map((project) => project.name).join('、');
  const displayName = name.trim() || `${target} · ${mode === 'local' ? '本地' : '云端'}`;
  const choices = [DEFAULT_SKILL, ...(skillOptions || []).filter((skill) => skill.key !== DEFAULT_SKILL.key)];
  const selectedSkills = skillIds.map((key) => choices.find((skill) => skill.key === key) || { key, title: key });
  const recommended = role ? choices.filter((skill) => skill.recommendedRoles?.includes(role)) : [];
  const updateProjects = (ids: string[]): void => {
    setProjectIds(ids);
    if (projects.some((project) => !ids.includes(project.id))) setFuture(false);
  };

  if (generated) {
    return (
      <div className="space-y-4" data-agent-connect-result={mode}>
        <p className="break-words text-sm text-muted-foreground">{displayName}</p>
        {mode === 'local' ? (
          <LocalDelivery prompt={buildQuickAgentPrompt({
            origin, scope, projects: selected, name: displayName, skills: skillIds, followFuture: future && allSelected,
          })} />
        ) : (
          <CloudDelivery origin={origin} scope={scope} projects={selected} skills={selectedSkills}
            followFuture={future && allSelected} canManageProjects={canManageProjects} onClose={onClose} />
        )}
        <details className="rounded-lg border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium">智能体接入助手</summary>
          <p className="mt-2 text-muted-foreground">请智能体回报目标、接入结果和下一步。需要审批时，先指出待批准的项目和页面入口。</p>
        </details>
        <Button className="w-full" variant="outline" onClick={() => setGenerated(false)}>返回修改</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-agent-connect-panel>
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1" role="group" aria-label="接入方式">
        {MODES.map(({ key, label, icon: Icon }) => (
          <button key={key} type="button" className={SEGMENT} aria-pressed={mode === key} onClick={() => setMode(key)}>
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{label}
          </button>
        ))}
      </div>
      <section className="space-y-2" aria-labelledby="cds-agent-scope-label">
        <h3 id="cds-agent-scope-label" className="text-sm font-semibold">选择仓库</h3>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" role="group" aria-labelledby="cds-agent-scope-label">
          {SCOPES.map(({ key, label, icon: Icon }) => (
            <button key={key} type="button" className={SEGMENT} aria-pressed={scope === key} onClick={() => setScope(key)}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />{label}
            </button>
          ))}
        </div>
        {scope === 'existing' ? (
          <div className={CARD}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex min-h-9 items-center gap-2 text-sm font-medium">
                <input type="checkbox" className="accent-primary" checked={allSelected} disabled={loading || !!error || projects.length === 0}
                  onChange={(event) => updateProjects(event.target.checked ? projects.map((project) => project.id) : [])} />
                全部选择
              </label>
              {canManageProjects && onAddRepository ? (
                <Button size="sm" variant="outline"
                  onClick={() => onAddRepository(projectIds, { mode, future, name, advanced, skillIds, role })}><Plus />添加</Button>
              ) : null}
            </div>
            {loading ? <ContentLoading label="读取仓库" variant="inline" /> : null}
            {error ? <div role="alert" className="space-y-2 text-sm">
              <p>{error}</p>
              {onReloadProjects ? <Button size="sm" variant="outline" onClick={onReloadProjects}>重试</Button> : null}
            </div> : null}
            {!loading && !error ? <div className="max-h-48 divide-y divide-border overflow-y-auto overscroll-contain">
              {projects.map((project) => (
                <label key={project.id} className="flex min-h-10 items-center gap-2 py-1.5 text-sm">
                  <input type="checkbox" className="accent-primary" checked={projectIds.includes(project.id)}
                    onChange={(event) => updateProjects(event.target.checked
                      ? [...projectIds, project.id] : projectIds.filter((id) => id !== project.id))} />
                  <span className="min-w-0 break-words">
                    <span className="font-medium">{project.name}</span>
                    <span className="ml-2 text-muted-foreground">{project.githubRepoFullName || project.slug}</span>
                  </span>
                </label>
              ))}
              {!projects.length ? <p className="text-sm text-muted-foreground">暂无可选仓库。</p> : null}
            </div> : null}
            {!loading && !error && unavailable ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
              <span>部分已选仓库已不可见。</span>
              <Button size="sm" variant="outline" onClick={() => updateProjects(selected.map((project) => project.id))}>移除不可见项</Button>
            </div> : null}
            {allSelected ? <label className="flex min-h-9 items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary" checked={future} onChange={(event) => setFuture(event.target.checked)} />
              以后也接入新获授权的仓库
            </label> : null}
            {discovery && !loading && !error ? <p className="text-sm text-muted-foreground">可以留空。智能体会先核对当前仓库的 GitHub 地址。</p> : null}
          </div>
        ) : null}
        {scope === 'new' ? <div className={CARD}>
          <p className="text-sm">把配置交给智能体。它会和你确认名称、归属和可见性，再创建仓库。</p>
          <Button size="sm" variant="outline" aria-expanded={githubOpen} onClick={() => setGithubOpen(!githubOpen)}>
            <Github />授权 GitHub 账号
          </Button>
          {githubOpen ? <GitHubDeviceFlowPanel onToast={setNotice} /> : null}
        </div> : null}
      </section>
      <section className={CARD} aria-label="权限范围">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="min-w-0 break-words text-sm font-semibold">{title} · {target}</h3>
          <Button size="sm" variant="outline" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Settings2 />高级设置</Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {scope === 'admin' ? '通过已有管理员账号核对身份，管理用户、授权和审计。'
            : scope === 'new' ? '仓库创建后，在 CDS 单独申请一次项目创建授权。'
              : discovery ? '先查询，确认目标后才提交授权申请。' : '推送、部署和更新仅覆盖已选项目。'}
        </p>
        <p className="text-sm text-muted-foreground">搭配技能　{selectedSkills.map((skill) => skill.key).join('、') || '未添加'}</p>
        {future && allSelected ? <p className="text-sm text-muted-foreground">未来仓库获得账号授权后，需要按项目补充凭据。</p> : null}
        {advanced ? <div className="space-y-3 border-t border-border pt-3">
          <label className="block space-y-1 text-sm">
            <span>接入名称（可选）</span>
            <input className={FIELD} value={name} maxLength={60} placeholder={displayName} onChange={(event) => setName(event.target.value)} />
          </label>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">搭配技能</legend>
            <div className="grid max-h-48 gap-1 overflow-y-auto overscroll-contain sm:grid-cols-2">
              {choices.map((skill) => (
                <label key={skill.key} className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-primary" checked={skillIds.includes(skill.key)}
                    onChange={(event) => setSkillIds((ids) => event.target.checked ? [...ids, skill.key] : ids.filter((id) => id !== skill.key))} />
                  <span>{skill.key === DEFAULT_SKILL.key ? `${skill.key} · ${skill.title}` : skill.title}</span>
                </label>
              ))}
            </div>
            {!skillOptions && !skillsError ? <ContentLoading label="读取可选技能" variant="inline" /> : null}
            {skillsError ? <div className="flex items-center gap-2 text-sm" role="alert">
              <span>{skillsError}</span><Button size="sm" variant="outline" onClick={() => setSkillRequest((value) => value + 1)}>重试</Button>
            </div> : null}
          </fieldset>
          {skillOptions?.length ? <div className="space-y-2">
            <label className="block space-y-1 text-sm">
              <span>按角色看推荐</span>
              <select className={FIELD} value={role} onChange={(event) => setRole(event.target.value as AgentRoleId | '')}>
                <option value="">选择角色（可选）</option>
                {AGENT_ROLE_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
              </select>
            </label>
            {recommended.length ? <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">{recommended.map((skill) => skill.title).join('、')}</p>
              <Button size="sm" variant="outline" onClick={() => setSkillIds((ids) => [...new Set([...ids, ...recommended.map((skill) => skill.key)])])}>
                加入推荐技能
              </Button>
            </div> : null}
          </div> : null}
        </div> : null}
      </section>
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      <Button className="min-h-12 w-full" disabled={scope === 'existing' && (loading || unavailable || !!error)}
        onClick={() => setGenerated(true)}>
        生成接入配置
      </Button>
    </div>
  );
}

function LocalDelivery({ prompt }: { prompt: string }): JSX.Element {
  const [status, setStatus] = useState('');
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus('已复制');
    } catch {
      setStatus('复制失败，可以选中下方口令手动复制。');
    }
  };
  return <section className={CARD} aria-label="本地口令">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">本地接入口令</h3>
      <Button size="sm" variant="outline" onClick={() => void copy()}><Copy />复制口令</Button>
    </div>
    <p className="text-sm text-muted-foreground">把口令交给本地智能体。</p>
    <pre className="max-h-64 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-xs">{prompt}</pre>
    <p className="text-sm text-muted-foreground" role="status">{status}</p>
  </section>;
}

function CloudDelivery({ origin, scope, projects, skills, followFuture, canManageProjects, onClose }: {
  origin: string; scope: QuickAgentScope; projects: AgentProjectOption[]; skills: SkillChoice[];
  followFuture: boolean; canManageProjects: boolean; onClose: () => void;
}): JSX.Element {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const project = projects.find((item) => item.id === projectId);
  const projectKeyLink = new URLSearchParams({ agentKeys: projectId });
  return <section className={CARD} aria-label="云端接入配置">
    <details open>
      <summary className="cursor-pointer text-sm font-semibold">CDS 技能包</summary>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline"><a href="/api/skills/cds-pack/download" download><Download />下载 CDS 技能包</a></Button>
        {skills.map((skill) => <Button key={skill.key} asChild size="sm" variant="outline">
          <a href={`/api/skills/${encodeURIComponent(skill.key)}/download`} download><Download />{skill.key}</a>
        </Button>)}
      </div>
    </details>
    <details className="border-t border-border pt-3" open>
      <summary className="cursor-pointer text-sm font-semibold">环境变量</summary>
      <div className="mt-2 space-y-2">
        {projects.length > 1 ? <label className="block space-y-1 text-sm">
          <span>按仓库查看环境变量</span>
          <select className={FIELD} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label> : null}
        {scope === 'admin' ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">管理员操作需要已获授权的浏览器会话。</p>
            <Button asChild size="sm" variant="outline"><MotionLink to="/cds-settings#users" onClick={onClose}>打开用户管理</MotionLink></Button>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-background p-3 font-mono text-xs">{
            [`CDS_HOST=${origin}`, ...(project ? [`CDS_PROJECT_ID=${project.id}`, 'CDS_PROJECT_KEY=<所选项目签发的密钥>'] : [])].join('\n')
          }</pre>
        )}
        {project && canManageProjects ? <Button asChild size="sm" variant="outline">
          <MotionLink to={`/project-list?${projectKeyLink}`} onClick={onClose}><KeyRound />签发项目密钥</MotionLink>
        </Button> : project ? <p className="text-sm text-muted-foreground">请项目管理员签发密钥。</p> : null}
        {scope === 'new' ? <p className="text-sm text-muted-foreground">由智能体创建仓库和 CDS 项目后，再签发该项目的密钥。</p> : null}
        {scope === 'existing' && !project ? <p className="text-sm text-muted-foreground">安装技能后请智能体核对 GitHub 仓库。确认项目后获取项目变量。</p> : null}
        {followFuture ? <p className="text-sm text-muted-foreground">以后为新获授权的项目单独签发密钥，并添加到对应云环境。</p> : null}
      </div>
    </details>
  </section>;
}
