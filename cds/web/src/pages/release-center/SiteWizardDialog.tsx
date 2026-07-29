/**
 * 添加 / 配置一个环境（站点发布目标）的向导。
 *
 * 与旧版相比多了一步实质变化：**环境类型可选**（生产 / 预发 / 其他）。
 * 旧版把 environment 写死成 production，于是「多环境」这件事在 UI 上根本不存在，
 * 左栏也就只能是一份目标列表而不是环境列表。
 */

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { buildReleaseHealthcheckUrl } from '@/lib/releaseCenter';
import { LoadingBlock } from '@/pages/cds-settings/components';
import { Chip } from './shared';
import { InlineHostCreator } from './InlineHostCreator';
import type {
  ReleaseStrategy,
  ReleaseStrategyCandidate,
  ReleaseStrategyDiscovery,
  RemoteHostOption,
  SiteDraft,
  WizardStep,
} from './types';

export const DEFAULT_HEALTH_PATH = '/api/health';

export const wizardSteps: Array<{ id: WizardStep; label: string }> = [
  { id: 'server', label: '选择服务器' },
  { id: 'site', label: '生产域名' },
  { id: 'scripts', label: '发布方式' },
  { id: 'health', label: '健康检查' },
];

const ENVIRONMENT_OPTIONS: Array<{ value: SiteDraft['environment']; label: string; hint: string }> = [
  { value: 'production', label: '生产', hint: '真正对外提供服务的那一套' },
  { value: 'staging', label: '预发', hint: '先发这里验一轮，再提升到生产' },
  { value: 'other', label: '其他', hint: '演示、内测等不参与主链路的环境' },
];

export function emptySiteDraft(projectId: string): SiteDraft {
  return {
    projectId,
    name: '',
    privateKeyRef: '',
    host: '',
    port: '22',
    user: '',
    sitePath: '',
    publicUrl: '',
    healthPath: DEFAULT_HEALTH_PATH,
    rollbackCommand: '',
    // 发布命令没有默认值：CDS 是通用产品，预填本仓库自己那条脚本链，
    // 任何别的项目建站点都会被预填一条根本不存在的命令。
    deployCommand: '',
    healthcheckUrl: '',
    strategyMode: 'existing-script',
    composeFile: 'compose.yml',
    composeProject: `${projectId.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}-prod`,
    buildCommand: 'pnpm install --frozen-lockfile && pnpm build',
    artifactDirectory: 'dist',
    publicDirectory: `/opt/${projectId}-web`,
    detectedFrom: [],
    isCanonical: true,
    environment: 'production',
  };
}

export function buildHealthcheckUrl(draft: SiteDraft): string {
  return buildReleaseHealthcheckUrl(draft.publicUrl, draft.healthPath, draft.healthcheckUrl);
}

export function SiteWizardDialog({
  open,
  draft,
  step,
  hosts,
  discovery,
  discovering,
  saving,
  onClose,
  onStep,
  onDraft,
  onSelectHost,
  onHostCreated,
  onSave,
}: {
  open: boolean;
  draft: SiteDraft;
  step: WizardStep;
  hosts: RemoteHostOption[];
  discovery: ReleaseStrategyDiscovery | null;
  discovering: boolean;
  saving: boolean;
  onClose: () => void;
  onStep: (step: WizardStep) => void;
  onDraft: Dispatch<SetStateAction<SiteDraft>>;
  onSelectHost: (hostId: string) => void;
  /** 就地新建服务器后：父级把这台主机并进列表并选中，向导原地继续。 */
  onHostCreated: (host: RemoteHostOption) => void | Promise<void>;
  onSave: () => void;
}): JSX.Element {
  const selectedHost = hosts.find((host) => host.id === draft.privateKeyRef);
  const canSave = Boolean(
    draft.name.trim()
    && draft.privateKeyRef
    && draft.sitePath.trim()
    && buildHealthcheckUrl(draft)
    && isDraftStrategyComplete(draft),
  );
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(896px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>{draft.id ? '配置环境' : '添加环境'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav className="grid content-start gap-2">
            {wizardSteps.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onStep(item.id)}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                  step === item.id
                    ? 'border-primary/45 bg-primary/10 text-primary'
                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'
                }`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-current/20 text-xs">{index + 1}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="min-h-[360px] space-y-4">
            {step === 'server' ? (
              <WizardPanel title="选择服务器" description="站点会发布到这台服务器的站点目录。没有现成的就在这里直接加一台，不用离开这个向导。">
                {hosts.length === 0 ? (
                  <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm text-muted-foreground">
                    还没有服务器。填下面这一段就能加一台，加完自动选中、继续下一步。
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {hosts.map((host) => (
                      <button
                        key={host.id}
                        type="button"
                        onClick={() => onSelectHost(host.id)}
                        className={`flex items-start justify-between gap-3 rounded-md border p-3 text-left ${
                          draft.privateKeyRef === host.id
                            ? 'border-primary/45 bg-primary/10'
                            : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 hover:bg-[hsl(var(--surface-sunken))]'
                        }`}
                      >
                        <span>
                          <span className="block text-sm font-medium">{host.name}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">{host.sshUser}@{host.host}:{host.sshPort}</span>
                        </span>
                        <Chip tone={host.isEnabled ? 'ok' : 'muted'}>{host.isEnabled ? '可用' : '已停用'}</Chip>
                      </button>
                    ))}
                  </div>
                )}
                {/* 这里绝对不能挂随 hosts.length 变化的 key。
                    新建成功后这台主机会立刻并进列表，hosts.length 从 0 变 1 →
                    带 key 的组件当场重挂 → 组件内的 created 状态被清空 →
                    刚生成的公钥凭空消失，而那把公钥是用户唯一一次拿到它的机会
                    （私钥留在服务端，公钥不贴到 authorized_keys 这台机器就永远连不上）。
                    2026-07-29 真人路径验收当场撞到，截图为证。 */}
                <InlineHostCreator
                  defaultOpen={hosts.length === 0}
                  onCreated={onHostCreated}
                />
              </WizardPanel>
            ) : null}

            {step === 'site' ? (
              <WizardPanel title="确认项目与远端目录" description="远端目录必须是当前项目的 Git 仓库。项目身份由 CDS 服务端写入目标，后续不一致会阻断发布。">
                <div className="grid gap-3 md:grid-cols-3">
                  <Field label="站点名称" value={draft.name} onChange={(value) => onDraft((c) => ({ ...c, name: value }))} placeholder="生产站点" />
                  <Field label="远端项目仓库" value={draft.sitePath} onChange={(value) => onDraft((c) => ({ ...c, sitePath: value }))} placeholder="/opt/project" />
                  <Field label="生产域名" value={draft.publicUrl} onChange={(value) => onDraft((c) => ({ ...c, publicUrl: value }))} placeholder="www.example.com" />
                </div>
                <div className="grid gap-1 text-sm">
                  <span className="text-muted-foreground">环境类型</span>
                  <div className="grid gap-2 md:grid-cols-3">
                    {ENVIRONMENT_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => onDraft((current) => ({ ...current, environment: option.value }))}
                        className={`rounded-md border p-3 text-left ${
                          draft.environment === option.value
                            ? 'border-primary/45 bg-primary/10'
                            : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 hover:bg-[hsl(var(--surface-sunken))]'
                        }`}
                      >
                        <span className="block text-sm font-medium">{option.label}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">{option.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
                  <div className="text-muted-foreground">服务器</div>
                  <div className="mt-1 font-mono">{selectedHost ? `${selectedHost.sshUser}@${selectedHost.host}:${selectedHost.sshPort}` : '尚未选择服务器'}</div>
                </div>
                <label className="flex items-start gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.isCanonical}
                    onChange={(event) => onDraft((current) => ({ ...current, isCanonical: event.target.checked }))}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-medium">设为该环境的主目标</span>
                    <span className="mt-1 block text-xs text-muted-foreground">同一项目和环境只能有一个启用的主目标；其他站点请取消勾选。</span>
                  </span>
                </label>
              </WizardPanel>
            ) : null}

            {step === 'scripts' ? (
              <WizardPanel title="确认发布方式" description="CDS 先扫描项目事实，再推荐发布方式；自动生成脚本会在每次发布时固化哈希，不写回项目仓库。">
                {discovering ? <LoadingBlock label="正在扫描项目发布能力" /> : null}
                {discovery ? (
                  <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-xs text-muted-foreground">
                    项目身份：{discovery.projectIdentity.projectSlug}
                    {discovery.projectIdentity.repository ? ` · ${discovery.projectIdentity.repository}` : ''}
                    <br />检测分支：{discovery.branchName}（{discovery.branchId}）
                  </div>
                ) : null}
                <div className="grid gap-2">
                  {releaseModeDefinitions(discovery, draft).map((item) => (
                    <button
                      key={item.mode}
                      type="button"
                      onClick={() => onDraft((current) => applyDiscoveredStrategy(current, item.strategy))}
                      className={`rounded-md border p-3 text-left ${draft.strategyMode === item.mode ? 'border-primary/45 bg-primary/10' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45'}`}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm font-medium">
                        <span>{item.label}</span>
                        <span className="text-xs text-muted-foreground">{item.confidence === 'high' ? '已检测' : item.confidence === 'medium' ? '建议复核' : '手动配置'}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
                    </button>
                  ))}
                </div>
                {draft.strategyMode === 'existing-script' ? (
                  <Field label="项目发布命令" value={draft.deployCommand} onChange={(value) => onDraft((c) => ({ ...c, deployCommand: value }))} placeholder="./deploy.sh" />
                ) : null}
                {draft.strategyMode === 'generated-compose' ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Compose 文件" value={draft.composeFile} onChange={(value) => onDraft((c) => ({ ...c, composeFile: value }))} placeholder="compose.yml" />
                    <Field label="Compose 项目名" value={draft.composeProject} onChange={(value) => onDraft((c) => ({ ...c, composeProject: value }))} placeholder="project-prod" />
                  </div>
                ) : null}
                {draft.strategyMode === 'generated-static' ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="构建命令" value={draft.buildCommand} onChange={(value) => onDraft((c) => ({ ...c, buildCommand: value }))} />
                    <Field label="产物目录" value={draft.artifactDirectory} onChange={(value) => onDraft((c) => ({ ...c, artifactDirectory: value }))} placeholder="dist" />
                    <div className="md:col-span-2">
                      <Field label="静态发布根目录" value={draft.publicDirectory} onChange={(value) => onDraft((c) => ({ ...c, publicDirectory: value }))} placeholder="/opt/project-web" />
                    </div>
                    <p className="md:col-span-2 text-xs text-muted-foreground">Web Server 根目录必须指向该目录下的 current。CDS 会保留 previous，并在入口探测失败时自动恢复。</p>
                  </div>
                ) : null}
              </WizardPanel>
            ) : null}

            {step === 'health' ? (
              <WizardPanel title="配置上线地址" description="上线地址用于发布后的健康检查，也是左栏那盏健康灯的判据来源。">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px]">
                  {draft.id ? (
                    <Field label="上线地址" value={draft.publicUrl} onChange={(value) => onDraft((c) => ({ ...c, publicUrl: value }))} placeholder="https://xxx.miduo.org" />
                  ) : (
                    <Field label="生产域名" value={draft.publicUrl} onChange={(value) => onDraft((c) => ({ ...c, publicUrl: value }))} placeholder="www.example.com" />
                  )}
                  <Field label="健康检查路径" value={draft.healthPath} onChange={(value) => onDraft((c) => ({ ...c, healthPath: value || DEFAULT_HEALTH_PATH }))} placeholder="/api/health" />
                </div>
                <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
                  <div className="text-muted-foreground">健康检查</div>
                  <div className="mt-1 break-all font-mono">{buildHealthcheckUrl(draft) || '填写上线地址后自动生成'}</div>
                </div>
                {draft.strategyMode === 'existing-script' ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.rollbackCommand)}
                      onChange={(event) => onDraft((c) => ({ ...c, rollbackCommand: event.target.checked ? './rollback.sh' : '' }))}
                    />
                    项目提供独立回滚脚本
                  </label>
                ) : (
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                    动态发布会保留上一成功版本；最终入口探测失败时自动恢复，也可从发布记录手动回滚。
                  </div>
                )}
                {draft.strategyMode === 'existing-script' && draft.rollbackCommand ? (
                  <Field label="回滚脚本" value={draft.rollbackCommand} onChange={(value) => onDraft((c) => ({ ...c, rollbackCommand: value }))} />
                ) : null}
              </WizardPanel>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] pt-4">
              <div className="text-xs text-muted-foreground">
                {draft.id ? '保存后不会自动发布。' : '保存后即可在概览页点「发布新版本」。'}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onClose}>取消</Button>
                <Button onClick={onSave} disabled={saving || !canSave}>
                  {saving ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
                  保存环境
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WizardPanel({ title, description, children }: { title: string; description: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }): JSX.Element {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
      />
    </label>
  );
}

export function releaseModeDefinitions(
  discovery: ReleaseStrategyDiscovery | null,
  draft: Pick<SiteDraft, 'composeProject' | 'publicDirectory'>,
): ReleaseStrategyCandidate[] {
  const detected = new Map((discovery?.candidates || []).map((candidate) => [candidate.mode, candidate]));
  const fallbacks: ReleaseStrategyCandidate[] = [
    {
      mode: 'existing-script',
      label: '项目现有脚本',
      description: '执行仓库已经维护的发布命令，CDS 负责预检、日志、入口探测和版本记录。',
      confidence: 'manual',
      strategy: { mode: 'existing-script', command: './deploy.sh' },
      requirements: ['项目已有可执行发布脚本'],
    },
    {
      mode: 'generated-compose',
      label: 'CDS 动态 Compose 发布',
      description: '项目没有发布脚本也能发布；CDS 为指定 commit 建隔离 worktree，并动态生成 Compose 执行脚本。',
      confidence: 'manual',
      strategy: { mode: 'generated-compose', composeFile: 'compose.yml', composeProject: draft.composeProject },
      requirements: ['远端安装 Git、Docker、Docker Compose'],
    },
    {
      mode: 'generated-static',
      label: 'CDS 动态静态站发布',
      description: '动态构建、离线验证 HTML 与入口资源、归一权限、原子切换 current 并保留 previous。',
      confidence: 'manual',
      strategy: {
        mode: 'generated-static',
        buildCommand: 'pnpm install --frozen-lockfile && pnpm build',
        artifactDirectory: 'dist',
        publicDirectory: draft.publicDirectory,
      },
      requirements: ['远端安装 Git、Bash、Python 3 与项目构建依赖'],
    },
  ];
  return fallbacks.map((fallback) => detected.get(fallback.mode) || fallback);
}

export function applyDiscoveredStrategy(draft: SiteDraft, strategy: ReleaseStrategy): SiteDraft {
  return {
    ...draft,
    strategyMode: strategy.mode,
    deployCommand: strategy.command || draft.deployCommand,
    composeFile: strategy.composeFile || draft.composeFile,
    composeProject: strategy.composeProject || draft.composeProject,
    buildCommand: strategy.buildCommand || draft.buildCommand,
    artifactDirectory: strategy.artifactDirectory || draft.artifactDirectory,
    publicDirectory: strategy.publicDirectory || draft.publicDirectory,
    detectedFrom: strategy.detectedFrom || [],
  };
}

export function strategyFromDraft(draft: SiteDraft): ReleaseStrategy {
  if (draft.strategyMode === 'existing-script') {
    return { mode: 'existing-script', command: draft.deployCommand.trim(), detectedFrom: draft.detectedFrom };
  }
  if (draft.strategyMode === 'generated-compose') {
    return {
      mode: 'generated-compose',
      composeFile: draft.composeFile.trim(),
      composeProject: draft.composeProject.trim(),
      detectedFrom: draft.detectedFrom,
    };
  }
  return {
    mode: 'generated-static',
    buildCommand: draft.buildCommand.trim(),
    artifactDirectory: draft.artifactDirectory.trim(),
    publicDirectory: draft.publicDirectory.trim(),
    detectedFrom: draft.detectedFrom,
  };
}

export function isDraftStrategyComplete(draft: SiteDraft): boolean {
  if (draft.strategyMode === 'existing-script') return Boolean(draft.deployCommand.trim());
  if (draft.strategyMode === 'generated-compose') return Boolean(draft.composeFile.trim() && draft.composeProject.trim());
  return Boolean(draft.buildCommand.trim() && draft.artifactDirectory.trim() && draft.publicDirectory.startsWith('/'));
}

