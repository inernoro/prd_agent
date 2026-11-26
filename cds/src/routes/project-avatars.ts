import { createHash, randomUUID } from 'node:crypto';
import { raw, type Request, type Response, type Router } from 'express';
import type { Project, ProjectAvatar } from '../types.js';
import type { StateService } from '../services/state.js';
import { canHumanAccessProject } from '../services/human-project-access.js';
import { waitForFlushWithTimeout } from '../services/bounded-flush.js';
import { reportObjectStoreFromEnv } from '../services/report-object-store.js';
import { deleteR2Object, fetchR2ObjectBuffer, uploadAndVerifyR2Object } from '../services/infra-backup-r2.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024;
const parseImage = raw({ type: IMAGE_TYPES, limit: MAX_BYTES, inflate: false });
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function detectImageType(body: Buffer): ProjectAvatar['contentType'] | undefined {
  if (body.length >= 45 && body.subarray(0, 8).equals(PNG_SIGNATURE) && body.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (body.length >= 12 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff && body.readUInt16BE(body.length - 2) === 0xffd9) return 'image/jpeg';
  if (body.length >= 20 && body.toString('ascii', 0, 4) === 'RIFF' && body.readUInt32LE(4) === body.length - 8
    && body.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(body.toString('ascii', 12, 16))) return 'image/webp';
  return undefined;
}

function objectKey(projectId: string, avatar: ProjectAvatar) {
  const project = createHash('sha256').update(projectId).digest('hex');
  return `cds-project-avatars/${project}/${avatar.version}`;
}

function storageConfig() {
  const config = reportObjectStoreFromEnv();
  if (!config) throw new Error('项目头像 R2 未配置');
  return config;
}

const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });

export interface ProjectAvatarStore {
  put(projectId: string, avatar: ProjectAvatar, bytes: Buffer): Promise<void>;
  get(projectId: string, avatar: ProjectAvatar): Promise<Buffer | null>;
  remove(projectId: string, avatar: ProjectAvatar): Promise<void>;
}

const r2AvatarStore: ProjectAvatarStore = {
  async put(projectId, avatar, body) {
    await uploadAndVerifyR2Object({ config: storageConfig(), objectKey: objectKey(projectId, avatar), body,
      contentType: avatar.contentType, fetchImpl: boundedFetch });
  },
  get: (projectId, avatar) => fetchR2ObjectBuffer({ config: storageConfig(), objectKey: objectKey(projectId, avatar), fetchImpl: boundedFetch }),
  remove: (projectId, avatar) => deleteR2Object({ config: storageConfig(), objectKey: objectKey(projectId, avatar), fetchImpl: boundedFetch }),
};

export function registerProjectAvatarRoutes(router: Router, state: StateService, store: ProjectAvatarStore = r2AvatarStore) {
  const path = '/projects/:id/avatar';
  const writes = new Map<string, Promise<void>>();
  const checkProject = (req: Request, res: Response, write = false): Project | undefined => {
    const project = state.getProject(req.params.id);
    if (!project || !canHumanAccessProject(req, state, project.id)) {
      res.status(404).json({ error: '项目不存在或不可见。' });
      return;
    }
    if (write && project.mirror) {
      res.status(403).json({ error: '镜像项目的头像由原项目管理。' });
      return;
    }
    return project;
  };
  const removeObject = (id: string, avatar: ProjectAvatar) => {
    void Promise.resolve().then(() => store.remove(id, avatar)).catch(() => {
      console.warn('[project-avatar] 无法删除已替换的头像对象', id, avatar.version);
    });
  };

  router.get(path, async (req, res) => {
    const project = checkProject(req, res);
    if (!project) return;
    const avatar = project.avatar;
    if (!avatar || (req.query.v !== undefined && req.query.v !== avatar.version)) {
      res.status(404).json({ error: '项目头像不存在。' });
      return;
    }
    res.set({ 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff', ETag: '"' + avatar.version + '"' });
    if (req.fresh) { res.status(304).end(); return; }
    try {
      const image = await store.get(project.id, avatar);
      if (!image || image.length > MAX_BYTES || detectImageType(image) !== avatar.contentType) {
        res.status(503).set('Cache-Control', 'no-store').json({ error: '项目头像暂时不可读取。' });
        return;
      }
      res.type(avatar.contentType).send(image);
    } catch {
      res.status(503).set('Cache-Control', 'no-store').json({ error: '项目头像暂时不可读取。' });
    }
  });

  async function replace(req: Request, res: Response, bytes?: Buffer, contentType?: ProjectAvatar['contentType']) {
    const project = checkProject(req, res, true);
    if (!project) return;
    const { id } = project;
    const priorWrite = writes.get(id) ?? Promise.resolve();
    const write = priorWrite.then(async () => {
      const beforeUpload = checkProject(req, res, true);
      if (!beforeUpload || beforeUpload.id !== id) return;
      const avatar = bytes && contentType ? { version: randomUUID(), contentType } : undefined;
      if (avatar && bytes) {
        try { await store.put(id, avatar, bytes); }
        catch {
          removeObject(id, avatar);
          res.status(503).json({ error: '头像未能保存到 R2，请稍后重试。' });
          return;
        }
      }
      // 项目可能在 R2 上传期间改名、被删除或被撤销授权。
      const before = state.getProject(id);
      if (!before || before.createdAt !== beforeUpload.createdAt || before.mirror || !canHumanAccessProject(req, state, id)) {
        if (avatar) removeObject(id, avatar);
        res.status(409).json({ error: '项目或权限已发生变化，请刷新后重试。' });
        return;
      }
      if (!before.avatar && !avatar) { res.json({ avatarVersion: null }); return; }
      let written: Project | undefined;
      try {
        try { state.updateProject(id, { avatar }); }
        finally { written = state.getProject(id); }
        if (await waitForFlushWithTimeout(() => state.flush(), 5_000) !== 'flushed') throw new Error('头像状态未确认');
      } catch {
        try {
          const restored = written === before || (written && written.avatar === avatar
            && state.restoreProjectSettingsUpdate(id, before, { ...written }, ['avatar'], written));
          const confirmed = await waitForFlushWithTimeout(() => state.flush(), 5_000) === 'flushed';
          if (avatar && restored && confirmed) removeObject(id, avatar);
        } catch { /* 无法确认回退落盘时保留对象，避免删除仍被引用的内容。 */ }
        res.status(503).json({ error: '头像设置未能保存，请刷新确认后重试。' });
        return;
      }
      if (before.avatar) removeObject(id, before.avatar);
      res.json({ avatarVersion: avatar?.version ?? null });
    });
    // 每个项目的上传、替换和恢复串行，其它项目可独立更新。
    const settled = write.catch(() => {});
    writes.set(id, settled);
    try { await write; }
    catch { if (!res.headersSent) res.status(503).json({ error: '头像设置未能保存，请稍后重试。' }); }
    finally { if (writes.get(id) === settled) writes.delete(id); }
  }

  router.put(path, (req, res) => {
    if (!checkProject(req, res, true)) return;
    const claimedType = req.is(IMAGE_TYPES);
    if (!claimedType) { res.status(415).json({ error: '请选择 PNG、JPEG 或 WebP 图片。' }); return; }
    parseImage(req, res, (error?: { status?: number }) => {
      if (error) {
        res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? '头像大小超过 2 MB。' : '无法读取头像文件。' });
        return;
      }
      const type = Buffer.isBuffer(req.body) && detectImageType(req.body);
      if (!type || type !== claimedType) { res.status(415).json({ error: '图片内容与文件格式不符。' }); return; }
      void replace(req, res, req.body, type);
    });
  });

  router.delete(path, (req, res) => { void replace(req, res); });

  return (project: Project) => { if (project.avatar && !project.mirror) removeObject(project.id, project.avatar); };
}
