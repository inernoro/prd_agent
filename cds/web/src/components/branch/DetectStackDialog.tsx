// 波5 无 Agent 接入 —— 已 clone 空项目的「检测技术栈」对话框。
//
// 面向纯 UI 用户(产品经理):项目已克隆但没有构建配置时(webhook 自动 clone /
// 建时没勾服务),用它一键 race-free 完成「扫描 → 确认 → 生成构建配置」,之后即可
// 创建分支预览。调 GET /detect-preview(只读)+ POST /detect-apply(用户确认后建)。
//
// 主题:全部走 token,双主题自适应(见 .claude/rules/cds-theme-tokens.md)。
// 布局:shadcn Dialog 自带模态约束;列表区限高滚动,手机不溢出。
import { useEffect, useState } from 'react';
import { apiRequest, ApiError } from '@/lib/api';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Wand2, ServerCog, AlertTriangle } from 'lucide-react';

export interface DetectedService {
  id?: string;
  name?: string;
  role?: string;
  runtime: string;
  dockerImage?: string;
  command?: string;
  port?: number;
  summary?: string;
  stack?: string;
  manualSetupRequired?: boolean;
}

const RUNTIME_LABEL: Record<string, string> = {
  node: 'Node.js', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java',
  php: 'PHP', dotnet: '.NET', static: '静态站点', custom: '自定义',
};

export function DetectStackDialog({
  projectId,
  open,
  onOpenChange,
  onApplied,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** apply 成功后回调(供父组件刷新构建配置 / 分支列表)。 */
  onApplied?: () => void;
}): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [services, setServices] = useState<DetectedService[]>([]);
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setServices([]);
    setApplied(false);
    apiRequest<{ services: DetectedService[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/detect-preview`,
    )
      .then((res) => {
        if (cancelled) return;
        // 只保留能生成构建配置的服务(带明确 runtime;dockerfile/auto 走其它路径)。
        const svc = (res.services || []).filter(
          (s) => s.runtime && s.runtime !== 'auto' && s.runtime !== 'dockerfile',
        );
        setServices(svc);
        setChecked(Object.fromEntries(svc.map((_, i) => [i, true])));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const selected = services.filter((_, i) => checked[i]);

  async function apply(): Promise<void> {
    if (selected.length === 0) return;
    setApplying(true);
    setError('');
    try {
      await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/detect-apply`, {
        method: 'POST',
        body: { services: selected },
      });
      setApplied(true);
      onApplied?.();
      setTimeout(() => onOpenChange(false), 700);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerCog className="h-5 w-5 text-primary" />
            检测技术栈
          </DialogTitle>
          <DialogDescription>
            CDS 扫描已克隆的代码，识别应用服务并按真实技术栈填好镜像 / 命令 / 端口。确认后生成构建配置，即可创建分支预览。
          </DialogDescription>
        </DialogHeader>

        <div
          className="min-h-[120px] max-h-[50vh] overflow-y-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40"
          style={{ overscrollBehavior: 'contain' }}
        >
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在扫描代码仓库…
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 px-4 py-6 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : services.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              未识别出可自动生成构建配置的应用服务。
              <br />
              可在「项目设置 → 构建配置」手动创建，或用 cdscli scan 生成 cds-compose.yml。
            </div>
          ) : (
            <ul className="divide-y divide-[hsl(var(--hairline))]">
              {services.map((svc, i) => (
                <li key={svc.id || i}>
                  <label className="flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-[hsl(var(--surface-sunken))]">
                    <input
                      type="checkbox"
                      checked={!!checked[i]}
                      onChange={(e) => setChecked((prev) => ({ ...prev, [i]: e.target.checked }))}
                      className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{svc.name || svc.id || '应用服务'}</span>
                        <span className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {RUNTIME_LABEL[svc.runtime] || svc.runtime}
                        </span>
                        {svc.port ? (
                          <span className="text-[11px] text-muted-foreground">端口 {svc.port}</span>
                        ) : null}
                      </span>
                      {svc.command ? (
                        <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground" title={svc.command}>
                          {svc.command}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={applying}>
            取消
          </Button>
          <Button onClick={() => void apply()} disabled={loading || applying || selected.length === 0}>
            {applying ? <Loader2 className="animate-spin" /> : <Wand2 />}
            {applied ? '已生成' : `生成 ${selected.length} 个构建配置`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
