/**
 * 索引任务不得进部署链路（Codex P1，2026-09-15）。
 *
 * 曾经在 cds-compose.yml 放过一个 `mongodb-indexes` 一次性容器，并把 api 的启动挂到它
 * `service_completed_successfully` 上。两处都错，而且都不会在本地显形：
 *
 * 1. CDS 的 compose 解析把「挂了相对路径源码」当成应用服务（isAppServiceCandidate →
 *    hasRelativeVolumeMount），于是给它 `/app` 工作目录、合成 8080 端口，再等一个 mongosh
 *    永远不会开的 TCP 监听；声明的挂载点也随之被改写，脚本路径失效。任何一次重新导入或
 *    resync 都会让这个 profile 失败，并连坐拖住依赖它的 api。
 * 2. no-auto-index 明令索引由 DBA 手动建，原因正是「索引冲突导致应用启动失败」——
 *    而那一版把 API 启动直接挂到了索引脚本的成功退出上。
 *
 * 这条守卫盯的是「别再加回来」：不是断言某段措辞在不在，而是断言 compose 里没有任何服务
 * 在部署时跑索引脚本、也没有服务用 service_completed_successfully 把 api 挂在这种任务后面。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const compose = yaml.load(
  fs.readFileSync(path.join(repoRoot, 'cds-compose.yml'), 'utf8'),
) as { services?: Record<string, Record<string, unknown>> };

const services = compose.services ?? {};

describe('cds-compose 不把索引目录塞进部署链路', () => {
  it('扫得到服务（否则下面两条会对着空对象判绿）', () => {
    expect(Object.keys(services).length).toBeGreaterThan(5);
    expect(services.api, 'api 服务应当存在').toBeTruthy();
  });

  it('没有任何服务在部署时执行索引脚本', () => {
    const offenders: string[] = [];
    for (const [id, entry] of Object.entries(services)) {
      const text = JSON.stringify([entry.command, entry.entrypoint, entry.volumes] ?? '');
      if (/mongodb-indexes/.test(id) || /mongodb-indexes\.js/.test(text)) offenders.push(id);
    }
    expect(offenders, '索引由 DBA 手动跑 scripts/mongodb-indexes.js，见 no-auto-index').toEqual([]);
  });

  it('api 不靠某个一次性任务跑完才启动', () => {
    const dependsOn = (services.api?.depends_on ?? {}) as Record<string, { condition?: string }>;
    const completions = Object.entries(dependsOn)
      .filter(([, v]) => v?.condition === 'service_completed_successfully')
      .map(([k]) => k);
    expect(completions, 'CDS 的部署循环会等 TCP 监听，一次性任务退出后它等不到').toEqual([]);
    expect(dependsOn.mongodb?.condition).toBe('service_healthy');
  });
});
