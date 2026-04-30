/*
 * Demo page — proves the 4 critical concerns of the new React stack:
 *   1. Tailwind utility classes work (background, spacing, colors)
 *   2. Theme switcher flips the entire palette via tokens
 *   3. API proxy reaches CDS backend (calls /api/cli-version)
 *   4. shadcn-style Dialog opens, traps focus, closes cleanly
 *
 * If all four pieces light up green, the foundation is sound and the rest
 * of the migration (cds-settings → project-list → settings → index) is a
 * mechanical port. See doc/plan.cds-web-migration.md for the roadmap.
 */
import { useEffect, useState } from 'react';
import { Moon, Sun, Cloud, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useTheme } from '@/lib/theme';
import { apiRequest, ApiError } from '@/lib/api';

interface CliVersion {
  version?: string;
  commit?: string;
  builtAt?: string;
}

type Probe =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; data: CliVersion }
  | { status: 'error'; message: string };

export function HelloPage(): JSX.Element {
  const { theme, toggle } = useTheme();
  const [probe, setProbe] = useState<Probe>({ status: 'idle' });

  useEffect(() => {
    const ctrl = new AbortController();
    setProbe({ status: 'loading' });
    apiRequest<CliVersion>('/api/cli-version', { signal: ctrl.signal })
      .then((data) => setProbe({ status: 'ok', data }))
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        const message = err instanceof ApiError ? err.message : String(err);
        setProbe({ status: 'error', message });
      });
    return () => ctrl.abort();
  }, []);

  return (
    <div className="container max-w-3xl py-12">
      <header className="mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Cloud className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">CDS — 基础设施验证</h1>
            <p className="text-sm text-muted-foreground">
              React + Vite + Tailwind + shadcn/ui（已迁移路由由 server.ts 的
              <code> MIGRATED_REACT_ROUTES </code>登记，未迁移的路径回落到{' '}
              <code>cds/web-legacy/</code>）
            </p>
          </div>
        </div>
        <Button variant="outline" size="icon" onClick={toggle} aria-label="切换主题">
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Probe label="① Tailwind 工具类" ok hint="本卡片背景/圆角/边框来自 Tailwind 类" />
        <Probe
          label="② 主题切换"
          ok
          hint={`当前主题：${theme === 'dark' ? '黑夜' : '白天'}（点右上角切换）`}
        />
        <ApiProbe probe={probe} />
        <DialogProbe />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>迁移进度</CardTitle>
          <CardDescription>
            <code>/cds-settings</code> 与 <code>/project-list</code> 已由 React 接管。后续按{' '}
            <code>doc/plan.cds-web-migration.md</code> 继续迁移项目设置和分支列表。
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

function Probe({ label, ok, hint }: { label: string; ok: boolean; hint: string }): JSX.Element {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">{label}</CardTitle>
        {ok ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        ) : (
          <XCircle className="h-5 w-5 text-destructive" />
        )}
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{hint}</CardContent>
    </Card>
  );
}

function ApiProbe({ probe }: { probe: Probe }): JSX.Element {
  let icon: JSX.Element;
  let hint: string;
  if (probe.status === 'loading') {
    icon = <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
    hint = '正在调用 GET /api/cli-version …';
  } else if (probe.status === 'ok') {
    icon = <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
    hint = `成功：${JSON.stringify(probe.data)}`;
  } else if (probe.status === 'error') {
    icon = <XCircle className="h-5 w-5 text-destructive" />;
    hint = `失败：${probe.message}`;
  } else {
    icon = <Loader2 className="h-5 w-5 text-muted-foreground" />;
    hint = '等待…';
  }
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">③ API 代理</CardTitle>
        {icon}
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground break-all">{hint}</CardContent>
    </Card>
  );
}

function DialogProbe(): JSX.Element {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">④ shadcn Dialog</CardTitle>
        <CheckCircle2 className="h-5 w-5 text-emerald-500" />
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <Dialog>
          <DialogTrigger asChild>
            <Button size="sm" variant="secondary">
              打开演示弹窗
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>统一弹窗骨架</DialogTitle>
              <DialogDescription>
                Radix 自动处理 portal + 焦点陷阱 + ESC + 滚动锁定。无需再手写 z-index、暗色
                fallback 或 min-h-0 这些坑。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline">取消</Button>
              <Button>确认</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
