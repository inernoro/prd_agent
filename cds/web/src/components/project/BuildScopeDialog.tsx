/**
 * 声明构建范围 —— 同仓多项目那条警示的落脚点。
 *
 * 警示不给出手就等于噪音：横幅说「任何一次推送都会把它们全部重建」，用户点一下
 * 就该到能改这件事的地方。此前 CDS 的 buildScope 只能靠 API 改，界面上根本没有
 * 入口，所以这个对话框和横幅是一起的，不是可选的装饰。
 *
 * 判据在后端（webhook 分发时按项目名下全部服务的 buildScope 并集判定），这里只
 * 负责把它填进去。空 = 全通配 = 每次推送都重建，这一点必须写在界面上，因为「留空
 * 等于最危险」是反直觉的。
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/api';

interface ScopedProfile {
  id: string;
  name: string;
  buildScope?: string[];
}

function toText(scope: string[] | undefined): string {
  return (scope || []).join('\n');
}

function toScope(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

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
  const [profiles, setProfiles] = useState<ScopedProfile[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    apiRequest<{ profiles: ScopedProfile[] }>(`/api/build-profiles?project=${encodeURIComponent(projectId)}`)
      .then((res) => {
        if (cancelled) return;
        const list = res.profiles || [];
        setProfiles(list);
        setDrafts(Object.fromEntries(list.map((p) => [p.id, toText(p.buildScope)])));
      })
      .catch((err) => { if (!cancelled) setError((err as Error)?.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, projectId]);

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    try {
      // 只发真的改了的那几条：PUT 是整条构建配置的更新入口，不该为没动过的
      // 配置也走一遍写路径。
      const changed = profiles.filter((p) => toText(p.buildScope) !== (drafts[p.id] ?? ''));
      for (const profile of changed) {
        await apiRequest(`/api/build-profiles/${encodeURIComponent(profile.id)}`, {
          method: 'PUT',
          body: { buildScope: toScope(drafts[profile.id] ?? '') },
        });
      }
      onSaved?.(changed.length > 0
        ? `已更新 ${changed.length} 个构建配置的范围；下次推送生效`
        : '没有改动');
      onOpenChange(false);
    } catch (err) {
      setError((err as Error)?.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  const allEmpty = profiles.length > 0 && profiles.every((p) => toScope(drafts[p.id] ?? '').length === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>声明构建范围</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="text-sm text-muted-foreground">
            一行一条路径通配，例如 <code className="font-mono">cds/**</code>。推送只改到范围外的文件时，
            这个项目不会建分支、不会构建。
          </p>
          {loading ? <p className="text-sm text-muted-foreground">正在读取构建配置…</p> : null}
          {!loading && profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              这个项目还没有构建配置，先在「分支控制台」里创建一个，再回来划范围。
            </p>
          ) : null}
          {profiles.map((profile) => (
            <div key={profile.id} className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor={`scope-${profile.id}`}>
                {profile.name}
              </label>
              <textarea
                id={`scope-${profile.id}`}
                value={drafts[profile.id] ?? ''}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [profile.id]: e.target.value }))}
                rows={3}
                spellCheck={false}
                placeholder="留空 = 全通配：任何一次推送都会重建"
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </div>
          ))}
          {allEmpty ? (
            <p className="rounded border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
              全部留空等于没有声明范围 —— 这正是横幅提示的那种情况，任何一次推送都会重建本项目。
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={() => void save()} disabled={saving || loading || profiles.length === 0}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
