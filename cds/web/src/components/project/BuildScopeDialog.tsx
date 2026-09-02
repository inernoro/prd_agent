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
  /**
   * 这条范围能不能在这里改。范围声明在部署模式上时不能：本对话框写的是 profile
   * 顶层字段，判定取两者并集，于是「清空」清不掉、「改窄」反而变宽（Codex P2）。
   */
  editable: boolean;
  /** 声明在部署模式上的那份，只读展示用 */
  declaredOnDeployModes: string[];
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
      // 只发真的改了的：PUT 是整条构建配置的更新入口，没动过的不该走一遍写路径。
      //
      // 基线只能是**已落库**的 declared，不能把 suggested 也算进去（Codex P2）：
      // 建议只是预勾在界面上，库里那条仍是空的。拿 suggested 当基线的话，用户
      // 接受默认值点保存 → 前后相等 → 一条 PUT 都不发 → 弹窗说「没有改动」，
      // 而范围依然没划，每次推送照样全量重建。
      const changed = options.profiles.filter((profile) => {
        // 只读那些一律不发：发了也盖不掉部署模式上的那份，只会让提示说谎
        if (!profile.editable) return false;
        const before = [...profile.declared].sort().join(' ');
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

  /**
   * 可勾的目录 = 仓库一级目录 ∪ 当前已选中的目录。
   *
   * 后者不能少（Codex P2）：推断出来的范围常常是嵌套的（本仓库就有 `llmgw/serving`、
   * `llmgw/web`），它们不在一级目录清单里。只渲染一级目录的话，这些值**看不见、
   * 点不掉，保存时却照样写回去**——用户面对的就是一个说不清自己在干什么的界面。
   */
  const dirs = (() => {
    const base = options?.repoDirs || [];
    const extraDirs = Object.values(picked).flat().filter((d) => !base.includes(d));
    return [...base, ...[...new Set(extraDirs)].sort()];
  })();
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
            if (!profile.editable) {
              // 这条的范围写在部署模式里（多半来自 compose 的 cds.build-scope）。
              // 在这里改盖不掉它，所以如实只读展示，而不是给一个改了不生效的开关。
              return (
                <div key={profile.id} className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{profile.name}</span>
                    <span className="text-xs text-muted-foreground">范围写在部署模式里，这里改不了</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {profile.declaredOnDeployModes.map((entry) => (
                      <span key={entry} className="rounded border border-border px-2 py-1 font-mono text-xs text-muted-foreground">
                        {entry}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    要改它，改这个服务在 compose 里的 <code className="font-mono">cds.build-scope</code> 标签后重新导入。
                  </p>
                </div>
              );
            }
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
                        {!(options?.repoDirs || []).includes(dir) ? (
                          <span className="ml-1 opacity-70">子目录</span>
                        ) : null}
                        {isSuggested && !on ? <span className="ml-1">建议</span> : null}
                      </button>
                    );
                  })}
                </div>
                {current.length === 0 && (extra[profile.id] || '').trim() === '' ? (
                  <p className="text-xs text-muted-foreground">
                    这个服务一个都不勾 = 全通配，而且会让整个项目退回全通配（哪怕别的服务划了范围）。
                  </p>
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
                  {options.profiles.filter((p) => p.editable).map((profile) => (
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
            disabled={saving || loading || !options || options.profiles.filter((p) => p.editable).length === 0}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
