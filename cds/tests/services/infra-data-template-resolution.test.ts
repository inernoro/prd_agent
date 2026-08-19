import { describe, it, expect } from 'vitest';
import { buildInfraDataExec } from '../../src/routes/infra-data.js';
import type { InfraService } from '../../src/types.js';

/**
 * E40 的回归：数据工作台把 env 里的 `${...}` 模板占位当字面量用。
 *
 * 2026-08-18 实例：mytapd 的 mysql 台账里 `MYSQL_USER` 存的是 `${CDS_MYSQL_USER}`，
 * 工作台直接拿去拼 `mysql -u${CDS_MYSQL_USER}`，报
 * `Access denied for user '${CDS...'`。而容器本身没问题——启动时会解析模板，
 * 备份走容器内展开也是通的。于是现象自相矛盾：**库好好的、备份也通，只有工作台连不上**，
 * 很容易被误判成「刚才那次重建把库弄坏了」。
 */
const svc = (env: Record<string, string>): InfraService => ({
  id: 'mysql', projectId: 'p1', name: 'MySQL', dockerImage: 'mysql:8',
  containerPort: 3306, hostPort: 13306, containerName: 'cds-infra-mysql',
  status: 'running', volumes: [], env, createdAt: '2026-04-30T00:00:00Z',
} as InfraService);

describe('工作台解析 env 模板', () => {
  it('给了变量表就展开成真值，命令里不留占位符', () => {
    const plan = buildInfraDataExec(
      svc({ MYSQL_USER: '${CDS_MYSQL_USER}', MYSQL_ROOT_PASSWORD: 'pw', MYSQL_DATABASE: '${CDS_MYSQL_DATABASE}' }),
      'query', 'SELECT 1;',
      { CDS_MYSQL_USER: 'appuser', CDS_MYSQL_DATABASE: 'appdb' },
    );
    const argv = plan.argv.join(' ');
    expect(argv).toContain('-uappuser');
    expect(argv).toContain('appdb');
    expect(argv, '命令里不该再出现模板占位符').not.toContain('${');
  });

  it('变量表里没有对应值：明确说是哪个变量，而不是把占位符当账号发出去', () => {
    // 报 Access denied 会把人引向「密码错了」，实际是「变量没解析」——
    // 错误信息指错方向比没有错误信息更费时间。
    expect(() => buildInfraDataExec(
      svc({ MYSQL_USER: '${CDS_MYSQL_USER}', MYSQL_ROOT_PASSWORD: 'pw' }),
      'query', 'SELECT 1;',
      { SOMETHING_ELSE: 'x' },
    )).toThrow(/MYSQL_USER/);
  });

  it('env 里本来就是具体值：行为不变', () => {
    const plan = buildInfraDataExec(
      svc({ MYSQL_USER: 'plainuser', MYSQL_ROOT_PASSWORD: 'pw' }),
      'query', 'SELECT 1;', { },
    );
    expect(plan.argv.join(' ')).toContain('-uplainuser');
  });

  it('不传变量表时沿用旧行为，不影响其它调用方', () => {
    const plan = buildInfraDataExec(svc({ MYSQL_ROOT_PASSWORD: 'pw' }), 'query', 'SELECT 1;');
    expect(plan.argv.join(' ')).toContain('-uroot');
  });
});
