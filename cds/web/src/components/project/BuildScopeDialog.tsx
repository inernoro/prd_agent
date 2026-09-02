/**
 * 挑本项目关心的目录 —— 同仓多项目那条提示的落脚点。
 *
 * ## 为什么不是一个文本框
 *
 * 第一版这里是个空的 textarea，让用户自己敲 `cds/**` 这样的通配。那等于把系统
 * 已经有的答案硬塞回去让用户猜：他要先想「填什么」，填完还要担心「填得对不对」。
 * 仓库里有哪些目录是列得出来的，每个服务待在哪个目录是从启动命令看得出来的，
 * 所以这里改成**勾选真实目录**，建议的那些默认勾上，并写明凭什么这么建议。
 *
 * 手写路径没有删掉，但降级成了折叠区：需要 `.github/workflows/**` 这种非一级目录
 * 的人自己会展开，其余人不该被它挡在门口。
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';

interface ScopeProfileOption {
  id: string;
  name: string;
  /** 用户自己定过的 —— 不是猜的，默认原样保留 */
  declared: string[];
  /** 系统看出来的建议 */
  suggested: string[];
  /** 凭什么这么建议，直接显示给用户核对 */
  why: string;
}

interface ScopeOptionsResponse {
  repoDirs: string[];
  suggestion: { scope: string[]; why: string; guessedCount: number } | null;
  profiles: ScopeProfileOption[];
}

/** 目录名转成范围条目；反过来也要认得出来，勾选态才对得上。 */
const dirToScope = (dir: string): string => `${dir}/**`;
const scopeToDir = (entry: string): string | null =>
  entry.endsWith('/**') ? entry.slice(0, -3) : null;

export function BuildScopeDialog({
  open,
  onOpenChange,
  projectId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  projectId: string;
  onSaved?: (message: string) => void;
}): JSX.Element {
  const [options, setOptions] = useState<ScopeOptionsResponse | null>(null);
  /** profileId -> 已勾选的目录 */
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  /** profileId -> 手写的额外路径（一行一条） */
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [showExtra, setShowExtra] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    apiRequest<ScopeOptionsResponse>(`/api/projects/${encodeURIComponent(projectId)}/scope-options`)
      .then((res) => {
        if (cancelled) return;
        setOptions(res);
        const nextPicked: Record<string, string[]> = {};
        const nextExtra: Record<string, string> = {};
        for (const profile of res.profiles) {
          // 已定过的优先，其次才是建议 —— 人做过的决定不该被一次猜盖掉
          const current = profile.declared.length > 0 ? profile.declared : profile.suggested;
          nextPicked[profile.id] = current.map(scopeToDir).filter((d): d is string => !!d);
          // 不是「目录/**」形状的（比如 .github/workflows/branch-image.yml）留在手写区，
          // 否则一保存就把它悄悄弄丢了
          const leftovers = current.filter((entry) => !scopeToDir(entry));
          nextExtra[profile.id] = leftovers.join('\n');
          if (leftovers.length > 0) setShowExtra(true);
        }
        setPicked(nextPicked);
        setExtra(nextExtra);
      })
      .catch((err) => { if (!cancelled) setError((err as Error)?.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  function toggle(profileId: string, dir: string): void {
    setPicked((prev) => {
      const current = prev[profileId] || [];
      return {
        ...prev,
        [profileId]: current.includes(dir) ? current.filter((d) => d !== dir) : [...current, dir],
      };
    });
  }

  function scopeFor(profileId: string): string[] {
    const dirs = (picked[profileId] || []).map(dirToScope);
    const manual = (extra[profileId] || '')
      .split(/[\n,]/).map((line) => line.trim()).filter(Boolean);
    return [...new Set([...dirs, ...manual])];
  }

  async function save(): Promise<void> {
    if (!options) return;
    setSaving(true);
    setError('');
    try {
      // 只发真的改了的：PUT 是整条构建配置的更新入口，没动过的不该走一遍写路径
      const changed = options.profiles.filter((profile) => {
        const before = [...(profile.declared.length > 0 ? profile.declared : profile.suggested)].sort().join(' ');
        return before !== [...scopeFor(profile.id)].sort().join(' ');
      });
      for (const profile of changed) {
        await apiRequest(`/api/build-profiles/${encodeURIComponent(profile.id)}`, {
          method: 'PUT',
          body: { buildScope: scopeFor(profile.id) },
        });
      }
      onSaved?.(changed.length > 0 ? `已更新 ${changed.length} 个服务的范围；下次推送生效` : '没有改动');
      onOpenChange(false);
    } catch (err) {
      setError((err as Error)?.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  const dirs = options?.repoDirs || [];
  const allEmpty = !!options
    && options.profiles.length > 0
    && options.profiles.every((p) => scopeFor(p.id).length === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>本项目关心仓库里的哪些目录</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">
            推送只改到没勾中的目录时，这个项目不会建分支、不会构建。下面是这个仓库真实的一级目录。
          </p>

          {loading ? <p className="text-sm text-muted-foreground">正在读取…</p> : null}
          {!loading && options && options.profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              这个项目还没有构建配置，先在「分支控制台」里创建一个，再回来勾目录。
            </p>
          ) : null}
          {!loading && options && options.profiles.length > 0 && dirs.length === 0 ? (
            <p className="rounded border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
              读不到这个项目的仓库目录（可能还没克隆下来），所以列不出候选。可以先展开下面的手写区填。
            </p>
          ) : null}

          {options?.profiles.map((profile) => {
            const current = picked[profile.id] || [];
            return (
              <div key={profile.id} className="space-y-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{profile.name}</span>
                  {profile.why ? (
                    <span className="text-xs text-muted-foreground">{profile.why}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">看不出它待在哪个目录，请自己挑</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {dirs.map((dir) => {
                    const on = current.includes(dir);
                    const isSuggested = profile.suggested.includes(dirToScope(dir));
                    return (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => toggle(profile.id, dir)}
                        aria-pressed={on}
                        className={[
                          'rounded border px-2 py-1 font-mono text-xs transition-colors',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border text-muted-foreground hover:border-primary',
                        ].join(' ')}
                        title={isSuggested ? '系统建议：这个服务看起来待在这里' : undefined}
                      >
                        {dir}
                        {isSuggested && !on ? <span className="ml-1">建议</span> : null}
                      </button>
                    );
                  })}
                </div>
                {current.length === 0 && (extra[profile.id] || '').trim() === '' ? (
                  <p className="text-xs text-muted-foreground">一个都不勾 = 全通配：任何一次推送都会重建。</p>
                ) : null}
              </div>
            );
          })}

          {options && options.profiles.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setShowExtra((v) => !v)}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                {showExtra ? '收起' : '还要加不是一级目录的路径？'}
              </button>
              {showExtra ? (
                <div className="mt-2 space-y-3">
                  {options.profiles.map((profile) => (
                    <div key={profile.id} className="space-y-1">
                      <label className="text-xs text-muted-foreground" htmlFor={`extra-${profile.id}`}>
                        {profile.name} 的额外路径（一行一条，例如 <code className="font-mono">.github/workflows/**</code>）
                      </label>
                      <textarea
                        id={`extra-${profile.id}`}
                        value={extra[profile.id] || ''}
                        onChange={(e) => setExtra((prev) => ({ ...prev, [profile.id]: e.target.value }))}
                        rows={2}
                        spellCheck={false}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {allEmpty ? (
            <p className="rounded border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
              一个都没勾等于没有划范围 —— 任何一次推送都会重建本项目。
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button
            onClick={() => void save()}
            disabled={saving || loading || !options || options.profiles.length === 0}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
