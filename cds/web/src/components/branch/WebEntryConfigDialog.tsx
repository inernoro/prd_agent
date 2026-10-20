import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Eye,
  Check,
  History,
  LoaderCircle,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError, apiRequest } from "@/lib/api";
import { ServiceEntryConfigDialog } from "./ServiceEntryConfigDialog";

interface Draft {
  mode: "branch" | "custom";
  branchName: string;
  projectSlug: string;
  customSubdomain: string;
  applyToProject: boolean;
}
interface Config {
  branchId: string;
  gitBranch: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  rootDomain: string;
  version: string;
  canEdit: boolean;
  draft: Draft;
  url: string;
}
interface Collision {
  reason: string;
  host: string;
  projectName: string;
  branchId?: string;
  canEdit?: boolean;
  href?: string;
}
interface Preview extends Config {
  changes: Array<{
    branchId: string;
    branch: string;
    before: string;
    after: string;
  }>;
  projectSlugBefore: string;
  projectSlugAfter: string;
  collisions: Collision[];
}
interface Audit {
  id: string;
  at: string;
  actor: string;
  branchId: string;
  action: string;
  scope: string;
  result: string;
  before?: unknown;
  after?: unknown;
}
interface Target {
  branchId: string;
  branch: string;
}
interface Verification extends Target {
  state: "waiting" | "checking" | "pass" | "fail";
  message?: string;
  results?: Array<{ name: string; url: string; ok: boolean; message: string }>;
}
const inputClass =
  "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-50";
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: unknown } | null;
    if (typeof body?.message === 'string') return body.message;
    if (err.status === 401) return '登录已过期，请重新登录后再试。';
    if (err.status === 403) return '没有权限执行此操作，请联系项目管理员。';
  }
  return '操作未完成，请重新加载后核对配置再重试。';
}
function sameDraft(a: Draft, b: Draft) {
  return (
    a.mode === b.mode &&
    (a.mode === "custom"
      ? a.customSubdomain === b.customSubdomain
      : a.branchName === b.branchName &&
        a.projectSlug === b.projectSlug &&
        !a.applyToProject)
  );
}
function auditText(value: unknown): string {
  if (value == null) return "无";
  if (typeof value === "string") return value;
  const v = value as {
    projectSlug?: string;
    addresses?: Array<{ branchId: string; url: string }>;
    results?: Array<{ name: string; url: string; message: string }>;
  };
  if (v.addresses)
    return [
      `项目 slug：${v.projectSlug}`,
      ...v.addresses.map((r) => `${r.branchId}：${r.url}`),
    ].join("\n");
  if (v.results)
    return v.results.map((r) => `${r.name}：${r.url}\n${r.message}`).join("\n");
  return JSON.stringify(value, null, 2);
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
  onSaved?: (message: string) => void;
}): JSX.Element {
  const [config, setConfig] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openingPreview, setOpeningPreview] = useState(false);
  const [checks, setChecks] = useState<Verification[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [records, setRecords] = useState<Audit[]>([]);
  const [auditError, setAuditError] = useState("");
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const base = `/api/branches/${encodeURIComponent(branchId)}/preview-address`;
  const load = useCallback(async () => {
    const run = ++generation.current;
    setLoading(true);
    setError("");
    setPreview(null);
    setChecks([]);
    setBusy(false);
    setOpeningPreview(false);
    setRecords([]);
    setAuditOpen(false);
    try {
      const result = await apiRequest<Config>(base);
      if (run !== generation.current) return;
      setConfig(result);
      setDraft(result.draft);
    } catch (err) {
      if (run === generation.current) setError(errorText(err));
    } finally {
      if (run === generation.current) setLoading(false);
    }
  }, [base]);
  useEffect(() => {
    if (open) void load();
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [open, load]);
  useEffect(() => {
    if (!open || !draft || !config || loading || !config.canEdit) {
      setPending(false);
      return;
    }
    const abort = new AbortController();
    let current = true;
    setPending(true);
    setPreview(null);
    setPreviewError("");
    const timer = window.setTimeout(() => {
      void apiRequest<Preview>(`${base}/preview`, {
        method: "POST",
        body: draft,
        signal: abort.signal,
      })
        .then((result) => {
          if (current) setPreview(result);
        })
        .catch((err) => {
          if (current && !abort.signal.aborted) setPreviewError(errorText(err));
        })
        .finally(() => {
          if (current) setPending(false);
        });
    }, 180);
    return () => {
      current = false;
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [open, draft, config, loading, base]);
  async function loadAudit(more = false) {
    const run = generation.current;
    setAuditLoading(true);
    setAuditError("");
    try {
      const result = await apiRequest<{
        records: Audit[];
        nextCursor: string | null;
      }>(
        `${base}/audit${more && auditCursor ? `?before=${encodeURIComponent(auditCursor)}` : ""}`,
      );
      if (run !== generation.current) return;
      setRecords((previous) =>
        more ? [...previous, ...result.records] : result.records,
      );
      setAuditCursor(result.nextCursor);
    } catch (err) {
      if (run === generation.current) setAuditError(errorText(err));
    } finally {
      if (run === generation.current) setAuditLoading(false);
    }
  }
  function update(patch: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setError("");
    setChecks([]);
  }
  async function verify(targets: Target[], saved: Config) {
    const run = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setChecks(targets.map((t) => ({ ...t, state: "waiting" })));
    const results: boolean[] = [];
    for (let offset = 0; offset < targets.length; offset += 3) {
      await Promise.allSettled(
        targets.slice(offset, offset + 3).map(async (target) => {
          if (abort.signal.aborted) return;
          setChecks((previous) =>
            previous.map((c) =>
              c.branchId === target.branchId ? { ...c, state: "checking" } : c,
            ),
          );
          try {
            const result = await apiRequest<{
              ok: boolean;
              results: Verification["results"];
            }>(
              `/api/branches/${encodeURIComponent(target.branchId)}/preview-address/verify`,
              {
                method: "POST",
                body: { expectedVersion: saved.version },
                signal: abort.signal,
              },
            );
            if (run !== generation.current) return;
            results.push(result.ok);
            setChecks((previous) =>
              previous.map((c) =>
                c.branchId === target.branchId
                  ? {
                      ...c,
                      state: result.ok ? "pass" : "fail",
                      results: result.results,
                    }
                  : c,
              ),
            );
          } catch (err) {
            if (run !== generation.current) return;
            results.push(false);
            setChecks((previous) =>
              previous.map((c) =>
                c.branchId === target.branchId
                  ? { ...c, state: "fail", message: errorText(err) }
                  : c,
              ),
            );
          }
        }),
      );
      if (run !== generation.current) return;
    }
    if (run !== generation.current) return;
    setBusy(false);
    if (results.length === targets.length && results.every(Boolean))
      onSaved?.("访问地址已保存并验证通过");
    if (auditOpen) void loadAudit();
  }
  async function save() {
    if (
      !config ||
      !draft ||
      busy ||
      pending ||
      previewError ||
      !preview ||
      preview.collisions.length
    )
      return;
    const run = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<Config & { verifyTargets: Target[] }>(
        base,
        { method: "PUT", body: { ...draft, expectedVersion: config.version } },
      );
      if (run !== generation.current) return;
      setConfig(result);
      setDraft(result.draft);
      onSaved?.("配置已保存，正在验证公开入口");
      await verify(result.verifyTargets, result);
    } catch (err) {
      if (run !== generation.current) return;
      setError(errorText(err));
      setBusy(false);
      if (auditOpen) void loadAudit();
    }
  }
  async function openPreview() {
    if (!draft || openingPreview) return;
    const target = window.open("about:blank", "_blank");
    if (!target) { setError("浏览器阻止了新窗口，请允许弹出窗口后重试。"); return; }
    target.opener = null;
    const run = generation.current;
    setOpeningPreview(true);
    setError("");
    try {
      const result = await apiRequest<{ url: string }>(`${base}/open-preview`, { method: "POST", body: draft });
      if (run !== generation.current) { target.close(); return; }
      target.location.href = result.url;
      if (auditOpen) void loadAudit();
    } catch (err) {
      target.close();
      if (run === generation.current) setError(errorText(err));
    } finally {
      if (run === generation.current) setOpeningPreview(false);
    }
  }
  async function jump(collision: Collision) {
    if (!collision.href || !draft) return;
    const target = window.open("about:blank", "_blank");
    if (!target) {
      setError("浏览器阻止了新窗口，请允许弹出窗口后重试。");
      return;
    }
    target.opener = null;
    try {
      const result = await apiRequest<{ href: string }>(
        `${base}/visit-conflict`,
        { method: "POST", body: { ...draft, href: collision.href } },
      );
      target.location.href = result.href;
    } catch (err) {
      target.close();
      setError(errorText(err));
    }
  }
  const changed =
    !!config &&
    !!draft &&
    !sameDraft(config.draft, draft) &&
    !(
      draft.mode === "branch" &&
      draft.applyToProject &&
      draft.projectSlug === config.projectSlug &&
      draft.branchName === config.draft.branchName &&
      config.draft.mode === "branch" &&
      config.draft.projectSlug === config.projectSlug
    );
  const invalid =
    !!draft &&
    (draft.mode === "custom"
      ? !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(draft.customSubdomain)
      : !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(draft.branchName) ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(draft.projectSlug) ||
        `${draft.branchName}-${draft.projectSlug}`.length > 63);
  const draftLabel =
    draft?.mode === "custom"
      ? draft.customSubdomain
      : `${draft?.branchName || ""}-${draft?.projectSlug || ""}`;
  const failed = checks.some((c) => c.state === "fail");
  const passed = checks.length > 0 && checks.every((c) => c.state === "pass");
  return (
    <>
      <Dialog
        open={open && !servicesOpen}
        onOpenChange={(value) => {
          if (!value) onClose();
        }}
      >
        <DialogContent
          frame
          className="max-w-2xl"
          style={{ maxHeight: "90vh" }}
        >
          <DialogHeader className="shrink-0 border-b px-6 py-5 pr-12">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>修改访问地址</DialogTitle>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setAuditOpen(!auditOpen);
                  if (!auditOpen) void loadAudit();
                }}
              >
                <History className="h-3.5 w-3.5" />
                审计记录
              </button>
            </div>
            <DialogDescription>
              {config
                ? `${config.projectName} / ${config.gitBranch}`
                : "读取项目与分支地址设置"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody
            className="space-y-4 px-6 py-5"
            style={{ minHeight: 0, overflowY: "auto" }}
          >
            {loading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                正在读取地址设置…
              </div>
            ) : config && draft ? (
              <>
                {!config.canEdit && (
                  <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                    你只有查看权限，请联系项目管理员修改；跳转项目不会提升权限。
                  </p>
                )}
                <div className="grid items-end gap-5 sm:grid-cols-2">
                  <div>
                    <div
                      className="mb-4 inline-flex gap-1 rounded-md border bg-muted/50 p-1"
                      role="group"
                      aria-label="地址类型"
                    >
                      {(
                        [
                          ["branch", "仅分支"],
                          ["custom", "自定义"],
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          aria-pressed={draft.mode === mode}
                          disabled={busy || !config.canEdit}
                          onClick={() =>
                            update({ mode, applyToProject: false })
                          }
                          className={`rounded px-3 py-1 text-xs disabled:opacity-50 ${draft.mode === mode ? "bg-background text-primary shadow-sm" : "text-muted-foreground"}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label
                      htmlFor="address-branch"
                      className="mb-2 block text-sm font-medium"
                    >
                      {draft.mode === "custom" ? "子域名" : "分支名"}
                    </label>
                    <input
                      id="address-branch"
                      className={inputClass}
                      value={
                        draft.mode === "custom"
                          ? draft.customSubdomain
                          : draft.branchName
                      }
                      onChange={(e) =>
                        update(
                          draft.mode === "custom"
                            ? { customSubdomain: e.target.value }
                            : { branchName: e.target.value },
                        )
                      }
                      disabled={busy || !config.canEdit}
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </div>
                  <div>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <label
                        htmlFor="address-project"
                        className="text-sm font-medium"
                      >
                        项目名
                      </label>
                      <label className="inline-flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={draft.applyToProject}
                          onChange={(e) =>
                            update({ applyToProject: e.target.checked })
                          }
                          disabled={
                            busy || !config.canEdit || draft.mode === "custom"
                          }
                        />
                        覆盖整个项目
                      </label>
                    </div>
                    <input
                      id="address-project"
                      className={inputClass}
                      value={draft.projectSlug}
                      onChange={(e) => update({ projectSlug: e.target.value })}
                      disabled={
                        busy || !config.canEdit || draft.mode === "custom"
                      }
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {draft.mode === "custom"
                    ? "直接使用独立子域，不拼接分支名或项目名。"
                    : draft.applyToProject
                      ? "将修改项目 slug，影响继承项目名的分支地址。Git 分支和既有资源归属保持不变。"
                      : "未勾选时，只改本分支地址中的项目部分；Git 分支与项目 slug 保持不变。"}
                </p>
                <section
                  className="rounded-lg border bg-muted/25 p-4"
                  aria-live="polite"
                >
                  <div className="mb-2 flex justify-between text-[0.6875rem] text-muted-foreground">
                    <span>实时预览</span>
                    <span>
                      {pending
                        ? "正在检查占用…"
                        : changed
                          ? "未保存"
                          : "当前地址"}
                    </span>
                  </div>
                  <div className="break-all font-mono text-base leading-relaxed">
                    <span className="text-muted-foreground">https://</span>
                    <strong className="font-semibold text-primary">
                      {invalid
                        ? "请填写有效名称"
                        : changed
                          ? draftLabel
                          : config.url
                            ? new URL(config.url).hostname.replace(
                                `.${config.rootDomain}`,
                                "",
                              )
                            : draftLabel}
                    </strong>
                    <span>.{config.rootDomain}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
                    <Button type="button" variant="outline" size="sm" disabled={busy || openingPreview || invalid} onClick={() => void openPreview()}>
                      {openingPreview ? <LoaderCircle className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Eye className="mr-1.5 h-3.5 w-3.5" />}
                      {openingPreview ? "正在打开预览…" : "预览分支页面（不保存）"}
                    </Button>
                    <p className="text-[0.6875rem] text-muted-foreground">新地址保存后生效；预览打开当前分支，不占用新域名。</p>
                  </div>
                </section>
                <p className="text-[0.6875rem] text-muted-foreground">地址配置随本分支保存。删除分支会释放其专属地址；历史审计保留，不占用域名。停止分支会保留地址。</p>
                {(previewError || invalid) && (
                  <p className="text-xs text-destructive" role="alert">
                    {previewError ||
                      "使用小写字母、数字、连字符，首尾不能为连字符；完整子域最多 63 个字符。"}
                  </p>
                )}
                {preview?.collisions.map((c, i) => (
                  <div
                    key={`${c.host}-${i}`}
                    className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-xs"
                    role="alert"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div>
                      <b className="break-all font-medium text-destructive">
                        {c.host}{" "}
                        {c.reason === "reserved"
                          ? "是系统保留地址"
                          : "已被占用"}
                      </b>
                      {c.reason !== "reserved" && (
                        <p className="mt-1 text-muted-foreground">
                          占用方：{c.projectName}
                          {c.branchId ? ` / ${c.branchId}` : ""}
                          {c.href
                            ? c.canEdit
                              ? " · 有编辑权限"
                              : " · 仅可查看"
                            : " · 请联系管理员处理"}
                        </p>
                      )}
                      {c.href && (
                        <button
                          type="button"
                          className="mt-2 inline-flex items-center gap-1 text-primary"
                          onClick={() => void jump(c)}
                        >
                          前往占用项目
                          <ArrowUpRight className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {changed &&
                  preview &&
                  !preview.collisions.length &&
                  !previewError && (
                    <section className="space-y-2 text-xs">
                      <b className="font-medium">这次会改变</b>
                      {preview.projectSlugBefore !==
                      preview.projectSlugAfter ? (
                        <p className="rounded border border-primary/15 bg-primary/5 p-2.5 text-primary">
                          项目 slug：{preview.projectSlugBefore} →{" "}
                          {preview.projectSlugAfter}。将更新{" "}
                          {preview.changes.length} 个分支地址。
                        </p>
                      ) : (
                        <p className="text-muted-foreground">
                          {draft.mode === "custom"
                            ? "本分支改用独立子域。"
                            : "仅修改本分支地址，项目 slug 保持不变。"}
                        </p>
                      )}
                      {preview.changes.map((c) => (
                        <div
                          className="flex items-center justify-between gap-3 border-b py-2"
                          key={c.branchId}
                        >
                          <span className="min-w-0 break-all text-muted-foreground">
                            {c.branch}
                          </span>
                          <div className="min-w-0 text-right font-mono text-[0.6875rem]">
                            <del className="block break-all text-muted-foreground/70">
                              {c.before}
                            </del>
                            <span className="block break-all">{c.after}</span>
                          </div>
                        </div>
                      ))}
                      {draft.applyToProject && (
                        <p className="text-[0.6875rem] text-muted-foreground">
                          其他分支的独立子域与专属项目名保持原地址。
                        </p>
                      )}
                    </section>
                  )}
                {checks.length > 0 && (
                  <section
                    className={`space-y-2 rounded-md border p-3 text-xs ${failed ? "border-destructive/25 bg-destructive/5" : "bg-muted/25"}`}
                    aria-live="polite"
                  >
                    <div className="flex items-center gap-2 font-medium">
                      {busy ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : passed ? (
                        <Check className="h-4 w-4 text-ok" />
                      ) : (
                        <AlertCircle className="h-4 w-4 text-destructive" />
                      )}
                      {busy
                        ? `已保存，正在验证 ${checks.length} 个分支的公开入口`
                        : passed
                          ? "已保存，公开入口验证通过"
                          : "已保存，公开入口验证未通过"}
                    </div>
                    {checks.map((c) => (
                      <div className="space-y-1 border-t pt-2" key={c.branchId}>
                        <div className="flex items-center gap-2">
                          {c.state === "checking" ? (
                            <LoaderCircle className="h-3 w-3 animate-spin" />
                          ) : c.state === "pass" ? (
                            <Check className="h-3 w-3 text-ok" />
                          ) : null}
                          <b className="font-normal">{c.branch}</b>
                          <span className="ml-auto text-muted-foreground">
                            {c.state === "waiting"
                              ? "等待检查"
                              : c.state === "checking"
                                ? "正在检查归属、页面与资源…"
                                : c.state === "pass"
                                  ? "通过"
                                  : "未通过"}
                          </span>
                        </div>
                        {c.message && (
                          <p className="text-destructive">{c.message}</p>
                        )}
                        {c.results?.map((r) => (
                          <p
                            key={r.url}
                            className={`break-all text-[0.6875rem] ${r.ok ? "text-muted-foreground" : "text-destructive"}`}
                          >
                            {r.name} · {r.url}
                            <br />
                            {r.message}
                          </p>
                        ))}
                      </div>
                    ))}
                    {failed && !busy && (
                      <button
                        type="button"
                        className="text-primary"
                        onClick={() =>
                          void verify(
                            checks.map((c) => ({
                              branchId: c.branchId,
                              branch: c.branch,
                            })),
                            config,
                          )
                        }
                      >
                        重新验证
                      </button>
                    )}
                  </section>
                )}
                {auditOpen && (
                  <section
                    className="space-y-2 border-t pt-3"
                    aria-label="审计记录"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <b>审计记录</b>
                      <button
                        type="button"
                        className="text-primary disabled:opacity-50"
                        disabled={auditLoading}
                        onClick={() => void loadAudit()}
                      >
                        刷新
                      </button>
                    </div>
                    {auditLoading && (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <LoaderCircle className="h-3 w-3 animate-spin" />
                        读取审计…
                      </p>
                    )}
                    {auditError && (
                      <p className="text-xs text-destructive">{auditError}</p>
                    )}
                    {!auditLoading && !records.length && (
                      <p className="text-xs text-muted-foreground">
                        暂无记录。保存、验证和占用项目跳转均由服务端记录。
                      </p>
                    )}
                    {records.map((r) => (
                      <details
                        key={r.id}
                        className="border-b py-2 text-[0.6875rem]"
                      >
                        <summary className="cursor-pointer">
                          <span className="font-medium">{r.result}</span>
                          <span className="ml-2 text-muted-foreground">
                            {new Date(r.at).toLocaleString()}
                          </span>
                        </summary>
                        <dl className="mt-2 space-y-2 rounded bg-muted/30 p-2 text-muted-foreground">
                          <div>操作人：{r.actor}</div>
                          <div>
                            分支：{r.branchId} · 范围：
                            {r.scope === "project" ? "整个项目" : "仅本分支"}
                          </div>
                          <div>
                            变更前
                            <pre className="mt-1 whitespace-pre-wrap break-all font-mono">
                              {auditText(r.before)}
                            </pre>
                          </div>
                          <div>
                            变更后 / 结果
                            <pre className="mt-1 whitespace-pre-wrap break-all font-mono">
                              {auditText(r.after)}
                            </pre>
                          </div>
                        </dl>
                      </details>
                    ))}
                    {auditCursor && (
                      <button
                        type="button"
                        className="text-xs text-primary"
                        disabled={auditLoading}
                        onClick={() => void loadAudit(true)}
                      >
                        更早记录
                      </button>
                    )}
                  </section>
                )}
              </>
            ) : null}
            {error && (
              <div
                className="flex items-start gap-2 text-xs text-destructive"
                role="alert"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
                <button
                  type="button"
                  className="ml-auto shrink-0 underline"
                  disabled={busy}
                  onClick={() => void load()}
                >
                  重新加载
                </button>
              </div>
            )}
          </DialogBody>
          <DialogFooter className="shrink-0 items-center border-t px-6 py-4">
            <div className="mr-auto flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
              <ShieldCheck className="h-3 w-3" />
              修改、验证与跳转均留审计
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !config?.canEdit}
              onClick={() => setServicesOpen(true)}
            >
              服务入口设置
            </Button>
            <Button
              size="sm"
              disabled={
                busy ||
                loading ||
                !config?.canEdit ||
                !changed ||
                pending ||
                invalid ||
                !!previewError ||
                !preview ||
                !!preview.collisions.length
              }
              onClick={() => void save()}
            >
              {busy ? (
                <>
                  <LoaderCircle className="mr-1 h-3 w-3 animate-spin" />
                  验证中…
                </>
              ) : (
                "保存并验证"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ServiceEntryConfigDialog
        open={open && servicesOpen}
        branchId={branchId}
        onClose={() => {
          setServicesOpen(false);
          void load();
        }}
        onSaved={(message) => {
          onSaved?.(message);
        }}
      />
    </>
  );
}
