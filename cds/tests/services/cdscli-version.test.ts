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
  });
});
