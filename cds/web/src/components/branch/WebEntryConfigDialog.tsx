/*
 * WebEntryConfigDialog —— 手动配置多出口（2026-08-31）。
 *
 * 为什么有这个弹窗：多出口此前只有一条路——让 Agent 去改 cds-compose.yml 的
 * `cds.subdomain` / `cds.web-entry-*` 标签再重新导入项目。用户想自己加一条
 * 「左边域名 → 右边端口」的入口就得找人。本弹窗把同一份配置开成可视化表单。
 *
 * 服务端契约：GET/PUT /api/branches/:id/web-entry-config
 *   - GET 扫描本分支所有服务（端口 / 运行状态 / 当前入口 / 值来自项目还是分支）
 *   - PUT { scope: 'project' | 'branch', entries: [{ serviceId, name, subdomain, path }] }
 *
 * 最小输入（minimal-user-input）：端口、服务名、当前入口全部由扫描带出来，
 * 用户只填「域名前缀 + 入口名称」这两个系统猜不到的字段；地址即时预览，
 * 不必等保存完再去别处看自己配出了什么。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError, apiRequest } from '@/lib/api';

export interface WebEntryConfigService {
  serviceId: string;
  serviceName: string;
  origin: 'project' | 'branch';
  containerPort: number | null;
  hostPort: number | null;
  status: string;
  handlesRoot: boolean;
  pathPrefixes: string[];
  project: { subdomain: string; name: string; path: string };
  branchOverride: { subdomain: string; name: string; path: string } | null;
  effective: { subdomain: string; name: string; path: string; primary: boolean };
  url: string;
}

interface ConfigResponse {
  branchId: string;
  rootDomain: string;
  previewSlug: string;
  services: WebEntryConfigService[];
  /** 托管交付项目没有可写的「项目档」（服务清单由 CDS 按方案生成并覆盖），只能存分支 */
  supportsProjectScope?: boolean;
}

type Scope = 'project' | 'branch';

interface Row {
  serviceId: string;
  name: string;
  subdomain: string;
  path: string;
}

/** 与后端 isValidServiceSubdomain 同款判据，让用户在提交前就看到哪一格不合法。 */
function invalidSubdomain(sub: string): boolean {
  if (!sub) return false;
  return !/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(sub);
}

/** DNS 首标签上限；与服务端 preview-entrypoints 的 DNS_LABEL_MAX_LENGTH 同值。 */
const DNS_LABEL_MAX_LENGTH = 63;

/**
 * 这条子域的命名 host 能不能在浏览器里**原样**算出来。
 *
 * 服务端 `namedServiceLabel()` 是命名 host 的唯一拼法：超过 63 字符时它会按段截断
 * previewSlug 再接一段 sha1 摘要。那套压缩逻辑绝不能在前端复刻（复刻就是判据分裂，
 * 两端一改就漂），所以只在「不需要压缩」的长度区间内才由前端拼——这个区间里
 * 拼出来的字符串与服务端逐字相同。超出区间就不显示地址，如实说明保存后才知道
 * （Codex review 第四轮 P1：此前无条件拼，长分支会把一条解析不了的地址当真地址展示）。
 */
function canRenderNamedHostLocally(previewSlug: string, subdomain: string): boolean {
  return `${previewSlug}-${subdomain}`.length <= DNS_LABEL_MAX_LENGTH;
}

/**
 * 表单行 → 地址预览。口径与后端 readWebEntryConfig 一致：有子域走命名 host，
 * 承载根路径的主应用走主域名。这里只是草稿预览，真正的 URL 以保存后服务端返回的为准；
 * 未改动的行直接用服务端下发的 `service.url`，不本地推。
 */
function previewUrlFor(
  row: Row,
  service: WebEntryConfigService | undefined,
  previewSlug: string,
  rootDomain: string,
): string {
  // 非法子域拼出来的 host 根本发不出去，别把它渲染成一条可点的地址骗人
  if (!row.name || !previewSlug || invalidSubdomain(row.subdomain)) return '';
  // 这一行跟服务端扫描回来的值一模一样 → 直接用服务端算好的地址（权威口径）
  if (service?.url
    && row.subdomain === service.effective.subdomain
    && row.name === service.effective.name
    && row.path === (service.effective.path || '/')) {
    return service.url;
  }
  const path = row.path && row.path !== '/' ? row.path : '';
  if (row.subdomain && !service?.handlesRoot) {
    if (!canRenderNamedHostLocally(previewSlug, row.subdomain)) return '';
    return `https://${previewSlug}-${row.subdomain}.${rootDomain}${path}`;
  }
  const prefix = (service?.pathPrefixes || []).map((p) => p.trim()).find((p) => p && p !== '/');
  if (!service?.handlesRoot && prefix) {
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return `https://${previewSlug}.${rootDomain}${path === '' ? `${base}/` : `${base}${path}`}`;
  }
  return `https://${previewSlug}.${rootDomain}${path}`;
}

export function WebEntryConfigDialog({
  open,
  branchId,
  onClose,
  onSaved,
}: {
  open: boolean;
  branchId: string;
  onClose: () => void;
  /** 保存成功后通知调用方重拉入口卡；参数是给 toast 的一句话。 */
  onSaved?: (message: string) => void;
}): JSX.Element {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  // 请求代次 + 当前 branchId 镜像：用来丢弃迟到的扫描响应（详见 load 里的注释）
  const loadGenerationRef = useRef(0);
  const branchIdRef = useRef(branchId);
  useEffect(() => {
    branchIdRef.current = branchId;
    // 切分支时先清空，免得新分支的弹窗短暂显示上一条分支的行
    setConfig(null);
    setRows([]);
  }, [branchId]);
  const [scope, setScope] = useState<Scope>('project');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!branchId) return;
    // 迟到的响应必须丢掉：先给分支 A 开弹窗、关掉再开分支 B 时，A 的 GET 可能后到，
    // 无条件写 state 会让界面显示 A 的值、保存却打到 B 的 branchId 上（web / api
    // 这类 id 在两边都存在，服务端会照单全收）——等于拿 A 的配置覆盖 B（Codex review P2）。
    const requestedBranchId = branchId;
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const isStale = () => generation !== loadGenerationRef.current || requestedBranchId !== branchIdRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await apiRequest<ConfigResponse>(`/api/branches/${encodeURIComponent(requestedBranchId)}/web-entry-config`);
      if (isStale()) return;
      setConfig(res);
      // 已有入口（或已有命名子域）的服务先摆出来；其余服务留给「新增入口」按需添加，
      // 免得一屏十几行空表单。
      setRows(
        (res.services || [])
          .filter((s) => s.effective.name || s.effective.subdomain)
          .map((s) => ({
            serviceId: s.serviceId,
            name: s.effective.name,
            subdomain: s.effective.subdomain,
            path: s.effective.path || '/',
          })),
      );
      // 托管交付项目只能存分支；否则分支上已有覆盖时默认停在分支档，免得一保存就抹平特例
      const projectScopeAllowed = res.supportsProjectScope !== false;
      setScope(!projectScopeAllowed || (res.services || []).some((s) => s.branchOverride) ? 'branch' : 'project');
    } catch (err) {
      if (isStale()) return;
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [branchId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const serviceById = useMemo(
    () => new Map((config?.services || []).map((s) => [s.serviceId, s])),
    [config],
  );
  // 托管交付项目没有可写的项目档，只留「仅本分支」
  const projectScopeDisabled = config?.supportsProjectScope === false;
  const remainingServices = useMemo(
    () => (config?.services || []).filter((s) => !rows.some((r) => r.serviceId === s.serviceId)),
    [config, rows],
  );

  const updateRow = (index: number, patch: Partial<Row>): void => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const addRow = (serviceId: string): void => {
    const service = serviceById.get(serviceId);
    if (!service) return;
    setRows((prev) => [
      ...prev,
      {
        serviceId,
        // 名称/子域给可用的默认值（anti-detour：不给空白框），用户改差异即可。
        name: service.serviceName || serviceId,
        subdomain: service.handlesRoot ? '' : serviceId.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40),
        path: '/',
      },
    ]);
  };

  const localError = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of rows) {
      if (invalidSubdomain(row.subdomain)) {
        return `子域 "${row.subdomain}" 非法：只能用小写字母、数字、连字符，不以连字符开头结尾`;
      }
      // 「有子域没名称」合法：API-only 服务（如网关 serving）就是这个形态——
      // 有一条可被调用的命名 URL，但不该出现在用户入口清单里。
      if (row.path && !row.path.startsWith('/')) return `入口路径 "${row.path}" 必须以 / 开头`;
      if (row.subdomain) {
        const owner = seen.get(row.subdomain);
        if (owner) return `子域 "${row.subdomain}" 被 ${owner} 和 ${row.serviceId} 同时使用`;
        seen.set(row.subdomain, row.serviceId);
      }
      if (scope === 'project' && serviceById.get(row.serviceId)?.origin !== 'project') {
        return `"${row.serviceId}" 是分支临时服务，只能保存到当前分支`;
      }
    }
    return '';
  }, [rows, scope, serviceById]);

  const handleSave = async (): Promise<void> => {
    if (localError) { setError(localError); return; }
    setSaving(true);
    setError('');
    try {
      // 整份提交：被删掉的行以「空名 + 空子域」回传，服务端才知道那条入口要清掉。
      const submitted = new Map(rows.map((r) => [r.serviceId, r]));
      const entries = (config?.services || [])
        .filter((s) => scope === 'branch' || s.origin === 'project')
        .map((s) => {
          const row = submitted.get(s.serviceId);
          return {
            serviceId: s.serviceId,
            name: row?.name?.trim() || '',
            subdomain: row?.subdomain?.trim().toLowerCase() || '',
            path: row?.path?.trim() || '/',
          };
        });
      const res = await apiRequest<{ message?: string }>(
        `/api/branches/${encodeURIComponent(branchId)}/web-entry-config`,
        { method: 'PUT', body: { scope, entries } },
      );
      onSaved?.(res.message || '入口配置已保存');
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';
  const labelClass = 'mb-1 block text-xs font-medium text-muted-foreground';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>配置入口（多出口）</DialogTitle>
          <DialogDescription>
            左边填域名前缀，右边选服务端口，下面就是这条入口的真实地址。保存后几秒内生效，不需要重新部署。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">保存到</span>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                className="h-4 w-4"
                checked={scope === 'project'}
                disabled={projectScopeDisabled}
                onChange={() => setScope('project')}
              />
              项目（该项目所有分支）
            </label>
            <label className="flex items-center gap-1.5 text-sm">
              <input type="radio" className="h-4 w-4" checked={scope === 'branch'} onChange={() => setScope('branch')} />
              仅本分支
            </label>
            {projectScopeDisabled ? (
              <span className="text-xs text-muted-foreground">
                托管交付项目的服务清单由 CDS 按方案生成，项目档会被下次生成覆盖，只能存本分支
              </span>
            ) : null}
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : undefined} />
              重新扫描
            </Button>
          </div>

          {loading && !config ? (
            <div className="px-1 py-6 text-sm text-muted-foreground">正在扫描本分支的服务与端口…</div>
          ) : null}

          {rows.length === 0 && !loading ? (
            <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] px-3 py-6 text-center text-sm text-muted-foreground">
              还没有配置入口。点下面的「新增入口」，给某个服务起个域名前缀。
            </div>
          ) : null}

          {rows.map((row, index) => {
            const service = serviceById.get(row.serviceId);
            const url = previewUrlFor(row, service, config?.previewSlug || '', config?.rootDomain || '');
            // 有子域没名称 = API-only 服务：路由照发，只是不进用户入口清单。
            // 这条地址仍然要给出来，否则用户以为自己什么都没配到。
            const routeOnlyUrl = !row.name && row.subdomain && !invalidSubdomain(row.subdomain)
              && !service?.handlesRoot && config?.previewSlug
              && canRenderNamedHostLocally(config.previewSlug, row.subdomain)
              ? `https://${config.previewSlug}-${row.subdomain}.${config.rootDomain}`
              : '';
            // 需要服务端压缩首标签（分支名过长）时前端算不出真地址，如实说明而不是编一个
            const hostNeedsServerSide = Boolean(row.subdomain)
              && !invalidSubdomain(row.subdomain)
              && !service?.handlesRoot
              && Boolean(config?.previewSlug)
              && !canRenderNamedHostLocally(config?.previewSlug || '', row.subdomain);
            return (
              <div key={row.serviceId} className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/30 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{service?.serviceName || row.serviceId}</span>
                  <span className="rounded bg-[hsl(var(--surface-raised))] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {row.serviceId}
                  </span>
                  {service?.containerPort ? (
                    <span className="rounded bg-[hsl(var(--surface-raised))] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      容器端口 {service.containerPort}
                    </span>
                  ) : null}
                  {service?.origin === 'branch' ? (
                    <span className="rounded bg-[hsl(var(--surface-raised))] px-1.5 py-0.5 text-[10px] text-muted-foreground">分支临时服务</span>
                  ) : null}
                  {service?.branchOverride ? (
                    <span className="rounded border border-warn/40 px-1.5 py-0.5 text-[10px] text-warn">当前值来自本分支覆盖</span>
                  ) : null}
                  {/* primary 由 compose 声明、本表单不编辑，标出来是让用户知道改名不会换掉主入口 */}
                  {service?.effective.primary ? (
                    <span className="rounded border border-ok/40 px-1.5 py-0.5 text-[10px] text-ok">主入口</span>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto text-muted-foreground"
                    onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                    title="移除这条入口"
                  >
                    <Trash2 />
                    移除
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <label className={labelClass}>域名前缀（子域）</label>
                    <input
                      className={`${inputClass} font-mono`}
                      value={row.subdomain}
                      onChange={(e) => updateRow(index, { subdomain: e.target.value })}
                      placeholder={service?.handlesRoot ? '主应用无需子域' : 'llmgw'}
                      disabled={service?.handlesRoot}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>入口名称（面板上显示）</label>
                    <input
                      className={inputClass}
                      value={row.name}
                      onChange={(e) => updateRow(index, { name: e.target.value })}
                      placeholder="LLM Gateway"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>落地路径</label>
                    <input
                      className={`${inputClass} font-mono`}
                      value={row.path}
                      onChange={(e) => updateRow(index, { path: e.target.value })}
                      placeholder="/"
                    />
                  </div>
                </div>

                <div className="mt-2 flex min-w-0 items-center gap-2 text-xs">
                  <span className="shrink-0 text-muted-foreground">{routeOnlyUrl ? '路由地址' : '地址'}</span>
                  {routeOnlyUrl ? (
                    <span className="flex min-w-0 items-center gap-2">
                      <a
                        href={routeOnlyUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-foreground hover:underline"
                      >
                        <span className="truncate">{routeOnlyUrl}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                      </a>
                      <span className="shrink-0 text-muted-foreground">未命名，只发路由、不进入口清单</span>
                    </span>
                  ) : url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-ok hover:underline"
                    >
                      <span className="truncate">{url}</span>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground">
                      {invalidSubdomain(row.subdomain)
                        ? '子域不合法，改好后这里显示地址'
                        : hostNeedsServerSide
                          ? '分支名较长，实际地址由服务端压缩生成，保存后显示'
                          : '填入口名称后这里显示地址'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {remainingServices.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-[hsl(var(--hairline))] px-3 py-2">
              <Plus className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">新增入口，指向：</span>
              {remainingServices.map((s) => (
                <Button key={s.serviceId} variant="outline" size="sm" onClick={() => addRow(s.serviceId)}>
                  {s.serviceName || s.serviceId}
                  {s.containerPort ? <span className="ml-1 font-mono text-[10px] text-muted-foreground">:{s.containerPort}</span> : null}
                </Button>
              ))}
            </div>
          ) : null}

          {error || localError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error || localError}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={() => void handleSave()} disabled={saving || loading || Boolean(localError)}>
            {saving ? '保存中…' : scope === 'project' ? '保存到项目' : '保存到本分支'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
