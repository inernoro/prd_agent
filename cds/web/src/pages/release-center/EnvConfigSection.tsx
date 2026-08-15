/**
 * 分区二「环境与配置」——设计稿 design_handoff_release_center §3。
 *
 * 这是全站**唯一**能写发布策略的地方（发布控制台那边是只读并指回这里）。
 * 元素照稿子：头部（标题 + 唯一写入口徽标 + 未保存提示 + 保存按钮）、两列表单
 * （发布模式 / 站点目录 / 部署命令跨两列 / 健康检查地址 / 回滚命令）、两个开关卡片
 * （设为主目标 / 启用该环境）、底部生效序列预览。
 *
 * 与稿子的一处出入：发布模式的三个选项。稿子写「静态站点 / 命令部署 / 静态站点 + 命令」，
 * 后端 `ReleaseExecutionMode` 的枚举是 existing-script / generated-compose / generated-static。
 * 控件形态照稿子（一个三选 select），**选项名用后端真值**——编三个后端不认的模式，
 * 保存时会被 400 打回来，那不是复刻是坏功能。
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import type { CenterRow, ReleaseExecutionMode } from './types';

export interface EnvConfigSectionProps {
  row: CenterRow;
  onSaved: (message: string) => void;
  onReload: () => void;
}

interface StrategyDraft {
  mode: ReleaseExecutionMode;
  appPath: string;
  deployCommand: string;
  healthcheckUrl: string;
  rollbackCommand: string;
  isCanonical: boolean;
  isEnabled: boolean;
}

const MODES: Array<{ value: ReleaseExecutionMode; label: string }> = [
  { value: 'existing-script', label: '项目现有脚本' },
  { value: 'generated-compose', label: '生成的 Compose' },
  { value: 'generated-static', label: '生成的静态站点' },
];

function draftOf(row: CenterRow): StrategyDraft {
  return {
    mode: row.target.strategy?.mode || 'existing-script',
    appPath: row.target.ssh?.appPath || '',
    deployCommand: row.target.strategy?.command || row.target.ssh?.deployCommand || '',
    healthcheckUrl: row.target.ssh?.healthcheckUrl || '',
    rollbackCommand: row.target.ssh?.rollbackCommand || '',
    isCanonical: row.target.isCanonical !== false,
    isEnabled: row.target.isEnabled !== false,
  };
}

/** 开关。轨道 34×19、滑块 15、位移 2→17、.18s——尺寸照稿子。 */
function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (next: boolean) => void; label: string; hint: string }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[11px] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold">{label}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className={`relative h-[19px] w-[34px] shrink-0 rounded-[11px] transition-colors duration-[180ms] ${on ? 'bg-primary' : 'bg-[hsl(var(--hairline-strong))]'}`}
      >
        <span
          className="absolute top-[2px] h-[15px] w-[15px] rounded-full bg-white transition-[left] duration-[180ms] ease-out"
          style={{ left: on ? 17 : 2 }}
        />
      </button>
    </div>
  );
}

function Field({ label, span, children }: { label: string; span?: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${span ? 'sm:col-span-2' : ''}`}>
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const CONTROL = 'h-9 w-full rounded-[9px] border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] px-3 text-[12.5px] outline-none focus:border-primary/60';
/** 命令类输入用代码底色。白天是浅底深字（cds-theme-tokens 最高原则）。 */
const CODE_CONTROL = `${CONTROL} cds-ident bg-[hsl(var(--surface-base))]`;
/**
 * 部署命令 / 回滚命令必须是 textarea，不能是 input。
 *
 * 真实数据里这两个字段装的是整段 shell 脚本（本项目的部署命令有上百行）。
 * `<input>` 在设值时会把换行**吃掉**：屏幕上显示成一长条，用户改一个字母后
 * onChange 回来的就是被压平的单行串，保存下去等于把生产发布脚本毁了——
 * 而且编译、类型、测试全都发现不了。稿子画的是「跨两列的宽输入框」，
 * 宽度照做，控件类型必须按真实数据选。
 */
const CODE_AREA = 'min-h-[76px] w-full resize-y rounded-[9px] border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-base))] px-3 py-2 cds-ident text-[12.5px] leading-[1.7] outline-none focus:border-primary/60';

export function EnvConfigSection({ row, onSaved, onReload }: EnvConfigSectionProps): JSX.Element {
  const [draft, setDraft] = useState<StrategyDraft>(() => draftOf(row));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 换环境时重置草稿。草稿按环境隔离——不重置的话，在 A 改了一半切到 B，
  // 会把 A 的值当成 B 的现状显示出来，保存下去就是改错环境。
  useEffect(() => { setDraft(draftOf(row)); setError(''); }, [row.target.id]);

  const clean = draftOf(row);
  const dirty = (Object.keys(clean) as Array<keyof StrategyDraft>).some((key) => draft[key] !== clean[key]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      await apiRequest(`/api/releases/targets/${encodeURIComponent(row.target.id)}`, {
        method: 'PATCH',
        body: {
          appPath: draft.appPath,
          deployCommand: draft.deployCommand,
          healthcheckUrl: draft.healthcheckUrl,
          rollbackCommand: draft.rollbackCommand,
          isCanonical: draft.isCanonical,
          isEnabled: draft.isEnabled,
          strategy: { ...(row.target.strategy || {}), mode: draft.mode, command: draft.deployCommand },
        },
      });
      onSaved('发布策略已保存');
      onReload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /* 生效序列预览：把保存后真正会跑的那串命令摊开。缺哪一段就说缺哪一段，不留空行。 */
  const sequence = [
    draft.appPath ? `cd ${draft.appPath}` : '# （未配置站点目录）',
    draft.deployCommand || '# （未配置部署命令，保存前无法发布）',
    draft.healthcheckUrl
      ? `curl -sf ${draft.healthcheckUrl} || ${draft.rollbackCommand || '# （未配置回滚命令，健康检查失败后不会自动退回）'}`
      : '# （未配置健康检查地址，发布后不会自动验证）',
  ].join('\n');

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden rounded-[14px] border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="truncate text-sm font-bold">{row.target.name} · 发布策略</h2>
          <span className="rounded-[6px] bg-warn-soft px-1.5 py-0.5 text-[10px] text-warn">唯一写入口</span>
          {dirty ? <span className="text-[11.5px] text-warn">有未保存更改</span> : null}
        </div>
        <Button size="sm" className="h-8" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          保存策略
        </Button>
      </div>

      {error ? (
        <p className="border-b border-[hsl(var(--hairline)/0.6)] bg-bad-soft px-[18px] py-2.5 text-xs text-bad">{error}</p>
      ) : null}

      <div className="grid gap-x-[18px] gap-y-3.5 p-[18px] sm:grid-cols-2">
        <Field label="发布模式">
          <select
            value={draft.mode}
            onChange={(event) => setDraft((current) => ({ ...current, mode: event.target.value as ReleaseExecutionMode }))}
            className={CONTROL}
          >
            {MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
          </select>
        </Field>
        <Field label="站点目录">
          <input
            value={draft.appPath}
            placeholder="未配置"
            onChange={(event) => setDraft((current) => ({ ...current, appPath: event.target.value }))}
            className={CODE_CONTROL}
          />
        </Field>
        <Field label="部署命令" span>
          <textarea
            value={draft.deployCommand}
            placeholder="未配置"
            spellCheck={false}
            rows={draft.deployCommand.includes('\n') ? 8 : 2}
            onChange={(event) => setDraft((current) => ({ ...current, deployCommand: event.target.value }))}
            className={CODE_AREA}
          />
        </Field>
        <Field label="健康检查地址">
          <input
            value={draft.healthcheckUrl}
            placeholder="未配置"
            onChange={(event) => setDraft((current) => ({ ...current, healthcheckUrl: event.target.value }))}
            className={CODE_CONTROL}
          />
        </Field>
        <Field label="回滚命令">
          <textarea
            value={draft.rollbackCommand}
            placeholder="该环境不支持回滚"
            spellCheck={false}
            rows={draft.rollbackCommand.includes('\n') ? 8 : 2}
            onChange={(event) => setDraft((current) => ({ ...current, rollbackCommand: event.target.value }))}
            className={CODE_AREA}
          />
        </Field>

        <Toggle
          on={draft.isCanonical}
          onChange={(next) => setDraft((current) => ({ ...current, isCanonical: next }))}
          label="设为主目标"
          hint="主目标是这个项目的代表环境，发布控制台默认选它"
        />
        <Toggle
          on={draft.isEnabled}
          onChange={(next) => setDraft((current) => ({ ...current, isEnabled: next }))}
          label="启用该环境"
          hint="停用后不再参与发布与健康探测，历史记录保留"
        />
      </div>

      <div className="border-t border-[hsl(var(--hairline)/0.6)] px-[18px] py-3.5">
        <div className="mb-2 text-[11.5px] text-muted-foreground">生效序列预览（保存后按这个顺序执行）</div>
        {/* 限高：部署命令是整段脚本时，不限高会把这一块拉成几屏长，
            下面的内容全被挤没。脚本本身在上面的 textarea 里可以完整编辑。 */}
        <pre className="m-0 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[9px] bg-[hsl(var(--surface-base))] px-3 py-2.5 cds-ident text-xs leading-[1.7]">
          {sequence}
        </pre>
      </div>
    </section>
  );
}
