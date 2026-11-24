import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCdsCompose } from '../../src/services/compose-parser.js';

/**
 * cds-compose.yml 导入基础设施服务时，解析器读出来的字段必须**全部**落进 InfraService。
 *
 * 这条链路原来断在中间（台账 E80）：解析器读得出 `command`，序列化器写得回 `command`，
 * 唯独 `importCdsComposeFromFile` 建服务时把它丢了。两件事因此静默坏掉：
 *
 * 1. 容器起来时没有那条启动命令——`redis-server --requirepass ...` 退化成裸 redis。
 * 2. 认证判据（`detectInfraAuth`）看不到启动参数，把这台库判成「没配认证」，
 *    于是凭据一个都发不出去。**它不报错**，只是让消费方连不上。
 *
 * ## 为什么这条守卫扫源码
 *
 * `importCdsComposeFromFile` 是 `createProjectsRouter` 里的闭包，拿不到手。
 * 但左边那一半是**真跑出来的**：下面的字段清单来自 `parseCdsCompose` 的实际输出，
 * 不是照着记忆抄的一份名单——解析器哪天多读一个字段，这条守卫自己就会要求
 * 导入侧也带上它，不需要谁记得回来改这个测试。
 */
describe('cds-compose 导入不许丢基础设施字段', () => {
  /** 一份把 InfraService 关心的字段全都声明了的 compose。 */
  // 必须带一个 x-cds-* 扩展，否则 parseCdsCompose 认为「这不是 CDS 的 compose」
  // 直接返回 null——上面那条空跑断言就是为了当场发现这种情况。
  const yaml = `
x-cds-project:
  name: guard-fixture
services:
  cache:
    image: redis:7-alpine
    ports:
      - "10002:6379"
    command: ["redis-server", "--requirepass", "s3cret"]
    entrypoint: ["docker-entrypoint.sh"]
    restart: always
    environment:
      REDIS_PASSWORD: s3cret
    volumes:
      - cache-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
volumes:
  cache-data:
`;

  /**
   * 解析器产出的键里，这几个在导入侧是**改了名或另算**的，不该要求出现 `def.<key>`：
   * name 走 `def.name || def.id` 兜底，其余三个直接读同名字段但形态不同。
   * 这份豁免名单只允许收缩，不允许因为「新字段没接上」而扩张。
   */
  const RENAMED = new Set(['id', 'name']);

  it('解析器读得出的每个字段，导入建服务时都带上了', () => {
    const parsed = parseCdsCompose(yaml);
    expect(parsed, 'compose 解析失败，这条守卫在空跑').not.toBeNull();
    const def = parsed!.infraServices.find((s) => s.id === 'cache');
    expect(def, '样例 compose 里的 infra 服务没被解析出来，这条守卫在空跑').toBeTruthy();

    // 样例真的覆盖到了出事的那几个字段——否则守卫会在「解析器根本没读 command」
    // 的情况下静默变绿（形状 4b）。
    for (const key of ['command', 'entrypoint', 'restartPolicy', 'env', 'volumes', 'healthCheck']) {
      expect(Object.keys(def!), `样例 compose 没覆盖 ${key}，守卫会漏判`).toContain(key);
    }

    const source = readFileSync(join(process.cwd(), 'src/routes/projects.ts'), 'utf8');
    // 必须先定位到导入那个函数再找构造块：projects.ts 里有两处 `const service:
    // InfraService = {`，另一处是「按预设建服务」，读的是 preset.* 而不是 def.*。
    // 不先收窄的话守卫会去扫错的那一段，然后把每个字段都报成丢了。
    const fnAt = source.indexOf('function importCdsComposeFromFile(');
    expect(fnAt, '找不到 importCdsComposeFromFile，守卫失效').toBeGreaterThan(0);
    const start = source.indexOf('const service: InfraService = {', fnAt);
    expect(start, '导入函数里找不到构造 InfraService 的那段，守卫失效').toBeGreaterThan(fnAt);
    const block = source.slice(start, source.indexOf('stateService.addInfraService(service)', start));
    expect(block.length, '构造块切空了，守卫在空跑').toBeGreaterThan(100);

    const dropped = Object.keys(def!)
      .filter((key) => !RENAMED.has(key))
      .filter((key) => !block.includes(`def.${key}`));

    expect(
      dropped,
      '解析器读出了这些字段，导入建 InfraService 时却没带上 —— 容器会按缺了它们的形态启动',
    ).toEqual([]);
  });
});
