/**
 * Phase 8 — 项目导入后强制 env 配置弹窗。
 *
 * 流程:clone 完成 → 自动弹出本对话框 → 上半屏列必填项(用户输入)+ 下半屏折叠展示
 * CDS 自动搞定的 env(密码 / 推导)→ 必填全填 → 「完成,开始部署」按钮 enable →
 * PUT /api/env 保存 → 跳转到分支页 + 触发自动部署(Phase 8.6 处理)。
 *
 * 设计原则:
 *  - 必填项不填,deploy 后端会 412 block;UI 上"完成"按钮强制 disable,引导填值
 *  - "暂不配置" → 关闭弹窗;用户后续要 deploy 时,deploy SSE 会爆 412,失败信息
 *    引导回项目环境变量页填(后续 Phase 处理)
 *  - hint 字段直接显示在 input 上方,告诉用户该填什么
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Database, KeyRound, Loader2, Sparkles } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { DisclosurePanel } from '@/components/ui/disclosure-panel';
import { apiRequest, ApiError } from '@/lib/api';

export type EnvKind = 'auto' | 'required' | 'infra-derived';
export interface EnvMetaEntry {
  kind: EnvKind;
  hint?: string;
}

interface EnvBundle {
  env: Record<string, string>;
  scope: string;
  envMeta?: Record<string, EnvMetaEntry>;
  missingRequiredEnvKeys?: string[];
}

interface Props {
  /** 项目 ID — 决定 /api/env 的 scope。null = 关闭对话框 */
  projectId: string | null;
  /** 项目展示名,渲染在标题里 */
  projectName?: string;
  onOpenChange: (open: boolean) => void;
  /**
   * 配完点「完成」时调用,父组件接管后续(跳转分支页 + 自动部署)。
   * autoDeploy=true 表示用户希望立即 deploy(Phase 8.6 行云流水)。
   * autoDeploy=false 表示用户选了"稍后再说",只保存配置不动 deploy。
   */
  onCompleted: (params: { projectId: string; autoDeploy: boolean }) => void;
}

export function EnvSetupDialog({ projectId, projectName, onOpenChange, onCompleted }: Props): JSX.Element {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; bundle: EnvBundle }
  >({ status: 'idle' });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setState({ status: 'loading' });
    setSaveError(null);
    try {
      const bundle = await apiRequest<EnvBundle>(
        `/api/env?scope=${encodeURIComponent(projectId)}`,
      );
      setState({ status: 'ready', bundle });
      // draft 初始值取当前 env(包括用户已经填过的);只填空的 required 项才会被关注
      setDraft({ ...(bundle.env || {}) });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof ApiError ? err.message : String(err),
      });
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId) void load();
    else {
      setState({ status: 'idle' });
      setDraft({});
    }
  }, [projectId, load]);

  // 三色分组:required(必填,显眼)/ auto(CDS 自动)/ infra-derived(推导)
  const groups = useMemo(() => {
    if (state.status !== 'ready') return { required: [], auto: [], derived: [] };
    const meta = state.bundle.envMeta || {};
    const env = state.bundle.env || {};
    const required: Array<{ key: string; hint?: string; currentValue: string }> = [];
    const auto: Array<{ key: string; hint?: string; value: string }> = [];
    const derived: Array<{ key: string; hint?: string; value: string }> = [];
    // 已知 envMeta 的 keys 走分类;未在 envMeta 的(老 key / 用户后加的)默认归 auto
    const seen = new Set<string>();
    for (const [key, m] of Object.entries(meta)) {
      seen.add(key);
      if (m.kind === 'required') {
        required.push({ key, hint: m.hint, currentValue: env[key] || '' });
      } else if (m.kind === 'infra-derived') {
        derived.push({ key, hint: m.hint, value: env[key] || '' });
      } else {
        auto.push({ key, hint: m.hint, value: env[key] || '' });
      }
    }
    for (const [key, value] of Object.entries(env)) {
      if (seen.has(key)) continue;
      auto.push({ key, value });
    }
    return { required, auto, derived };
  }, [state]);

  // 是否所有必填项都填了(空字符串和只含空格也算未填)
  const allRequiredFilled = useMemo(() => {
    return groups.required.every(({ key }) => (draft[key] || '').trim().length > 0);
  }, [groups.required, draft]);

  const submit = useCallback(
    async (autoDeploy: boolean) => {
      if (!projectId || state.status !== 'ready') return;
      setSaving(true);
      setSaveError(null);
      try {
        // PUT /api/env 直接整体覆盖,后端会同步写到 customEnv + defaultEnv
        await apiRequest(`/api/env?scope=${encodeURIComponent(projectId)}`, {
          method: 'PUT',
          body: { ...draft },
        });
        onCompleted({ projectId, autoDeploy });
        onOpenChange(false);
      } catch (err) {
        setSaveError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [draft, projectId, state.status, onCompleted, onOpenChange],
  );

  return (
    <Dialog open={Boolean(projectId)} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        style={{ maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
      >
        <DialogHeader>
          <DialogTitle>配置项目环境变量</DialogTitle>
          <DialogDescription>
            {projectName ? `${projectName} · ` : ''}
            CDS 检测到 cds-compose,以下变量需要确认。<strong>必填项</strong>请你来填,
            <strong>CDS 自动</strong>区可展开查看 / 修改,
            <strong>基础设施推导</strong>区由 CDS 内部生成的连接串组成。
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex-1 overflow-y-auto pr-1"
          style={{ minHeight: 0, overscrollBehavior: 'contain' }}
        >
          {state.status === 'loading' ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在读取环境变量...
            </div>
          ) : state.status === 'error' ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              读取失败:{state.message}
            </div>
          ) : state.status === 'ready' ? (
            <div className="space-y-4">
              {/* 必填项 — 顶部最显眼 */}
              {groups.required.length > 0 ? (
                <section className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
                  <header className="mb-3 flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
                    <KeyRound className="h-4 w-4" />
                    你必须填写({groups.required.length} 项)
                  </header>
                  <div className="space-y-3">
                    {groups.required.map(({ key, hint }) => {
                      const value = draft[key] || '';
                      const isEmpty = !value.trim();
                      return (
                        <div key={key} className="space-y-1">
                          <label className="block text-xs font-medium text-foreground">
                            {key}
                            {isEmpty ? (
                              <span className="ml-2 text-amber-600">必填</span>
                            ) : (
                              <span className="ml-2 inline-flex items-center text-emerald-600">
                                <CheckCircle2 className="mr-0.5 h-3 w-3" />
                                已填
                              </span>
                            )}
                          </label>
                          {hint ? (
                            <div className="text-xs text-muted-foreground">{hint}</div>
                          ) : null}
                          <input
                            type="text"
                            value={value}
                            onChange={(e) =>
                              setDraft((current) => ({ ...current, [key]: e.target.value }))
                            }
                            placeholder={hint || `请填写 ${key}`}
                            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : (
                <section className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="mr-2 inline h-4 w-4" />
                  本项目无必填项,CDS 会全部自动处理。
                </section>
              )}

              {/* CDS 自动生成 */}
              {groups.auto.length > 0 ? (
                <DisclosurePanel
                  icon={<Sparkles className="h-4 w-4 text-emerald-500" />}
                  title={`CDS 已自动生成(${groups.auto.length} 项)`}
                  subtitle="密码 / JWT 等,默认随机强值,你不需要管。展开可以修改。"
                >
                  <div className="space-y-2 px-4 py-3 font-mono text-xs">
                    {groups.auto.map(({ key, hint }) => {
                      const value = draft[key] || '';
                      return (
                        <div key={key}>
                          <div className="flex items-baseline justify-between gap-2 text-foreground">
                            <span>{key}</span>
                            {hint ? (
                              <span className="text-[10px] text-muted-foreground">{hint}</span>
                            ) : null}
                          </div>
                          <input
                            type="text"
                            value={value}
                            onChange={(e) =>
                              setDraft((current) => ({ ...current, [key]: e.target.value }))
                            }
                            className="mt-1 w-full rounded border border-input bg-muted/30 px-2 py-1 text-foreground/80"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </div>
                      );
                    })}
                  </div>
                </DisclosurePanel>
              ) : null}

              {/* 基础设施推导 */}
              {groups.derived.length > 0 ? (
                <DisclosurePanel
                  icon={<Database className="h-4 w-4 text-sky-500" />}
                  title={`基础设施推导(${groups.derived.length} 项)`}
                  subtitle="DATABASE_URL / REDIS_URL 等,由 CDS 根据 infra 配置自动拼接,无需你管。"
                >
                  <div className="space-y-2 px-4 py-3 font-mono text-xs">
                    {groups.derived.map(({ key, value, hint }) => (
                      <div key={key} className="text-muted-foreground">
                        <span className="text-foreground">{key}</span>
                        {hint ? (
                          <span className="ml-2 text-[10px]">{hint}</span>
                        ) : null}
                        <div className="mt-0.5 break-all">{value}</div>
                      </div>
                    ))}
                  </div>
                </DisclosurePanel>
              ) : null}
            </div>
          ) : null}
        </div>

        {saveError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            保存失败:{saveError}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            稍后再说
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void submit(false)}
            disabled={saving || state.status !== 'ready' || !allRequiredFilled}
          >
            仅保存
          </Button>
          <Button
            type="button"
            onClick={() => void submit(true)}
            disabled={saving || state.status !== 'ready' || !allRequiredFilled}
          >
            {saving ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : null}
            完成,开始部署
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
