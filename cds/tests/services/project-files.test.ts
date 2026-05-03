/**
 * ProjectFilesService 单元测试 — 收尾 F12/F11 共享 helper。
 *
 * 覆盖:
 *   - writeFiles 路径校验(.. / 绝对路径 / 反斜杠 / 非法字符 / 路径段空)
 *   - 大小限制(单文件 / 单次总量)
 *   - 文件数限制(50)
 *   - 同次请求重复路径拒绝
 *   - worktree 不存在时报 409 target_missing
 *   - writeFilesAtPath requireExist=false 自动 mkdir
 *   - 嵌套子目录(通过)+ 父目录自动 mkdir
 *   - 已存在的文件被覆盖
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ProjectFilesService,
  ProjectFileError,
  MAX_FILE_BYTES,
  MAX_FILES_PER_REQUEST,
} from '../../src/services/project-files.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import type { Project, CdsConfig } from '../../src/types.js';

const NOW = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'proj-test';

function makeConfig(tmpDir: string): CdsConfig {
  return {
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    reposBase: path.join(tmpDir, 'repos'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'test', issuer: 'cds' },
  };
}

function seedProject(stateService: StateService): Project {
  const project: Project = {
    id: PROJECT_ID,
    slug: 'proj-test',
    name: 'Proj Test',
    kind: 'git',
    legacyFlag: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
  stateService.addProject(project);
  return project;
}

describe('ProjectFilesService', () => {
  let tmpDir: string;
  let stateService: StateService;
  let config: CdsConfig;
  let svc: ProjectFilesService;
  let worktreeDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-pf-test-'));
    config = makeConfig(tmpDir);
    fs.mkdirSync(config.worktreeBase, { recursive: true });
    fs.mkdirSync(config.reposBase!, { recursive: true });
    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();
    seedProject(stateService);
    svc = new ProjectFilesService(stateService, config);
    worktreeDir = WorktreeService.worktreePathFor(config.worktreeBase, PROJECT_ID, 'main');
    fs.mkdirSync(worktreeDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeFiles 校验', () => {
    it('拒绝空 files 数组', async () => {
      await expect(svc.writeFiles(PROJECT_ID, 'main', [])).rejects.toMatchObject({
        status: 400,
        code: 'no_files',
      });
    });

    it('拒绝不存在的项目', async () => {
      await expect(
        svc.writeFiles('not-exist', 'main', [{ relativePath: 'a.txt', content: 'x' }]),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('拒绝空 branch', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, '', [{ relativePath: 'a.txt', content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'branch_required' });
    });

    it('拒绝绝对路径', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [{ relativePath: '/etc/passwd', content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'bad_path' });
    });

    it('拒绝 .. 路径回溯', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [{ relativePath: '../escape.txt', content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'bad_path' });
    });

    it('拒绝中间含 .. 的路径', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [{ relativePath: 'a/../../etc.txt', content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'bad_path' });
    });

    it('拒绝反斜杠(Windows-style)', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [{ relativePath: 'a\\b.txt', content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'bad_path' });
    });

    it('拒绝路径段含空格', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [{ relativePath: 'my file.sql', content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'bad_path' });
    });

    it('拒绝路径段含通配符 *', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [{ relativePath: 'a*.txt', content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'bad_path' });
    });

    it('拒绝深度超过 10 的路径', async () => {
      const deep = Array(11).fill('a').join('/') + '.txt';
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [{ relativePath: deep, content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'bad_path' });
    });

    it('拒绝单文件超过 256KB', async () => {
      const big = 'x'.repeat(MAX_FILE_BYTES + 1);
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [{ relativePath: 'big.txt', content: big }]),
      ).rejects.toMatchObject({ status: 413, code: 'file_too_large' });
    });

    it('拒绝单次总量超过 1MB', async () => {
      const sub = 'x'.repeat(MAX_FILE_BYTES);
      const files = Array.from({ length: 5 }, (_, i) => ({
        relativePath: `a${i}.txt`,
        content: sub,
      }));
      await expect(svc.writeFiles(PROJECT_ID, 'main', files)).rejects.toMatchObject({
        status: 413,
        code: 'request_too_large',
      });
    });

    it('拒绝单次超过 50 个文件', async () => {
      const files = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) => ({
        relativePath: `a${i}.txt`,
        content: 'x',
      }));
      await expect(svc.writeFiles(PROJECT_ID, 'main', files)).rejects.toMatchObject({
        status: 400,
        code: 'too_many_files',
      });
    });

    it('拒绝同次请求重复路径', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, 'main', [
          { relativePath: 'a.txt', content: '1' },
          { relativePath: 'a.txt', content: '2' },
        ]),
      ).rejects.toMatchObject({ status: 409, code: 'duplicate_path' });
    });

    it('worktree 不存在时报 409 target_missing', async () => {
      await expect(
        svc.writeFiles(PROJECT_ID, 'no-such-branch', [
          { relativePath: 'a.txt', content: 'x' },
        ]),
      ).rejects.toMatchObject({ status: 409, code: 'target_missing' });
    });
  });

  describe('writeFiles 写入', () => {
    it('能正常写一个根目录文件', async () => {
      const result = await svc.writeFiles(PROJECT_ID, 'main', [
        { relativePath: 'init.sql', content: 'CREATE TABLE users(id INT);' },
      ]);
      expect(result.written).toHaveLength(1);
      expect(result.written[0].relativePath).toBe('init.sql');
      expect(result.written[0].bytes).toBeGreaterThan(0);
      const written = fs.readFileSync(path.join(worktreeDir, 'init.sql'), 'utf-8');
      expect(written).toBe('CREATE TABLE users(id INT);');
    });

    it('能写嵌套子目录(自动 mkdir)', async () => {
      const result = await svc.writeFiles(PROJECT_ID, 'main', [
        { relativePath: 'db/migrations/001.sql', content: 'ALTER TABLE x;' },
      ]);
      expect(result.written).toHaveLength(1);
      const target = path.join(worktreeDir, 'db', 'migrations', '001.sql');
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, 'utf-8')).toBe('ALTER TABLE x;');
    });

    it('已存在文件直接覆盖', async () => {
      fs.writeFileSync(path.join(worktreeDir, 'old.txt'), '旧内容');
      const result = await svc.writeFiles(PROJECT_ID, 'main', [
        { relativePath: 'old.txt', content: '新内容' },
      ]);
      expect(result.written).toHaveLength(1);
      expect(fs.readFileSync(path.join(worktreeDir, 'old.txt'), 'utf-8')).toBe('新内容');
    });

    it('能写多个文件', async () => {
      const result = await svc.writeFiles(PROJECT_ID, 'main', [
        { relativePath: 'a.txt', content: 'A' },
        { relativePath: 'b/c.txt', content: 'BC' },
      ]);
      expect(result.written).toHaveLength(2);
      expect(fs.readFileSync(path.join(worktreeDir, 'a.txt'), 'utf-8')).toBe('A');
      expect(fs.readFileSync(path.join(worktreeDir, 'b/c.txt'), 'utf-8')).toBe('BC');
    });

    it('返回 worktreePath 是绝对路径', async () => {
      const result = await svc.writeFiles(PROJECT_ID, 'main', [
        { relativePath: 'a.txt', content: 'x' },
      ]);
      expect(path.isAbsolute(result.worktreePath)).toBe(true);
      expect(result.worktreePath).toBe(worktreeDir);
    });

    it('totalBytes 累加正确', async () => {
      const result = await svc.writeFiles(PROJECT_ID, 'main', [
        { relativePath: 'a.txt', content: 'aaa' }, // 3
        { relativePath: 'b.txt', content: 'bb' }, // 2
      ]);
      expect(result.totalBytes).toBe(5);
    });

    it('utf-8 中文正确处理 byte length', async () => {
      const result = await svc.writeFiles(PROJECT_ID, 'main', [
        { relativePath: 'cn.txt', content: '中文' }, // 6 bytes utf-8
      ]);
      expect(result.totalBytes).toBe(6);
      expect(fs.readFileSync(path.join(worktreeDir, 'cn.txt'), 'utf-8')).toBe('中文');
    });
  });

  describe('writeFilesAtPath (F11 沙盒用)', () => {
    it('requireExist=false 自动 mkdir', async () => {
      const newDir = path.join(tmpDir, 'fresh-target');
      expect(fs.existsSync(newDir)).toBe(false);
      const result = await svc.writeFilesAtPath(
        newDir,
        [{ relativePath: 'cds-compose.yml', content: 'services: {}' }],
        { requireExist: false },
      );
      expect(fs.existsSync(newDir)).toBe(true);
      expect(result.written).toHaveLength(1);
    });

    it('requireExist=true 不存在时报 409 target_missing', async () => {
      const newDir = path.join(tmpDir, 'fresh-target-2');
      await expect(
        svc.writeFilesAtPath(newDir, [{ relativePath: 'a.txt', content: 'x' }], {
          requireExist: true,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'target_missing' });
    });

    it('校验同 writeFiles', async () => {
      await expect(
        svc.writeFilesAtPath(worktreeDir, [{ relativePath: '../escape.txt', content: 'x' }]),
      ).rejects.toMatchObject({ status: 400, code: 'bad_path' });
    });
  });

  describe('ProjectFileError 行为', () => {
    it('保留 status / code / field', () => {
      const err = new ProjectFileError(400, 'bad_path', 'msg', 'relativePath');
      expect(err.status).toBe(400);
      expect(err.code).toBe('bad_path');
      expect(err.field).toBe('relativePath');
      expect(err.name).toBe('ProjectFileError');
      expect(err.message).toBe('msg');
    });
  });

  describe('validatePayload (Bugbot fix 2026-05-04 — 纯静态校验)', () => {
    it('合法 payload 返回 ResolvedFile[]', () => {
      const resolved = svc.validatePayload(worktreeDir, [
        { relativePath: 'a.txt', content: 'aaa' },
        { relativePath: 'b/c.txt', content: 'bc' },
      ]);
      expect(resolved).toHaveLength(2);
      expect(resolved[0].bytes).toBe(3);
      expect(resolved[0].absolutePath).toBe(path.resolve(worktreeDir, 'a.txt'));
    });

    it('校验阶段不碰文件系统(用不存在的 targetPath 也能通过)', () => {
      const fakeTarget = path.join(tmpDir, 'never-mkdir-this');
      expect(fs.existsSync(fakeTarget)).toBe(false);
      const resolved = svc.validatePayload(fakeTarget, [
        { relativePath: 'init.sql', content: 'CREATE TABLE x(id INT);' },
      ]);
      expect(resolved).toHaveLength(1);
      // 关键:校验通过后,目标目录依然不存在(纯静态,零 IO)
      expect(fs.existsSync(fakeTarget)).toBe(false);
    });

    it('非法路径在 validatePayload 阶段就抛(不依赖目录存在)', () => {
      const fakeTarget = path.join(tmpDir, 'fake');
      expect(() =>
        svc.validatePayload(fakeTarget, [{ relativePath: '../escape', content: 'x' }]),
      ).toThrow(ProjectFileError);
      expect(fs.existsSync(fakeTarget)).toBe(false);
    });

    it('超大文件在 validatePayload 阶段就抛', () => {
      const fakeTarget = path.join(tmpDir, 'fake');
      const big = 'x'.repeat(MAX_FILE_BYTES + 1);
      expect(() =>
        svc.validatePayload(fakeTarget, [{ relativePath: 'big.sql', content: big }]),
      ).toThrow(ProjectFileError);
      expect(fs.existsSync(fakeTarget)).toBe(false);
    });

    it('writeFilesAtPath 调用 validatePayload 内部一致 — 行为不变', async () => {
      // 回归:重构后 writeFilesAtPath 仍能写文件
      const fresh = path.join(tmpDir, 'fresh-via-write');
      const result = await svc.writeFilesAtPath(
        fresh,
        [{ relativePath: 'ok.txt', content: 'ok' }],
        { requireExist: false },
      );
      expect(result.totalBytes).toBe(2);
      expect(fs.readFileSync(path.join(fresh, 'ok.txt'), 'utf-8')).toBe('ok');
    });
  });
});
