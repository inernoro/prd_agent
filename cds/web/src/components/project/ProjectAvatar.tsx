import { useEffect, useState, type FormEvent } from 'react';
import { ImagePlus } from 'lucide-react';
import { apiRequest, apiUrl } from '@/lib/api';
import { userErrorMessage } from '@/lib/userErrorMessage';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface AvatarProject {
  id: string;
  slug: string;
  name: string;
  avatarVersion?: string;
}

const tones = ['bg-info-soft text-info', 'bg-ok-soft text-ok', 'bg-warn-soft text-warn', 'bg-accent text-accent-foreground'];
const acceptedTypes = ['image/png', 'image/jpeg', 'image/webp'];
const avatarPath = (id: string) => `/api/projects/${encodeURIComponent(id)}/avatar`;

export function ProjectAvatar({ project, preview }: { project: AvatarProject; preview?: string }): JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string>();
  const source = preview || (project.avatarVersion
    ? apiUrl(`${avatarPath(project.id)}?v=${encodeURIComponent(project.avatarVersion)}`) : undefined);
  const hash = [...project.id].reduce((value, char) => ((value * 31) + char.codePointAt(0)!) >>> 0, 0);
  const monogram = [...(project.slug || project.name || project.id)].slice(0, 2).join('').toLocaleUpperCase();
  return <span className={`cds-project-monogram cds-project-avatar-img ${tones[hash % tones.length]}`} aria-hidden="true">
    {source && source !== failedUrl
      ? <img src={source} alt="" onError={() => setFailedUrl(source)} />
      : monogram}
  </span>;
}

export function ProjectAvatarEditor({ project, title, onClose, onSaved }: {
  project: AvatarProject;
  title: string;
  onClose(): void;
  onSaved(version: string | null): void;
}): JSX.Element {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!file) return;
    let current = true;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    void image.decode().then(() => { if (current) setPreview(url); }).catch(() => {
      if (current) setError('无法打开这张图片，请选择其他文件。');
    });
    return () => { current = false; URL.revokeObjectURL(url); };
  }, [file]);

  const changeAvatar = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (busy || (event && (!file || !preview))) return;
    setError('');
    setBusy(true);
    try {
      if (!event || !file) {
        const result = await apiRequest<{ avatarVersion: null }>(avatarPath(project.id), { method: 'DELETE' });
        onSaved(result.avatarVersion);
        return;
      }
      const response = await fetch(apiUrl(avatarPath(project.id)), {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': file.type }, body: file,
      });
      const result = await response.json().catch(() => null) as { avatarVersion?: string; error?: string } | null;
      if (!response.ok || !result?.avatarVersion) throw new Error(result?.error || '头像保存失败，请稍后重试。');
      onSaved(result.avatarVersion);
    } catch (err) {
      setError(userErrorMessage(err));
    } finally { setBusy(false); }
  };

  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="w-[calc(100%-2rem)] max-w-sm">
      <DialogHeader>
        <DialogTitle>更换项目头像</DialogTitle>
        <DialogDescription>{title}</DialogDescription>
      </DialogHeader>
      <form onSubmit={event => void changeAvatar(event)} className="space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <span className="cds-project-avatar-preview"><ProjectAvatar project={project} preview={preview} /></span>
          <div className="min-w-0 flex-1 basis-40 space-y-1.5">
            <label className="block text-sm font-medium" htmlFor="project-avatar-file">选择图片</label>
            <input id="project-avatar-file" type="file" accept={acceptedTypes.join(',')} disabled={busy}
              className="block w-full text-sm file:mr-2 file:rounded-md file:border file:border-border file:bg-muted file:px-2 file:py-1.5"
              onChange={event => {
                const chosen = event.target.files?.[0];
                if (!chosen) return;
                setPreview(undefined);
                if (!acceptedTypes.includes(chosen.type) || chosen.size === 0 || chosen.size > 2 * 1024 * 1024) {
                  event.target.value = ''; setFile(undefined); setError('请选择 2 MB 以内的 PNG、JPEG 或 WebP 图片。'); return;
                }
                setFile(chosen); setError('');
              }} />
            <p className="text-xs text-muted-foreground">PNG、JPEG 或 WebP，最大 2 MB。</p>
          </div>
        </div>
        {error && <p className="text-sm text-bad" role="alert">{error}</p>}
        <DialogFooter className="gap-2 sm:flex-wrap">
          {project.avatarVersion && <Button type="button" variant="ghost" disabled={busy} onClick={() => void changeAvatar()}>恢复默认</Button>}
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button type="submit" disabled={!file || !preview || busy}><ImagePlus />{busy ? '保存中…' : '保存头像'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
