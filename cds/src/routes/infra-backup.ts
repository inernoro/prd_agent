/**
 * 基础设施数据备份 / 恢复
 *
 * 满足用户需求：「增加备份数据库功能，让用户可以下载数据库」+「破坏性操作紧急还原」。
 *
 * 支持的 infra 类型：
 *   - mongodb → mongodump/mongorestore（archive + gzip 单流）
 *   - mongo   → 同 mongodb
 *   - redis   → BGSAVE + 复制 dump.rdb
 *   - 其他    → 简单 tar 容器数据卷 `/data`
 *
 * API：
 *   GET  /api/infra/:id/backup         一键下载当前数据库（流式）
 *   POST /api/infra/:id/restore        上传 dump 文件恢复
 *   GET  /api/infra/:id/backup-history 列出已保存在 CDS 服务器的自动备份（可选）
 */
import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { IShellExecutor, InfraService } from '../types.js';
import { combinedOutput } from '../types.js';
import { isPreviewInstance } from '../services/preview-instance.js';
import {
  backupDirCandidates,
  backupKey,
  isLegacyUnscopedBackupFile,
  isProjectBackupFile,
} from '../services/infra-backup-schedule.js';

export interface InfraBackupRouterDeps {
  stateService: StateService;
  shell: IShellExecutor;
  /** Inline project-scope guard. No-op for admin/cookie auth; 403 for a project-scoped key reaching another project. */
  assertProjectAccess: (req: any, projectId: string) => { status: number; body: unknown } | null;
  /** 备份目录兜底候选要用到（放在 repoRoot 旁边）。缺省时只试前两个候选。 */
  repoRoot?: string;
}

function detectKind(dockerImage: string): 'mongo' | 'redis' | 'generic' {
  const lower = dockerImage.toLowerCase();
  if (lower.includes('mongo')) return 'mongo';
  if (lower.includes('redis')) return 'redis';
  return 'generic';
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/** 从 env 里抠 mongo root 账号密码，同时兼容两种写法。 */
function extractMongoAuth(env: Record<string, string>): { user?: string; password?: string } {
  return {
    user: env.MONGO_INITDB_ROOT_USERNAME || env.MONGO_USERNAME || env.MONGODB_USERNAME,
    password: env.MONGO_INITDB_ROOT_PASSWORD || env.MONGO_PASSWORD || env.MONGODB_PASSWORD,
  };
}

export function createInfraBackupRouter(deps: InfraBackupRouterDeps): Router {
  const { stateService, shell, assertProjectAccess } = deps;
  const router = Router();

  /**
   * 备份目录。与自动备份走**同一份候选**（services/infra-backup-schedule.ts）：
   * 两边落在不同目录的话，「备份历史」看不见自动备份，又是一次「以为有、其实没有」。
   * 逐个试写，用第一个真能写的；都不行就回退到首选，让失败暴露在写盘那一步。
   */
  async function resolveBackupDir(opts?: { create?: boolean }): Promise<string> {
    const create = opts?.create !== false;
    const candidates = backupDirCandidates({
      slug: stateService.projectSlug,
      repoRoot: deps.repoRoot,
    });
    for (const c of candidates) {
      // 只读路径（备份历史）**不许建目录**。建了之后紧跟着的 `test -d` 必然为真，
      // 「一份备份都没有过」就被报成「目录在、只是没有匹配项」——刚加的那个区分
      // 当场作废，而它要防的正是零备份长期不被发现。写盘路径才允许创建。
      const probe = create
        ? await shell.exec(`mkdir -p ${shq(c)} && test -w ${shq(c)} && echo ok`)
        : await shell.exec(`test -d ${shq(c)} && test -w ${shq(c)} && echo ok`);
      if (probe.exitCode === 0 && (probe.stdout || '').includes('ok')) return c;
    }
    return candidates[0];
  }

  // 预览实例统一守卫（Codex P2，2026-07-15）：备份/恢复直接 spawn docker，
  // 绕过 PreviewInstanceShellExecutor。预览实例没有真实 infra 容器，路由器级
  // 一次罩住本文件全部端点（backup / restore / backup-history）。
  router.use((req, res, next) => {
    // 注意按路径过滤:本 router 可能与其他 /api 路由共用挂载点,裸 use 会误伤。
    if (!isPreviewInstance() || !/^\/infra\/[^/]+\/(backup|restore|backup-history)/.test(req.path)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'preview_instance',
      message: 'CDS 预览实例没有真实基础设施容器，无法执行备份/恢复。此实例仅用于验收 CDS 自身的界面与交互。',
    });
  });

  /**
   * Resolve a project-owned infra service for this request and enforce that a
   * project-scoped key only touches its own project. Returns the service, or
   * null after already writing the 404/403 response. These endpoints stream
   * full DB dumps (mongodump / dump.rdb / tar) so cross-project access would
   * leak another tenant's data. No-op for admin / cookie auth.
   */
  function resolveScoped(
    req: import('express').Request,
    res: import('express').Response,
  ): InfraService | null {
    // infra id 在多项目下并非全局唯一(两个项目都可能有 catalog 创建的 `postgres`)。带 ?project=
    // 时按项目精确定位(与 infra-data 的 handle 一致),否则回退全局首个匹配。少了这一步,owner 用
    // ?project=B 反而会被全局首个(属于 A 的)命中导致 403,admin 也可能误流/误恢复到别项目的库。
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    // 省略 ?project= 且该 id 跨多个项目存在时,拒绝"全局首个"猜测(避免 admin 误把别租户的库
    // dump/restore 掉)。要求显式指定项目。
    if (!projectFilter && stateService.getProjectInfraServicesById(req.params.id).length > 1) {
      res.status(400).json({ error: 'project_required', message: `基础设施 "${req.params.id}" 在多个项目中存在,请用 ?project=<projectId> 指定目标项目后再操作。` });
      return null;
    }
    const svc = projectFilter
      ? (stateService.getInfraServicesForProject(projectFilter).find((s) => s.id === req.params.id) || null)
      : stateService.getInfraService(req.params.id);
    if (!svc) {
      res.status(404).json({ error: `基础设施服务不存在: ${req.params.id}` });
      return null;
    }
    const mismatch = assertProjectAccess(req, svc.projectId);
    if (mismatch) {
      res.status(mismatch.status).json(mismatch.body as Record<string, unknown>);
      return null;
    }
    return svc;
  }

  /**
   * GET /api/infra/:id/backup
   * 生成备份并流式返回下载。mongo 走 mongodump，redis 走 BGSAVE + 拷贝 dump.rdb，
   * 其他走 `tar` 包 /data 目录。
   */
  router.get('/infra/:id/backup', async (req, res) => {
    const svc = resolveScoped(req, res);
    if (!svc) return;
    if (svc.status !== 'running') {
      res.status(409).json({ error: `服务 "${svc.id}" 当前未运行（status=${svc.status}），无法备份。请先启动。` });
      return;
    }

    const kind = detectKind(svc.dockerImage);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${svc.id}-${stamp}.${kind === 'mongo' ? 'archive.gz' : kind === 'redis' ? 'rdb' : 'tar.gz'}`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const { spawn } = await import('node:child_process');

    try {
      if (kind === 'mongo') {
        const auth = extractMongoAuth(svc.env);
        const authArgs: string[] = [];
        if (auth.user && auth.password) {
          authArgs.push('-u', auth.user, '-p', auth.password, '--authenticationDatabase', 'admin');
        }
        const cmd = [
          'docker', 'exec', svc.containerName,
          'mongodump', '--archive', '--gzip', ...authArgs,
        ];
        const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.pipe(res);
        let stderr = '';
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
        proc.on('close', (code) => {
          if (code !== 0) {
            console.error(`[infra-backup] mongodump exit ${code}: ${stderr}`);
            if (!res.writableEnded) res.end();
          }
          // 记一条破坏性操作（备份自己不是破坏性，不记）
        });
        proc.on('error', (err) => {
          if (!res.headersSent) res.status(500).json({ error: err.message });
          else res.end();
        });
      } else if (kind === 'redis') {
        // 1) BGSAVE 触发磁盘写入 2) 等待 lastsave 变化 3) cat /data/dump.rdb
        await shell.exec(`docker exec ${shq(svc.containerName)} redis-cli BGSAVE`);
        // 简化：sleep 1s 后 cat dump.rdb（生产环境应轮询 LASTSAVE）
        await new Promise((r) => setTimeout(r, 1200));
        const cmd = ['docker', 'exec', svc.containerName, 'cat', '/data/dump.rdb'];
        const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.pipe(res);
        proc.on('error', (err) => {
          if (!res.headersSent) res.status(500).json({ error: err.message });
          else res.end();
        });
      } else {
        // generic: tar /data
        const cmd = ['docker', 'exec', svc.containerName, 'tar', '-czf', '-', '-C', '/data', '.'];
        const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.pipe(res);
        proc.on('error', (err) => {
          if (!res.headersSent) res.status(500).json({ error: err.message });
          else res.end();
        });
      }
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/infra/:id/restore
   * 上传一份之前导出的 dump 文件恢复。body 是原始字节流。
   *
   * 破坏性操作：恢复前自动 dump 一份当前数据库到
   * /data/cds/<slug>/backups/<项目>--<id>-pre-restore-<timestamp>，
   * 并记 DestructiveOperationLog，这样用户还能还原回恢复前的状态。
   *
   * 文件名带项目段的理由与周期备份同源（见 backupKey）：infra id 只在项目内唯一，
   * 六个项目各有一个 `redis`，同一秒里两个项目各恢复一次，后写的会盖掉先写的那份
   * 救命快照。周期备份这一轮修了，恢复前快照是同一个形状的另一处，一起修。
   */
  router.post('/infra/:id/restore', async (req, res) => {
    const svc = resolveScoped(req, res);
    if (!svc) return;
    if (svc.status !== 'running') {
      res.status(409).json({ error: `服务未运行，无法恢复` });
      return;
    }

    const kind = detectKind(svc.dockerImage);
    const { spawn } = await import('node:child_process');

    // 1) 先自动备份当前状态（便于"撤销恢复"）
    const backupDir = await resolveBackupDir();
    await shell.exec(`mkdir -p ${shq(backupDir)}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const preBackupPath = `${backupDir}/${backupKey(svc.projectId, svc.id)}-pre-restore-${stamp}.${kind === 'mongo' ? 'archive.gz' : 'bin'}`;

    try {
      if (kind === 'mongo') {
        const auth = extractMongoAuth(svc.env);
        const authArgs: string[] = [];
        if (auth.user && auth.password) {
          authArgs.push('-u', auth.user, '-p', auth.password, '--authenticationDatabase', 'admin');
        }
        const dumpCmd = `docker exec ${shq(svc.containerName)} mongodump --archive --gzip ${authArgs.map(shq).join(' ')} > ${shq(preBackupPath)}`;
        await shell.exec(dumpCmd);
      }
    } catch (err) {
      console.error('[infra-restore] pre-restore backup 失败', err);
      // 不阻止恢复；只是少一个兜底
    }

    // 2) 执行恢复
    try {
      if (kind === 'mongo') {
        const auth = extractMongoAuth(svc.env);
        const authArgs: string[] = [];
        if (auth.user && auth.password) {
          authArgs.push('-u', auth.user, '-p', auth.password, '--authenticationDatabase', 'admin');
        }
        const cmd = [
          'docker', 'exec', '-i', svc.containerName,
          'mongorestore', '--archive', '--gzip', '--drop', ...authArgs,
        ];
        const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
        req.pipe(proc.stdin);
        let stderr = '';
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
        proc.on('close', (code) => {
          if (code !== 0) {
            res.status(500).json({ error: `mongorestore exit ${code}`, detail: stderr });
            return;
          }
          stateService.recordDestructiveOp({
            type: 'purge-database',
            summary: `恢复 ${svc.id} 数据库（预备份已保存：${preBackupPath}）`,
          });
          res.json({ restored: true, preRestoreBackup: preBackupPath, message: '数据库已恢复' });
        });
      } else if (kind === 'redis') {
        // Redis restore：写入 /data/dump.rdb 然后重启容器加载
        const cmd = ['docker', 'exec', '-i', svc.containerName, 'sh', '-c', 'cat > /data/dump.rdb'];
        const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] });
        req.pipe(proc.stdin);
        proc.on('close', async (code) => {
          if (code !== 0) {
            res.status(500).json({ error: `写入 dump.rdb 失败 exit=${code}` });
            return;
          }
          // 重启容器让 redis 重新加载
          await shell.exec(`docker restart ${shq(svc.containerName)}`).catch(() => { /* noop */ });
          stateService.recordDestructiveOp({
            type: 'purge-database',
            summary: `恢复 ${svc.id} Redis dump.rdb 并重启容器`,
          });
          res.json({ restored: true, message: 'Redis 已从 dump.rdb 恢复并重启' });
        });
      } else {
        res.status(400).json({ error: '暂不支持该 infra 类型的自动恢复，请手动导入' });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/infra/:id/backup-history
   * 列出保存在 CDS 服务器 /data/cds/<slug>/backups/ 下的自动备份。
   */
  router.get('/infra/:id/backup-history', async (req, res) => {
    const svc = resolveScoped(req, res);
    if (!svc) return;
    const backupDir = await resolveBackupDir({ create: false });
    // 目录不存在时 `ls` 的错误此前被 2>/dev/null 吞掉，返回的空列表与「备份过但
    // 没有匹配项」长得一模一样——零备份可以就这么一直不被发现。这里显式区分。
    const probe = await shell.exec(`test -d ${shq(backupDir)} && echo yes || echo no`);
    const dirExists = (probe.stdout || '').includes('yes');
    // 筛选**不能**交给 `grep <id>`：备份目录是所有项目共用的，而 infra id 只在项目内
    // 唯一，子串匹配还会把 `redis-cache` 一起捞给 `redis`。判据走 isProjectBackupFile
    // （与写入端同一份），旧命名的恢复前快照单独标记后照列。
    const result = await shell.exec(`ls -la ${shq(backupDir)} 2>/dev/null || true`);
    const lines = (result.stdout || '').split('\n').filter(Boolean);
    const entries = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      if (parts.length < 9) return null;
      const name = parts.slice(8).join(' ');
      const mine = isProjectBackupFile(name, svc.projectId, svc.id);
      const legacy = !mine && isLegacyUnscopedBackupFile(name, svc.id);
      if (!mine && !legacy) return null;
      return {
        size: parseInt(parts[4], 10) || 0,
        mtime: parts.slice(5, 8).join(' '),
        name,
        /**
         * true = 文件名里没有项目段，是项目限定命名之前留下的，无法确认属于哪个项目。
         * 照列是因为它多半就是本项目的救命快照；标出来是因为「多半」不等于「确认」。
         */
        unscoped: legacy,
      };
    }).filter(Boolean);
    res.json({
      backups: entries,
      directory: backupDir,
      /** false = 目录都还不存在，也就是一份备份都没有过；别把它读成「暂无匹配」。 */
      directoryExists: dirExists,
    });
  });

  return router;
}
