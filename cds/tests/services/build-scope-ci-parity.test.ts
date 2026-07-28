/**
 * buildScope 必须与 CI 的 path-filter 逐条一致（Codex PR #1275 三轮 P1 的守卫）。
 *
 * 「per-SHA 镜像拉不到 → 该组件是不是真的没变」这个判断，唯一可信的依据是 CI
 * 构建该镜像时的输入范围。CDS 侧把它声明在 `cds-compose.yml` 的
 * `x-cds-deploy-modes.<svc>.express.buildScope`，权威定义则在
 * `.github/workflows/branch-image.yml` 的 filters —— 两份东西描述同一件事，
 * 一旦漂移就会出人命：
 *
 *   - 声明得比 CI **窄**：CI 因为某路径变更重建了镜像，CDS 却判「没变」而复用旧的
 *     → 静默发旧代码（比多编译一次危险得多）；
 *   - 声明得比 CI **宽**：白白错过复用，退回宿主全量重编（就是本 PR 要治的事故）。
 *
 * 所以两边必须逐条对拍。改了工作流 filters 而忘了改 compose，这条测试就红。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readYaml = (rel: string): Record<string, unknown> =>
  yaml.load(fs.readFileSync(path.join(repoRoot, rel), 'utf8')) as Record<string, unknown>;

/** CI 的 filter 名 → cds-compose 里的服务名。 */
const COMPONENT_TO_SERVICE: Record<string, string> = {
  api: 'api',
  admin: 'admin',
  llmgw: 'llmgw',
  llmgw_web: 'llmgw-web',
  llmgw_serve: 'llmgw-serve',
};

describe('cds-compose 的 buildScope 与 branch-image.yml 的 path-filter 对拍', () => {
  const wf = readYaml('.github/workflows/branch-image.yml');
  const compose = readYaml('cds-compose.yml');

  // 工作流里 filters 是一段 YAML **字符串**（dorny/paths-filter 的 with.filters），
  // 需要二次解析。
  const changesSteps = ((wf.jobs as Record<string, { steps?: Array<Record<string, unknown>> }>)
    .changes.steps || []);
  const filterStep = changesSteps.find((s) => String(s.uses || '').includes('paths-filter'));
  const filters = yaml.load(
    String((filterStep?.with as Record<string, unknown>).filters),
  ) as Record<string, string[]>;

  const modes = compose['x-cds-deploy-modes'] as Record<string, Record<string, { buildScope?: string[] }>>;

  it('CI 认识的组件，compose 里都声明了 buildScope', () => {
    for (const comp of Object.keys(COMPONENT_TO_SERVICE)) {
      expect(filters[comp], `工作流缺少 filter: ${comp}`).toBeTruthy();
      const svc = COMPONENT_TO_SERVICE[comp];
      expect(modes[svc]?.express?.buildScope, `compose 服务 ${svc} 缺 express.buildScope`).toBeTruthy();
    }
  });

  it('每个组件的路径集合逐条相等（顺序无关）', () => {
    for (const [comp, svc] of Object.entries(COMPONENT_TO_SERVICE)) {
      const ci = [...filters[comp]].sort();
      const declared = [...(modes[svc].express.buildScope || [])].sort();
      expect(declared, `${svc}.express.buildScope 与 CI filter '${comp}' 不一致`).toEqual(ci);
    }
  });

  it('buildScope 不是 workDir 的复制品（后者是整仓挂载，比了等于没比）', () => {
    // 这些服务在 compose 里都写 `.:/repo`，workDir 会被解析成 '.'。
    // buildScope 一旦退化成 '.'，复用判定就永远是「变了」，本 PR 的止损点失效。
    for (const svc of Object.values(COMPONENT_TO_SERVICE)) {
      const scope = modes[svc].express.buildScope || [];
      expect(scope).not.toContain('.');
      expect(scope).not.toContain('./');
      expect(scope).not.toContain('**');
    }
  });
});
