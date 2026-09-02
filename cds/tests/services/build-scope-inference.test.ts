/**
 * 构建范围的推断。
 *
 * 用例里的命令是从生产 CDS 上真取下来的（prd-agent 与 CDS Self 名下的构建配置），
 * 不是照着实现编的 —— 这块的价值全在「对真实数据管不管用」。
 */

import { describe, it, expect } from 'vitest';
import {
  declaredScopeSources,
  dirFromCommand,
  normalizeRepoRelativeDir,
  declaredScope,
  inferProfileScope,
  inferProjectScope,
} from '../../src/services/build-scope-inference.js';

// 生产上的真实命令（截断到与判据相关的部分）
const CMD_CDS_SELF = 'cd cds && corepack enable && corepack prepare pnpm@10.28.2 --activate && pnpm config set store-dir /pnpm/store && ./exec_cds.sh start';
const CMD_LLMGW_SERVE = 'cd /repo/llmgw/serving && rm -rf bin obj && dotnet restore && dotnet run --no-launch-profile -c Release --urls http://0.0.0.0:8091';
const CMD_ADMIN = 'cd prd-admin && corepack enable && corepack prepare pnpm@10.28.2 --activate && pnpm dev';
const CMD_API_NO_CD = 'if ! command -v ffmpeg >/dev/null 2>&1; then apt-get update && apt-get install -y ffmpeg; fi && dotnet run';

describe('从启动命令读出目录', () => {
  it('认得裸目录：cd cds', () => {
    expect(dirFromCommand(CMD_CDS_SELF)).toBe('cds');
  });

  it('认得容器里的仓库根挂载点：/repo/llmgw/serving 说的是仓库内的 llmgw/serving', () => {
    expect(dirFromCommand(CMD_LLMGW_SERVE)).toBe('llmgw/serving');
  });

  it('没有 cd 的命令不硬凑', () => {
    expect(dirFromCommand(CMD_API_NO_CD)).toBeNull();
  });

  it('只认第一条 cd：后面的 cd dist 是产物目录，跟着走会把范围缩到构建产物上', () => {
    expect(dirFromCommand('cd prd-admin && pnpm build && cd dist && node server.js')).toBe('prd-admin');
  });

  it('中段的 cd 不算：pnpm build && cd dist 里的 dist 是产物目录', () => {
    // 跟着它走会把范围缩成 dist/**，于是改 prd-admin/src 反被判「未波及」
    expect(dirFromCommand('pnpm build && cd dist && node server.js')).toBeNull();
  });

  it('仓库根本身不算范围 —— 那等于全通配，做不出任何区分', () => {
    expect(dirFromCommand('cd . && make')).toBeNull();
    expect(dirFromCommand('cd /repo && make')).toBeNull();
  });

  it('容器里的别处（/tmp）与仓库文件无关，不当成范围', () => {
    expect(dirFromCommand('cd /tmp && ./run.sh')).toBeNull();
  });

  it('跳出仓库的路径不猜', () => {
    expect(normalizeRepoRelativeDir('../sibling')).toBeNull();
    expect(normalizeRepoRelativeDir('a/../../b')).toBeNull();
  });

  it('带引号和尾斜杠都归一得掉', () => {
    expect(dirFromCommand('cd "llmgw/web/" && pnpm dev')).toBe('llmgw/web');
    expect(dirFromCommand("cd './cds' && ls")).toBe('cds');
  });
});

describe('已声明的范围优先于推断', () => {
  it('声明在部署模式上的也算数（生产上 express 模式带的就是这种）', () => {
    const declared = declaredScope({
      id: 'api',
      deployModes: { express: { buildScope: ['prd-api/**', '.github/workflows/branch-image.yml'] } },
    });
    expect(declared).toEqual(['prd-api/**', '.github/workflows/branch-image.yml']);
  });

  it('已声明就标 declared，不该再被劝去填一遍', () => {
    const guess = inferProfileScope({
      id: 'api',
      command: CMD_API_NO_CD,
      deployModes: { express: { buildScope: ['prd-api/**'] } },
    });
    expect(guess).toEqual({ scope: ['prd-api/**'], source: 'declared', why: '已经声明过' });
  });

  it('没声明才看命令，并且说得出依据', () => {
    const guess = inferProfileScope({ id: 'cds', command: CMD_CDS_SELF });
    expect(guess?.scope).toEqual(['cds/**']);
    expect(guess?.source).toBe('command');
    expect(guess?.why).toContain('cd cds');
  });

  it('workDir 优先于命令里的 cd —— 命令是在 workDir 里执行的', () => {
    const guess = inferProfileScope({
      id: 'admin',
      workDir: 'prd-admin',
      command: 'pnpm build && cd dist && node server.js',
    });
    expect(guess).toEqual({ scope: ['prd-admin/**'], source: 'workDir', why: '工作目录是 prd-admin' });
  });

  it('workDir 是仓库根时才轮到命令（生产上普遍是 .）', () => {
    const guess = inferProfileScope({ id: 'cds', workDir: '.', command: CMD_CDS_SELF });
    expect(guess?.scope).toEqual(['cds/**']);
    expect(guess?.source).toBe('command');
  });

  it('命令没线索时退到 workDir', () => {
    const guess = inferProfileScope({ id: 'x', command: CMD_API_NO_CD, workDir: 'prd-video' });
    expect(guess).toEqual({ scope: ['prd-video/**'], source: 'workDir', why: '工作目录是 prd-video' });
  });

  it('workDir 是仓库根（生产上普遍是 .）时不当线索', () => {
    expect(inferProfileScope({ id: 'x', command: CMD_API_NO_CD, workDir: '.' })).toBeNull();
  });
});

describe('分清范围声明在哪儿', () => {
  it('顶层与部署模式分开报，因为写回只能写对应那处', () => {
    expect(declaredScopeSources({
      id: 'x',
      buildScope: ['cds/**'],
      deployModes: { express: { buildScope: ['llmgw/serving/**', ' prd-api/** '] } },
    })).toEqual({ onProfile: ['cds/**'], onDeployModes: ['llmgw/serving/**', 'prd-api/**'] });
  });

  it('都没声明时两边都空', () => {
    expect(declaredScopeSources({ id: 'x', command: CMD_CDS_SELF }))
      .toEqual({ onProfile: [], onDeployModes: [] });
  });
});

describe('汇成项目级建议', () => {
  it('CDS Self：一个服务、只有 cd cds，建议就是 cds/**', () => {
    const s = inferProjectScope([{ id: 'cds-cds-self', name: 'cds', command: CMD_CDS_SELF, workDir: '.' }]);
    expect(s?.scope).toEqual(['cds/**']);
    expect(s?.guessedCount).toBe(1);
    expect(s?.declaredCount).toBe(0);
  });

  it('MAP：五个服务都已声明，建议等于声明的并集且没有一个是猜的', () => {
    const s = inferProjectScope([
      { id: 'api', workDir: '.', deployModes: { express: { buildScope: ['prd-api/**'] } } },
      { id: 'admin', workDir: '.', command: CMD_ADMIN, deployModes: { express: { buildScope: ['prd-admin/**'] } } },
      { id: 'gw', workDir: '.', command: CMD_LLMGW_SERVE, deployModes: { express: { buildScope: ['llmgw/serving/**'] } } },
    ]);
    expect(new Set(s?.scope)).toEqual(new Set(['prd-api/**', 'prd-admin/**', 'llmgw/serving/**']));
    expect(s?.guessedCount).toBe(0);
    expect(s?.why).toBe('全部来自已声明的范围');
  });

  it('依据要具体到能核对，不是「按命令看出来的」这种没法验证的话', () => {
    const one = inferProjectScope([{ id: 'cds', name: 'cds', command: CMD_CDS_SELF }]);
    expect(one?.why).toBe('启动命令里 cd cds');

    const many = inferProjectScope([
      { id: 'a', name: '网关', command: CMD_LLMGW_SERVE },
      { id: 'b', name: '后台', command: CMD_ADMIN },
    ]);
    expect(many?.why).toBe('网关：启动命令里 cd llmgw/serving；后台：启动命令里 cd prd-admin');
  });

  it('只要有一个服务连线索都没有，整个项目就不给建议', () => {
    // 按已知的几个收窄，会把那个未知服务需要的路径挡在外面 —— 推送到它就静默不重建。
    const s = inferProjectScope([
      { id: 'cds', command: CMD_CDS_SELF },
      { id: 'mystery', command: CMD_API_NO_CD, workDir: '.' },
    ]);
    expect(s).toBeNull();
  });

  it('没有任何构建配置时不给建议', () => {
    expect(inferProjectScope([])).toBeNull();
  });
});
