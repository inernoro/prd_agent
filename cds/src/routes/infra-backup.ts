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
  buildRedisBackupProbeScript,
  redisAuthFromServiceDefinition,
  redisProbeStdin,
  buildMysqlDumpScript,
  buildMysqlRestoreScript,
  buildMysqlTableCountScript,
  buildRedisAppendOnlyScript,
  buildRedisRestorePlan,
  buildRedisRdbPathScript,
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

function detectKind(dockerImage: string): 'mongo' | 'redis' | 'mysql' | 'generic' {
  const lower = dockerImage.toLowerCase();
  if (lower.includes('mongo')) return 'mongo';
  if (lower.includes('redis')) return 'redis';
  // mysql/mariadb 此前没有分支，掉进 generic 的 `tar -C /data`——而它们的数据在
  // /var/lib/mysql，于是下载到一个空壳还回 200（E41）。判定与周期备份的 backupKindOf 对齐。
  if (lower.includes('mysql') || lower.includes('mariadb')) return 'mysql';
  return 'generic';
}

function shq(s: string): string {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/**
 * 截断命令输出取**尾**不取头。
 *
 * 失败原因永远在输出末尾；`slice(0, N)` 会把它整段切掉，只留下一堆启动噪音
 * （house rule 见 release-ssh-failure-detail 的三宗罪）。本文件原先七处
 * 报错全是头截断——同一个口径分散七份，所以收敛到这一个函数。
 */
function outputTail(s: string, max = 300): string {
  const t = String(s || '').trim();
  return t.length > max ? `…（前文截断）${t.slice(-max)}` : t;
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
    const filename = `${svc.id}-${stamp}.`
      + (kind === 'mongo' ? 'archive.gz' : kind === 'redis' ? 'rdb' : kind === 'mysql' ? 'sql.gz' : 'tar.gz');

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
        // 走**和周期备份同一个**探测脚本：它认证（env 取不到就扫容器内进程命令行里的
        // --requirepass）、用 INFO persistence 确认 BGSAVE 真的完成、再用 mtime 证明
        // 文件被这次写过，最后回传快照的真实路径（CONFIG GET dir/dbfilename）。
        //
        // 上一版是「BGSAVE 忽略退出码 → sleep 1.2s → cat 写死的 /data/dump.rdb」，
        // 三处都会静默给出**陈旧快照**：配了 requirepass 的库 BGSAVE 直接 NOAUTH；
        // 1.2 秒对稍大的库根本不够；改过 dir 的实例那个路径上压根不是它的快照。
        // 而这个端点还是项目迁移的数据来源——「以为备了、其实是旧的」比没有备份更危险。
        // 与周期备份同一条送法：脚本走 stdin（`sh -s`），CDS 存的那份口令随之进去，
        // 宿主命令行上不留明文。
        const probe = await shell.exec(
          `docker exec -i ${shq(svc.containerName)} sh -s`,
          {
            timeout: 120_000,
            stdin: redisProbeStdin(buildRedisBackupProbeScript(), redisAuthFromServiceDefinition(svc)),
          },
        );
        if (probe.exitCode !== 0) {
          return res.status(500).json({
            error: `BGSAVE 未确认完成，拒绝下载可能过期的快照：${outputTail(combinedOutput(probe), 300)}`,
          });
        }
        const rdbPath = (probe.stdout || '').trim().split('\n').pop()?.trim() || '';
        if (!rdbPath.startsWith('/')) {
          return res.status(500).json({ error: '探测脚本没有回传快照路径，拒绝按默认路径猜' });
        }
        const cmd = ['docker', 'exec', svc.containerName, 'cat', rdbPath];
        const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.stdout.pipe(res);
        proc.on('error', (err) => {
          if (!res.headersSent) res.status(500).json({ error: err.message });
          else res.end();
        });
      } else if (kind === 'mysql') {
        // mysql 此前掉进下面的兜底 `tar -C /data`，而 mysql 的数据在 /var/lib/mysql，
        // 于是**下载得到一个 22 字节的空 gzip 壳，HTTP 却是 200**（E41，2026-08-18 实测
        // 三个 mysql 全是这样）。拿它当迁移数据源或动手前的兜底，等于什么都没有。
        // 现在走与周期备份同一段导出脚本：流式压缩、两端退出码都保住。
        const cmd = ['docker', 'exec', '-i', svc.containerName, 'sh', '-s'];
        const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.end(buildMysqlDumpScript());
        proc.stdout.pipe(res);
        let stderr = '';
        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
        proc.on('close', (code) => {
          if (code !== 0) {
            // 截断取**尾**不取头：真正说明失败原因的那几行在末尾，取头只会拿到
            // 一堆无关的启动噪音（house rule 见 ssh-exec-failure 的三宗罪）。
            const tail = stderr.length > 300 ? `…（前文截断）${stderr.slice(-300)}` : stderr;
            console.error(`[infra-backup] mysqldump exit ${code}: ${tail}`);
            if (!res.headersSent) res.status(500).json({ error: `导出失败 exit=${code}`, detail: tail });
            else res.destroy(new Error(`mysqldump exit ${code}: ${tail}`));
          }
        });
        proc.on('error', (err) => {
          if (!res.headersSent) res.status(500).json({ error: err.message });
          else res.end();
        });
      } else {
        // generic: tar /data。只对「数据确实在 /data」的类型成立；
        // 新增类型前先确认它的数据目录，否则又是一个「200 但空壳」。
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
    // 进函数第一件事：把请求流按住。**必须在任何 await 之前**。
    //
    // master 的 HTTP 日志中间件为了记录请求体挂了 `req.on('data')`，那一下就把
    // 请求流切进了 flowing 模式。同一个 tick 里挂上的消费者（路由自带的 json
    // 解析器就是这样）照样收得到数据，所以绝大多数接口毫无异样；但本 handler
    // 要先 await 好几次（解析服务、探测备份目录）才 `req.pipe()`，等它 pipe 的
    // 时候 body 早被日志中间件读完了——落到暂存文件里**一个字节都没有**。
    //
    // 后果不是报错而是假成功：空文件 docker cp 进容器，`gunzip | mysql` 里
    // mysql 收到零字节正常退出，接口回一句「已恢复」。E42 就是这么来的，
    // 上传 7MB 的 dump 全程 4 秒、库里一张表没多。
    //
    // pause 之后数据留在内核与流的缓冲里，后面 `req.pipe()` 会自动 resume。
    req.pause();
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
    // 扩展名要说明这份撤销快照是什么：redis 存的是 RDB，拿 `.bin` 命名的话，
    // 真要拿它回滚的人分不清能不能直接喂回去。
    const preBackupExt = kind === 'mongo' ? 'archive.gz' : kind === 'redis' ? 'rdb' : 'bin';
    const preBackupPath = `${backupDir}/${backupKey(svc.projectId, svc.id)}-pre-restore-${stamp}.${preBackupExt}`;

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
        // 该往哪写，问 redis 自己（和备份共用 REDIS_RDB_PATH_LINES 那份判据）。
        // 写死 /data/dump.rdb 的话，改过 dir/dbfilename 的实例会把上传的快照写到
        // 一个 redis 根本不读的位置，重启后加载的还是**旧数据**，而接口回的是
        // 「已恢复」——恢复场景里这种谎话的代价是数据真的回不来了。
        const auth = redisAuthFromServiceDefinition(svc);
        const pathProbe = await shell.exec(
          `docker exec -i ${shq(svc.containerName)} sh -s`,
          { timeout: 30_000, stdin: redisProbeStdin(buildRedisRdbPathScript(), auth) },
        );
        const rdbTarget = (pathProbe.stdout || '').trim().split('\n').pop()?.trim() || '';
        if (pathProbe.exitCode !== 0 || !rdbTarget.startsWith('/')) {
          res.status(500).json({
            error: `解析不出 redis 快照路径，拒绝按默认路径写入：${outputTail(combinedOutput(pathProbe), 200)}`,
          });
          return;
        }

        // 开着 AOF 的实例启动读 AOF、不读 RDB：写进去也不会生效，而接口会回
        // 「已恢复」。这种情况明确拒绝，不假装成功（E35）。
        const aofProbe = await shell.exec(
          `docker exec -i ${shq(svc.containerName)} sh -s`,
          { timeout: 30_000, stdin: redisProbeStdin(buildRedisAppendOnlyScript(), auth) },
        );
        const aof = (aofProbe.stdout || '').trim().split('\n').pop()?.trim().toLowerCase() || '';
        if (aofProbe.exitCode !== 0) {
          res.status(500).json({
            error: `问不出 appendonly 配置，拒绝恢复：${outputTail(combinedOutput(aofProbe), 200)}`,
          });
          return;
        }
        if (aof === 'yes') {
          res.status(409).json({
            error: '该实例开启了 AOF（appendonly yes）。redis 启动时读 AOF 不读 RDB，'
              + '写入快照不会生效——拒绝执行以免给出「已恢复」的假象。请先关闭 AOF 或改用 AOF 文件恢复。',
          });
          return;
        }

        // 上传内容先落到宿主暂存文件：后面要在**容器停止**的状态下 docker cp 进去，
        // 而停止的容器没法 docker exec，必须先把字节拿在手上。
        const uploadPath = `${backupDir}/.upload-${backupKey(svc.projectId, svc.id)}-${stamp}.rdb`;
        try {
          const fsp = await import('node:fs');
          await new Promise<void>((resolve, reject) => {
            const w = fsp.createWriteStream(uploadPath);
            req.pipe(w);
            w.on('finish', () => resolve());
            w.on('error', reject);
            req.on('error', reject);
          });
        } catch (err) {
          res.status(500).json({ error: `接收上传失败：${(err as Error).message}` });
          return;
        }

        // 顺序是关键，见 buildRedisRestorePlan 的注释：停 → 存当前 → 覆盖 → 启动。
        const plan = buildRedisRestorePlan({
          containerName: svc.containerName,
          rdbPath: rdbTarget,
          uploadPath,
          preBackupPath,
        });
        let stopped = false;
        try {
          for (const step of plan) {
            const r = await shell.exec(step.argv.map(shq).join(' '), { timeout: 120_000 });
            if (step.id === 'stop') stopped = r.exitCode === 0;
            if (step.id === 'start') stopped = r.exitCode === 0 ? false : stopped;
            // 存当前快照失败不致命（可能这台从没落过盘），其余每一步都必须成功：
            // 覆盖失败却继续启动，用户会拿到「已恢复」而数据没变。
            if (r.exitCode !== 0 && step.id !== 'save-current') {
              throw new Error(`${step.id} 失败：${outputTail(combinedOutput(r), 200)}`);
            }
          }
        } catch (err) {
          // 停下了却没起回来，比恢复失败本身更严重——尽力拉起来再如实报错。
          if (stopped) await shell.exec(`docker start ${shq(svc.containerName)}`).catch(() => { /* 已尽力 */ });
          res.status(500).json({
            error: `恢复失败：${(err as Error).message}`,
            containerRestarted: stopped,
          });
          return;
        } finally {
          await shell.exec(`rm -f ${shq(uploadPath)}`).catch(() => { /* 暂存文件清不掉不影响结果 */ });
        }

        stateService.recordDestructiveOp({
          type: 'purge-database',
          summary: `恢复 ${svc.id} Redis 快照（恢复前状态已存：${preBackupPath}）`,
        });
        res.json({
          restored: true,
          preRestoreBackup: preBackupPath,
          message: 'Redis 已从快照恢复：容器先停止、覆盖快照文件、再启动加载',
        });
      } else if (kind === 'mysql') {
        // mysql 此前**根本没有恢复入口**——能导出却灌不回去，等于没有备份。
        // 大 dump 不能走 stdin 字符串（170MB 的库很常见），所以先落宿主暂存文件，
        // 再 docker cp 进容器、在容器内解压灌库，最后清理两边。
        const uploadPath = `${backupDir}/.upload-${backupKey(svc.projectId, svc.id)}-${stamp}.sql.gz`;
        const inContainer = `/tmp/cds-restore-${stamp}.sql.gz`;
        let uploadBytes = 0;
        // 数不出来就留 null，不要拿 0 顶替——「没数到」和「一张表都没有」是两回事。
        let tablesBefore: number | null = null;
        let tablesAfter: number | null = null;
        const countMysqlTables = async (container: string): Promise<number | null> => {
          const r = await shell.exec(`docker exec -i ${shq(container)} sh -s`,
            { timeout: 60_000, stdin: buildMysqlTableCountScript() });
          if (r.exitCode !== 0) return null;
          const n = Number((r.stdout || '').trim().split('\n').pop()?.trim());
          return Number.isFinite(n) ? n : null;
        };
        try {
          const fsp = await import('node:fs');
          await new Promise<void>((resolve, reject) => {
            const w = fsp.createWriteStream(uploadPath);
            req.pipe(w);
            w.on('finish', () => resolve());
            w.on('error', reject);
            req.on('error', reject);
          });
          // 收了多少字节要自己数一遍。前面那次假成功里，「上传」这一步是否真的搬过
          // 字节从来没人问过——文件空着照样往下走，直到最后回一句「已恢复」。
          uploadBytes = fsp.statSync(uploadPath).size;
        } catch (err) {
          res.status(500).json({ error: `接收上传失败：${(err as Error).message}` });
          return;
        }
        if (uploadBytes === 0) {
          await shell.exec(`rm -f ${shq(uploadPath)}`).catch(() => { /* 空文件清不掉不影响结果 */ });
          res.status(400).json({ error: '上传内容为空（收到 0 字节），未做任何改动。请确认请求体里带上了 .sql.gz 文件。' });
          return;
        }

        try {
          // 恢复前先存一份当前状态：mysql 分支此前连撤销快照都没有。
          const pre = await shell.exec(
            `docker exec -i ${shq(svc.containerName)} sh -s > ${shq(preBackupPath)}`,
            { timeout: 600_000, stdin: buildMysqlDumpScript() },
          );
          if (pre.exitCode !== 0) {
            // 存不下当前状态就不许往下走——没有退路的恢复不该开始。
            throw new Error(`恢复前快照失败，已中止：${outputTail(combinedOutput(pre), 200)}`);
          }
          const cp = await shell.exec(
            `docker cp ${shq(uploadPath)} ${shq(`${svc.containerName}:${inContainer}`)}`,
            { timeout: 600_000 },
          );
          if (cp.exitCode !== 0) throw new Error(`拷入容器失败：${outputTail(combinedOutput(cp), 200)}`);
          tablesBefore = await countMysqlTables(svc.containerName);
          // 灌库：口令走容器内 MYSQL_PWD，不进宿主命令行；管道两端的退出码都要检查
          // （裸管道只会给出 mysql 那一端的，见 buildMysqlRestoreScript 的注释）。
          const load = await shell.exec(
            `docker exec -i ${shq(svc.containerName)} sh -s`,
            { timeout: 1_800_000, stdin: buildMysqlRestoreScript(inContainer) },
          );
          if (load.exitCode !== 0) throw new Error(`导入失败：${outputTail(combinedOutput(load), 300)}`);
          tablesAfter = await countMysqlTables(svc.containerName);
        } catch (err) {
          res.status(500).json({ error: `恢复失败：${(err as Error).message}`, preRestoreBackup: preBackupPath });
          return;
        } finally {
          await shell.exec(`rm -f ${shq(uploadPath)}`).catch(() => { /* 暂存清不掉不影响结果 */ });
          await shell.exec(`docker exec -i ${shq(svc.containerName)} rm -f ${shq(inContainer)}`)
            .catch(() => { /* 容器内暂存清不掉不影响结果 */ });
        }

        stateService.recordDestructiveOp({
          type: 'purge-database',
          summary: `恢复 ${svc.id} MySQL 全量 dump（恢复前状态已存：${preBackupPath}）`,
        });
        res.json({
          restored: true,
          preRestoreBackup: preBackupPath,
          uploadBytes,
          tablesBefore,
          tablesAfter,
          // 「已恢复」这句话必须带着能被核对的数字，否则和上一版那句假成功长得一模一样。
          message: `MySQL 已从 dump 恢复：收到 ${uploadBytes} 字节，表数 ${tablesBefore ?? '未知'} → ${tablesAfter ?? '未知'}`
            + '（恢复前状态已另存，可回滚）',
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
