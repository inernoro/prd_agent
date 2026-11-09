import { describe, expect, it } from 'vitest';
import { ProjectAdmissionOrder } from '../../src/services/project-admission-order.js';

describe('动态合格项目公平轮转', () => {
  it.each(['新项目持续到达', '旧项目退出后重新取得资格'])('%s不能连续抢在仍合格的老项目之前', mode => {
    const order = new ProjectAdmissionOrder();
    if (mode === '旧项目退出后重新取得资格') for (let index = 0; index < 6; index++) order.grant(`arrival-${index}`);
    order.grant('a'); order.grant('b');
    const records: Array<{ eligible: string[]; selected: string }> = [];
    for (let round = 0; round < 6; round++) {
      const eligible = ['a', 'b', `arrival-${round}`];
      const selected = eligible[order.next(eligible, project => project)];
      records.push({ eligible, selected }); order.grant(selected);
    }
    expect(records.every(record => record.eligible.length === 3)).toBe(true);
    expect(records.slice(0, 3).map(record => record.selected)).toContain('a');
    expect(records.slice(0, 3).map(record => record.selected)).toContain('b');
  });

  it('同项目保留队首资格和顺序，不让不合格队首阻塞另一项目', () => {
    const order = new ProjectAdmissionOrder();
    const queue = [{ project: 'a', ready: false }, { project: 'a', ready: true }, { project: 'b', ready: true }];
    expect(order.next(queue, item => item.project, item => item.ready)).toBe(2);
    order.grant('b'); queue[0].ready = true;
    expect(order.next(queue, item => item.project, item => item.ready)).toBe(0);
  });
});
