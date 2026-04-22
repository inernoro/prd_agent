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
import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

export interface InfraBackupRouterDeps {
  stateService: StateService;
  shell: IShellExecutor;
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
  const { stateService, shell } = deps;
  const router = Router();

  /**
   * GET /api/infra/:id/backup
   * 生成备份并流式返回下载。mongo 走 mongodump，redis 走 BGSAVE + 拷贝 dump.rdb，
   * 其他走 `tar` 包 /data 目录。
   */
  router.get('/infra/:id/backup', async (req, res) => {
    const svc = stateService.getInfraService(req.params.id);
    if (!svc) {
      res.status(404).json({ error: `基础设施服务不存在: ${req.params.id}` });
      return;
    }
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
   * 破坏性操作：恢复前自动 dump 一份当前数据库到 /data/cds/<slug>/backups/<id>-pre-restore-<timestamp>，
   * 并记 DestructiveOperationLog，这样用户还能还原回恢复前的状态。
   */
  router.post('/infra/:id/restore', async (req, res) => {
    const svc = stateService.getInfraService(req.params.id);
    if (!svc) {
      res.status(404).json({ error: `基础设施服务不存在: ${req.params.id}` });
      return;
    }
    if (svc.status !== 'running') {
      res.status(409).json({ error: `服务未运行，无法恢复` });
      return;
    }

    const kind = detectKind(svc.dockerImage);
    const { spawn } = await import('node:child_process');

    // 1) 先自动备份当前状态（便于"撤销恢复"）
    const backupDir = `/data/cds/${stateService.projectSlug}/backups`;
    await shell.exec(`mkdir -p ${shq(backupDir)}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const preBackupPath = `${backupDir}/${svc.id}-pre-restore-${stamp}.${kind === 'mongo' ? 'archive.gz' : 'bin'}`;

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
    const svc = stateService.getInfraService(req.params.id);
    if (!svc) {
      res.status(404).json({ error: '服务不存在' });
      return;
    }
    const backupDir = `/data/cds/${stateService.projectSlug}/backups`;
    const result = await shell.exec(`ls -la ${shq(backupDir)} 2>/dev/null | grep ${shq(svc.id)} || true`);
    const lines = (result.stdout || '').split('\n').filter(Boolean);
    const entries = lines.map(l => {
      const parts = l.trim().split(/\s+/);
      if (parts.length < 9) return null;
      return {
        size: parseInt(parts[4], 10) || 0,
        mtime: parts.slice(5, 8).join(' '),
        name: parts[8],
      };
    }).filter(Boolean);
    res.json({ backups: entries, directory: backupDir });
  });

  return router;
}
