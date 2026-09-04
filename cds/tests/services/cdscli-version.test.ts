import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearBundledCdsCliVersionCache, readBundledCdsCliVersion } from '../../src/services/cdscli-version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

function readSkillFrontmatterVersion(): string | null {
  const skillMd = fs.readFileSync(path.join(repoRoot, '.claude', 'skills', 'cds', 'SKILL.md'), 'utf-8');
  const frontmatter = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) return null;
  const metadata = frontmatter[1].match(/^metadata:\s*\n((?:[ \t]+.*(?:\n|$))*)/m);
  const version = metadata?.[1].match(/^\s+version:\s*(.+?)\s*$/m);
  return version ? version[1].trim().replace(/^["']|["']$/g, '') : null;
}

describe('cdscli bundled version', () => {
  it('reads cdscli.py VERSION from the repository skill bundle', () => {
    clearBundledCdsCliVersionCache();

    expect(readBundledCdsCliVersion(repoRoot)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps cds SKILL.md version aligned with cdscli.py VERSION', () => {
    clearBundledCdsCliVersionCache();

    expect(readSkillFrontmatterVersion()).toBe(readBundledCdsCliVersion(repoRoot));
  });
});

/**
 * 长期密钥不许经过 argv（Codex P1）。
 *
 * `identity save` 收的是一把 90 天滑动、能为主体名下所有授权换项目凭据的用户级
 * 凭证。走命令行参数意味着：命令运行期间同机任何进程 `ps` 就能看见，之后还长期
 * 留在 shell 历史里。UI 那一屏只出现一次，教的必须是安全那条路。
 */
describe('cdscli identity save：明文不走命令行参数', () => {
  const cliSource = fs.readFileSync(
    path.join(repoRoot, '.claude', 'skills', 'cds', 'cli', 'cdscli.py'),
    'utf-8',
  );

  it('--credential 不再是必填（默认走 stdin / 隐藏输入）', () => {
    const arg = cliSource.match(/isave\.add_argument\("--credential"[^\n]*\)/);
    expect(arg).toBeTruthy();
    expect(arg![0]).not.toContain('required=True');
  });

  it('有一条不经过 argv 的读取路径（管道或隐藏输入）', () => {
    expect(cliSource).toContain('_read_secret_stdin_or_prompt');
    expect(cliSource).toContain('getpass');
    expect(cliSource).toContain('sys.stdin.isatty()');
  });

  it('仍然传 --credential 时要出声警告，不许静默接受', () => {
    const body = cliSource.slice(cliSource.indexOf('def cmd_identity_save'));
    expect(body.slice(0, 1200)).toContain('[warn]');
  });

  it('文案里不再教人把明文写进命令行参数', () => {
    expect(cliSource).not.toContain('identity save --credential cdsu_');
  });

  it('签发页面教的是同一条安全路径（两处不许漂）', () => {
    const tab = fs.readFileSync(
      path.join(repoRoot, 'cds', 'web', 'src', 'pages', 'cds-settings', 'tabs', 'IdentityTab.tsx'),
      'utf-8',
    );
    // 明文只出现这一次，这一屏必须说清它该落到哪儿，否则自愈会报「本机没有凭证」
    expect(tab).toContain('cdscli identity save');
    expect(tab).not.toContain('identity save --credential');
    // 新机器 / 新 clone 上没有仓库里那份凭据文件，CDS_HOST 也往往没设 ——
    // 命令不带主机会在收凭证之前就先失败，而这一屏只出现一次（Codex 第四轮）。
    expect(tab).toContain('--host');
    // 主机取自当前页面地址，不写死某个域名
    expect(tab).toContain('window.location.host');
  });
});

/**
 * 新机器上那条一次性命令跑完之后，下一条命令还得能用（Codex 第六轮 P2）。
 *
 * `identity save --host ...` 之前只把 host 当索引键，不落成默认值；而
 * whoami / heal 只读 CDS_HOST。于是签发页给的命令**成功了**，紧接着的
 * `identity heal` 还是「CDS_HOST 未设置」——一条只出现一次的指引，照做之后
 * 依然走不通。
 */
describe('cdscli identity：save 之后不必再设 CDS_HOST', () => {
  const cliSource = fs.readFileSync(
    path.join(repoRoot, '.claude', 'skills', 'cds', 'cli', 'cdscli.py'),
    'utf-8',
  );

  it('save 会把主机记成默认值', () => {
    expect(cliSource).toContain('data["defaultHost"]');
  });

  it('取主机时会回退到那个默认值（不是只读环境变量）', () => {
    expect(cliSource).toContain('_default_user_credential_host');
    const base = cliSource.slice(cliSource.indexOf('def _cds_base'), cliSource.indexOf('def _cds_base') + 900);
    expect(base).toContain('_default_user_credential_host');
  });

  it('只存了一把凭证时，没给主机也认得出来', () => {
    const loader = cliSource.slice(
      cliSource.indexOf('def _load_user_credential'),
      cliSource.indexOf('def _default_user_credential_host'),
    );
    expect(loader).toContain('len(hosts) == 1');
  });
});
