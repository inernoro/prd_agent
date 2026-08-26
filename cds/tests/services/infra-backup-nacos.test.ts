import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  backupKindOf,
  backupFileName,
  buildNacosDumpScript,
  buildNacosRestoreScript,
  buildNacosConfigCountScript,
  classifyBackupCoverage,
  planInfraBackups,
  backupCoverageGaps,
  extractBackupScopeNote,
  type BackupCandidate,
} from '../../src/services/infra-backup-schedule.js';
import { detectInfraKind, detectInfraAuth } from '../../src/services/infra-exposure-audit.js';
import { scriptedDump } from '../../src/routes/infra-backup.js';

/**
 * nacos 的备份缺口。
 *
 * ## 为什么它比 rabbitmq 更值得先修
 *
 * 查线上真实在跑的东西时发现：**两台 nacos 在跑，零备份，而且系统连「这是什么」
 * 都认不出来**——`detectInfraKind` 里根本没有 nacos 这个类型，8848 也不在端口兜底表里，
 * 于是它落进 `other`，安全面判不了它有没有认证，备份面只能说「认不出的服务」。
 * 里面存的是那两个项目的全部配置：丢了，两个项目起不来。
 *
 * ## 为什么走 HTTP 导出而不是拷数据目录
 *
 * nacos 的配置可能落在内嵌 Derby，也可能落在外部 MySQL，同一个镜像两种形态，
 * 容器外面看不出是哪种。配置导出接口对两种形态给出同一份产物。
 * 而热拷一个正在写的 Derby 目录，拿到的东西可能根本打不开——那是「导得出、灌不回」。
 *
 * ## 这个文件真跑脚本，不是读它长什么样
 *
 * 下面在 PATH 前面塞假的 curl / wget / tar / gzip，用真 `sh` 把脚本跑一遍，
 * 直接断言退出码、请求过的 URL、以及失败时到底停没停下来。
 * 真容器判据在 `infra-backup-nacos.docker.test.ts`。
 */

const NOW = new Date('2026-08-25T12:00:00.000Z');

function cand(patch: Partial<BackupCandidate> & { id: string }): BackupCandidate {
  return {
    projectId: 'proj',
    containerName: `proj-${patch.id}-1`,
    dockerImage: 'nacos/nacos-server:v2.3.2-slim',
    running: true,
    ...patch,
  };
}

describe('先认出它是什么', () => {
  it('按镜像名认得出', () => {
    expect(detectInfraKind('nacos/nacos-server:v2.3.2-slim')).toBe('nacos');
  });

  it('私有仓库镜像靠 id / 容器名兜底', () => {
    expect(detectInfraKind('registry.internal/cfg@sha256:abc', { id: 'nacos' })).toBe('nacos');
    expect(detectInfraKind('registry.internal/cfg@sha256:abc', { containerName: 'proj-nacos-1' })).toBe('nacos');
  });

  it('按端口兜底：8848 主端口与 9848 gRPC 端口', () => {
    expect(detectInfraKind('unknown:1', { containerPort: 8848 })).toBe('nacos');
    expect(detectInfraKind('unknown:1', { runtimePorts: '0.0.0.0:9848->9848/tcp' })).toBe('nacos');
  });

  it('判据不是恒真：别的东西不许被当成 nacos', () => {
    expect(detectInfraKind('redis:7-alpine')).toBe('redis');
    expect(detectInfraKind('unknown:1', { containerPort: 12345 })).toBe('other');
  });
});

describe('nacos 有没有认证', () => {
  it('默认不开鉴权 = 无认证，任何人打到 8848 就能读写全部配置', () => {
    expect(detectInfraAuth('nacos', {})).toBe(false);
    // 线上那两台就是这个形状：env 一个都没有。
    expect(detectInfraAuth('nacos', null)).toBe(false);
  });

  it('口令配了但开关没开，等于没配', () => {
    // 判的是「开关真的打开了」，不是「env 里有没有口令」——
    // 这正是形状 6：读到一个真实存在的值，但它不是生效的那个。
    expect(detectInfraAuth('nacos', {
      NACOS_AUTH_TOKEN: 'x'.repeat(40),
      NACOS_AUTH_IDENTITY_KEY: 'k',
      NACOS_AUTH_IDENTITY_VALUE: 'v',
    })).toBe(false);
  });

  it('开关开了但少一样，也不算配好', () => {
    const full = {
      NACOS_AUTH_ENABLE: 'true',
      NACOS_AUTH_TOKEN: 'x'.repeat(40),
      NACOS_AUTH_IDENTITY_KEY: 'k',
      NACOS_AUTH_IDENTITY_VALUE: 'v',
    };
    expect(detectInfraAuth('nacos', full)).toBe(true);
    for (const missing of ['NACOS_AUTH_TOKEN', 'NACOS_AUTH_IDENTITY_KEY', 'NACOS_AUTH_IDENTITY_VALUE']) {
      const partial = { ...full, [missing]: '' };
      expect(detectInfraAuth('nacos', partial), `缺 ${missing} 时不该判成已认证`).toBe(false);
    }
  });
});

describe('进入备份范围', () => {
  it('不再是「认不出的服务」，而是已覆盖', () => {
    expect(backupKindOf('nacos/nacos-server:v2.3.2-slim')).toBe('nacos');
    expect(classifyBackupCoverage('nacos').bucket).toBe('covered');
  });

  it('进得了备份计划，且不算覆盖缺口', () => {
    const plan = planInfraBackups([cand({ id: 'nacos' })], { now: NOW });
    expect(plan.targets.map((t) => t.kind)).toEqual(['nacos']);
    expect(backupCoverageGaps(plan)).toEqual([]);
  });

  it('扩展名带 .gz，好让上游的完整性校验自动生效', () => {
    // 上游只对 `.gz` 结尾的产物跑 gzip -t。叫 .tar 的话这份备份就没有任何完整性判据，
    // 「非空」会被当成「完整」。
    const name = backupFileName('proj', 'nacos', 'nacos', NOW.toISOString());
    expect(name.endsWith('.tar.gz')).toBe(true);
  });

  it('下载与恢复走的是同一段脚本', () => {
    expect(scriptedDump('nacos')?.dump()).toBe(buildNacosDumpScript());
    expect(scriptedDump('nacos')?.restore('/tmp/x.tar.gz')).toBe(buildNacosRestoreScript('/tmp/x.tar.gz'));
    expect(scriptedDump('nacos')?.ext).toBe('tar.gz');
    // 恢复前后数的是配置条数，不是表。
    expect(scriptedDump('nacos')?.unit).toBe('配置');
  });
});

/**
 * 真跑一遍脚本。
 *
 * 假 curl 按 URL 分派：登录、探活、列命名空间、导出、导入、数条数各走一支。
 * 这样能验的是控制流与失败模式——一个都没有 HTTP 客户端时停不停、
 * 鉴权开了没口令时停不停、某个命名空间导失败时是不是整轮作废。
 */
describe('nacos 脚本：真跑一遍', () => {
  interface Stubs {
    /** 容器里有哪些 HTTP 客户端。 */
    clients?: Array<'curl' | 'wget'>;
    /** 探活的退出码。 */
    probeExit?: number;
    /** `/v1/console/namespaces` 返回的 JSON。 */
    namespacesJson?: string;
    /** 命名空间接口的退出码（非零 = 接口挂了）。 */
    namespacesExit?: number;
    /** 导出某个命名空间时的退出码。 */
    exportExit?: number;
    /** 登录返回的 JSON。 */
    loginJson?: string;
    /** 导入接口返回的 body。 */
    importBody?: string;
    /** 导入接口的退出码。 */
    importExit?: number;
    /** 数条数接口返回的 JSON。 */
    countJson?: string;
    /** gzip -t 的退出码（恢复路径用）。 */
    gzipTestExit?: number;
    /** tar -xzf 的退出码（恢复路径用）。 */
    untarExit?: number;
    /** 解包后放几个 zip 进临时目录。 */
    restoreZips?: string[];
    env?: Record<string, string>;
  }

  function run(script: string, s: Stubs = {}): {
    code: number; stdout: string; stderr: string; urls: string[]; posts: string;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-nacos-'));
    try {
      const clients = s.clients ?? ['curl'];
      // 假 curl：按 URL 分派。每次调用把 URL 追加到 urls 文件，供断言核对。
      const curlBody = [
        '#!/bin/sh',
        'url=""',
        'out=""',
        'form=""',
        'prev=""',
        'for a in "$@"; do',
        '  case "$a" in',
        `    http*) url="$a" ;;`,
        '  esac',
        '  [ "$prev" = "-o" ] && out="$a"',
        '  [ "$prev" = "-F" ] && form="$a"',
        '  prev="$a"',
        'done',
        `printf '%s\\n' "$url" >> ${dir}/urls`,
        // 登录：body 走 stdin，顺手记下来证明口令没进 argv。
        'case "$url" in',
        '  *auth/login*)',
        `    cat >> ${dir}/posts`,
        `    printf '%s' '${s.loginJson ?? '{"accessToken":"tok-123","tokenTtl":18000}'}'`,
        '    exit 0 ;;',
        '  *health/readiness*)',
        `    echo OK; exit ${s.probeExit ?? 0} ;;`,
        '  *console/namespaces*)',
        `    printf '%s' '${s.namespacesJson ?? '{"data":[{"namespace":"","namespaceShowName":"public"}]}'}'`,
        `    exit ${s.namespacesExit ?? 0} ;;`,
        '  *export=true*)',
        `    [ -n "$out" ] && printf 'PK-fake-zip' > "$out"`,
        `    exit ${s.exportExit ?? 0} ;;`,
        '  *import=true*)',
        `    printf '%s\\n' "$form" >> ${dir}/forms`,
        `    printf '%s' '${s.importBody ?? '{"code":200,"message":"","data":{"succCount":3}}'}'`,
        `    exit ${s.importExit ?? 0} ;;`,
        '  *search=accurate*)',
        `    printf '%s' '${s.countJson ?? '{"totalCount":11,"pageItems":[]}'}'`,
        '    exit 0 ;;',
        'esac',
        'exit 0',
      ].join('\n');
      for (const c of clients) fs.writeFileSync(path.join(dir, c), curlBody, { mode: 0o755 });

      if (s.gzipTestExit !== undefined || s.untarExit !== undefined || s.restoreZips) {
        fs.writeFileSync(path.join(dir, 'gzip'), [
          '#!/bin/sh',
          `[ "$1" = "-t" ] && exit ${s.gzipTestExit ?? 0}`,
          'cat > /dev/null',
          'exit 0',
        ].join('\n'), { mode: 0o755 });
        // 假 tar：解包时按 restoreZips 往目标目录塞文件，打包时吐一点字节。
        fs.writeFileSync(path.join(dir, 'tar'), [
          '#!/bin/sh',
          'mode=""; target=""; prev=""',
          'for a in "$@"; do',
          '  case "$a" in -xzf|-xf) mode=x ;; -cf) mode=c ;; esac',
          '  [ "$prev" = "-C" ] && target="$a"',
          '  prev="$a"',
          'done',
          'if [ "$mode" = x ]; then',
          `  [ ${s.untarExit ?? 0} = 0 ] || exit ${s.untarExit ?? 0}`,
          ...(s.restoreZips ?? []).map((z) => `  printf 'PK' > "$target/${z}"`),
          '  exit 0',
          'fi',
          `printf 'TAR-BYTES'`,
          'exit 0',
        ].join('\n'), { mode: 0o755 });
      }

      // PATH **只有** stub 目录：需要的系统工具逐个软链进来。
      //
      // 不能简单地把 /usr/bin 挂在后面——那样「容器里只有 wget」这种用例根本立不住，
      // 脚本会找到宿主上真正的 curl，于是断言「拒绝用 wget 登录」的两条永远不红。
      // 这里模拟的正是「这个镜像里就这些工具」，所以白名单是必须的。
      for (const tool of ['sed', 'tr', 'mktemp', 'basename', 'cat', 'rm', 'printf', 'tar', 'gzip', 'gunzip']) {
        if (fs.existsSync(path.join(dir, tool))) continue;   // 已有自己的假实现
        let real = '';
        try {
          real = execFileSync('sh', ['-c', `command -v ${tool} || true`], { encoding: 'utf8' }).trim();
        } catch { real = ''; }
        if (real) fs.symlinkSync(real, path.join(dir, tool));
      }
      const envPairs = Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      const wrapper = [
        `export PATH=${JSON.stringify(dir)}`,
        ...envPairs.map((p) => `export ${p}`),
        script,
      ].join('\n');

      let code = 0;
      let stdout = '';
      let stderr = '';
      const outFile = path.join(dir, 'out.bin');
      const errFile = path.join(dir, 'err.txt');
      try {
        execFileSync('sh', ['-c', `sh -s > ${JSON.stringify(outFile)} 2> ${JSON.stringify(errFile)}`], {
          input: wrapper,
          timeout: 60_000,
        });
      } catch (err) {
        code = Number((err as { status?: number }).status ?? -1);
      }
      const read = (p: string): string => {
        try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
      };
      stdout = read(outFile);
      stderr = read(errFile);
      return {
        code,
        stdout,
        stderr,
        urls: read(path.join(dir, 'urls')).split('\n').filter(Boolean),
        posts: read(path.join(dir, 'posts')),
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  describe('导出', () => {
    it('一个 HTTP 客户端都没有：退 78 并说清原因，不产出空备份', () => {
      const r = run(buildNacosDumpScript(), { clients: [] });
      expect(r.code).toBe(78);
      expect(r.stderr).toContain('既没有 curl 也没有 wget');
      expect(r.stdout).toBe('');
    });

    it('连不上 nacos：退 78，不往下走', () => {
      const r = run(buildNacosDumpScript(), { probeExit: 7 });
      expect(r.code).toBe(78);
      expect(r.stderr).toContain('连不上 nacos');
      // 探活失败之后不该再去导任何东西。
      expect(r.urls.some((u) => u.includes('export=true'))).toBe(false);
    });

    it('逐个命名空间导，public 也在里面', () => {
      const r = run(buildNacosDumpScript(), {
        namespacesJson: '{"data":[{"namespace":""},{"namespace":"dev-ns"},{"namespace":"prod-ns"}]}',
        restoreZips: [],
      });
      expect(r.code, r.stderr).toBe(0);
      const exports = r.urls.filter((u) => u.includes('export=true'));
      // public + 两个自定义 = 三次导出。少一次就是一份看起来成功的空壳。
      expect(exports).toHaveLength(3);
      expect(exports.some((u) => /tenant=(&|$)/.test(u)), 'public 命名空间没导').toBe(true);
      expect(exports.some((u) => u.includes('tenant=dev-ns'))).toBe(true);
      expect(exports.some((u) => u.includes('tenant=prod-ns'))).toBe(true);
    });

    it('命名空间接口失败：整轮作废，绝不只导 public 冒充全量', () => {
      // Codex review P1。原来是 `cds_nacos_get ... | tr | sed` 一条管道，
      // shell 看到的退出码是**最后一环 sed 的**，而 sed 对着空输入照样退 0。
      // 于是接口一挂，命名空间列表静默变空，只导 public 一个还报
      // 「成功，1 个命名空间」——一份看起来成功的空壳。
      const r = run(buildNacosDumpScript(), { namespacesExit: 22 });
      expect(r.code).toBe(78);
      expect(r.stderr).toContain('列不出 nacos 命名空间');
      // 关键：一个命名空间都不许导。
      expect(r.urls.some((u) => u.includes('export=true'))).toBe(false);
    });

    it('接口回 200 但内容不是清单：同样作废，不当成空清单', () => {
      // 「解析出零个命名空间」和「真的只有 public」长得一模一样，
      // 这是同一个坑的另一半：只看退出码挡不住返回登录页 / 错误 JSON 的情况。
      const r = run(buildNacosDumpScript(), { namespacesJson: '{"code":403,"message":"forbidden"}' });
      expect(r.code).toBe(78);
      expect(r.stderr).toContain('认不出这是清单');
      expect(r.urls.some((u) => u.includes('export=true'))).toBe(false);
    });

    it('某个命名空间导失败：整轮作废，不留半份', () => {
      const r = run(buildNacosDumpScript(), {
        namespacesJson: '{"data":[{"namespace":""},{"namespace":"dev-ns"}]}',
        exportExit: 22,
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('整轮作废');
    });

    it('无条件报出「没带走什么」，并带上命名空间个数', () => {
      const r = run(buildNacosDumpScript(), {
        namespacesJson: '{"data":[{"namespace":""},{"namespace":"dev-ns"}]}',
        restoreZips: [],
      });
      const note = extractBackupScopeNote(r.stderr);
      expect(note).toContain('2 个命名空间');
      expect(note).toContain('不含服务注册列表');
    });

    it('注记走 stderr，不污染产物', () => {
      const r = run(buildNacosDumpScript(), { restoreZips: [] });
      expect(r.stdout).not.toContain('cds-backup-scope:');
    });
  });

  describe('上下文路径', () => {
    it('运维按 servlet 习惯写成 /nacos 也要拼对，不能出现双斜杠', () => {
      // 直接插值会拼出 `http://host:8848//nacos`，之后探活、列命名空间、导出、
      // 导入**全部打错路径**——而默认路径的容器用例照样绿，这种漏法只有
      // 配了上下文路径的实例才会撞上（Codex review P2）。
      const r = run(buildNacosDumpScript(), { env: { NACOS_CONTEXT_PATH: '/nacos' }, restoreZips: [] });
      expect(r.code, r.stderr).toBe(0);
      for (const u of r.urls) expect(u).not.toContain('8848//');
      expect(r.urls.some((u) => u.includes('8848/nacos/v1/'))).toBe(true);
    });

    it('写成 nacos/ 或 /nacos/ 结果一样', () => {
      for (const ctx of ['nacos/', '/nacos/']) {
        const r = run(buildNacosDumpScript(), { env: { NACOS_CONTEXT_PATH: ctx }, restoreZips: [] });
        expect(r.code, `${ctx}: ${r.stderr}`).toBe(0);
        expect(r.urls.some((u) => u.includes('8848/nacos/v1/')), ctx).toBe(true);
      }
    });

    it('根路径 `/`：拼出来不带多余段，也不带双斜杠', () => {
      // 2.4 起默认上下文就是根。写成 `/` 时不该变成 `8848//v1/...`。
      const r = run(buildNacosDumpScript(), { env: { NACOS_CONTEXT_PATH: '/' }, restoreZips: [] });
      expect(r.code, r.stderr).toBe(0);
      for (const u of r.urls) expect(u).not.toContain('8848//');
      expect(r.urls.some((u) => u.includes('8848/v1/'))).toBe(true);
    });
  });

  describe('鉴权开着的时候', () => {
    const AUTH_ON = { NACOS_AUTH_ENABLE: 'true', NACOS_AUTH_PASSWORD: 'sup3r-secret' };

    it('口令走 stdin，不进容器的进程列表', () => {
      // nats 那次的教训：`sh -c` 只挡住宿主那一侧，展开后的明文照样是进程 argv。
      const r = run(buildNacosDumpScript(), { env: AUTH_ON, restoreZips: [] });
      expect(r.code, r.stderr).toBe(0);
      expect(r.posts).toContain('password=sup3r-secret');
      // 断言口令没有出现在任何一条 URL 里（假 curl 记的就是 argv 里的那个 URL）。
      for (const u of r.urls) expect(u).not.toContain('sup3r-secret');
    });

    it('拿到的 token 会带进后续每一次请求', () => {
      const r = run(buildNacosDumpScript(), { env: AUTH_ON, restoreZips: [] });
      const exports = r.urls.filter((u) => u.includes('export=true'));
      expect(exports.length).toBeGreaterThan(0);
      for (const u of exports) expect(u).toContain('accessToken=tok-123');
    });

    it('开了鉴权却没口令：退 78，不假装能导', () => {
      const r = run(buildNacosDumpScript(), { env: { NACOS_AUTH_ENABLE: 'true' } });
      expect(r.code).toBe(78);
      expect(r.stderr).toContain('没有口令');
    });

    it('登录没拿到 token：退 78', () => {
      const r = run(buildNacosDumpScript(), { env: AUTH_ON, loginJson: '{"message":"unknown user"}' });
      expect(r.code).toBe(78);
      expect(r.stderr).toContain('accessToken');
    });

    it('只有 wget 时拒绝登录，而不是把口令摆进命令行', () => {
      const r = run(buildNacosDumpScript(), { clients: ['wget'], env: AUTH_ON });
      expect(r.code).toBe(78);
      expect(r.stderr).toContain('拒绝这么做');
    });

    it('对照组：鉴权没开时不登录、也不带 token', () => {
      // 没有这一条，上面几条即使在「永远走登录分支」时也会绿。
      const r = run(buildNacosDumpScript(), { restoreZips: [] });
      expect(r.urls.some((u) => u.includes('auth/login'))).toBe(false);
      expect(r.urls.some((u) => u.includes('accessToken'))).toBe(false);
    });
  });

  describe('恢复', () => {
    const P = '/tmp/cds-restore.tar.gz';

    it('先验 gz 完整性再动配置', () => {
      const r = run(buildNacosRestoreScript(P), { gzipTestExit: 1 });
      expect(r.code).toBe(65);
      expect(r.urls.some((u) => u.includes('import=true'))).toBe(false);
    });

    it('包解不开：退 65，什么都不导', () => {
      const r = run(buildNacosRestoreScript(P), { gzipTestExit: 0, untarExit: 2 });
      expect(r.code).toBe(65);
      expect(r.urls.some((u) => u.includes('import=true'))).toBe(false);
    });

    it('逐个命名空间灌回去，public 映射回空 tenant', () => {
      const r = run(buildNacosRestoreScript(P), {
        gzipTestExit: 0,
        restoreZips: ['__public__.zip', 'dev-ns.zip'],
      });
      expect(r.code, r.stderr).toBe(0);
      const imports = r.urls.filter((u) => u.includes('import=true'));
      expect(imports).toHaveLength(2);
      expect(imports.some((u) => /namespace=(&|$)/.test(u))).toBe(true);
      expect(imports.some((u) => u.includes('namespace=dev-ns'))).toBe(true);
      // 策略必须是覆盖，否则同名配置会被跳过，恢复等于没做。
      for (const u of imports) expect(u).toContain('policy=OVERWRITE');
    });

    it('包里一个命名空间都没有：报失败，不说「已恢复」', () => {
      const r = run(buildNacosRestoreScript(P), { gzipTestExit: 0, restoreZips: [] });
      expect(r.code).toBe(65);
      expect(r.stderr).toContain('什么都没导入');
    });

    it('nacos 回 200 但 body 里说失败：必须判失败', () => {
      // 这是 psql 那条（默认遇错继续照样 exit 0）的同一形状：
      // 退出码说成功，真相在 body 里。只看退出码就会把失败读成「已恢复」。
      const r = run(buildNacosRestoreScript(P), {
        gzipTestExit: 0,
        restoreZips: ['__public__.zip'],
        importBody: '{"code":500,"message":"namespace not exist"}',
      });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('被 nacos 拒绝');
    });

    it('只有 wget：明说做不到，不静默跳过', () => {
      const r = run(buildNacosRestoreScript(P), { clients: ['wget'], gzipTestExit: 0 });
      expect(r.code).toBe(78);
      expect(r.stderr).toContain('multipart');
    });

    it('路径里的单引号不会把脚本撑破', () => {
      expect(buildNacosRestoreScript("/tmp/it's.tar.gz")).toContain(`'/tmp/it'"'"'s.tar.gz'`);
    });
  });

  describe('取证：数配置条数', () => {
    it('跨命名空间求和，覆盖面与备份一致', () => {
      const r = run(buildNacosConfigCountScript(), {
        namespacesJson: '{"data":[{"namespace":""},{"namespace":"dev-ns"}]}',
        countJson: '{"totalCount":11,"pageItems":[]}',
      });
      expect(r.code, r.stderr).toBe(0);
      // public + dev-ns，各 11 条。只数 public 的话这里会是 11。
      expect(r.stdout.trim().split('\n').pop()).toBe('22');
    });

    it('一条配置都没有不算失败', () => {
      const r = run(buildNacosConfigCountScript(), { countJson: '{"totalCount":0,"pageItems":[]}' });
      expect(r.code).toBe(0);
      expect(r.stdout.trim().split('\n').pop()).toBe('0');
    });
  });
});
