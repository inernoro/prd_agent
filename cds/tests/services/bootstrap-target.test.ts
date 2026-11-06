import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { bootstrapRepository, bootstrapTarget } from '../../src/services/bootstrap-target.js';

describe('建项目仓库身份绑定', () => {
  it.each(['ssh://git@ssh.github.com:443/acme/demo.git', 'http://gitbox:443/acme/demo',
    'ssh://git@gitbox:80/acme/demo', 'https://gitbox:8443/acme/demo',
    'https://github.com:443/acme/demo', 'ssh://git@github.com:22/acme/demo'])('规范仓库身份再次校验保持幂等：%s', value => {
    const requested = bootstrapTarget({ name: 'Demo', repository: value });
    expect(requested).not.toBeNull();
    expect(bootstrapTarget(requested)).toEqual(requested);
  });

  it('同一 GitHub 仓库的 HTTPS、SSH、大小写和 .git 等价且不存凭据', () => {
    for (const value of ['https://github.com/Acme/Demo.git', 'git@github.com:acme/demo',
      'ssh://git@github.com:22/ACME/demo.git', 'https://user:secret@github.com/acme/demo?token=secret#fragment']) {
      expect(bootstrapRepository(value)).toBe('github.com/acme/demo');
    }
  });
  it('主机和自定义端口不能丢掉，非法仓库不接受', () => {
    expect(bootstrapRepository('https://gitlab.com/acme/demo')).not.toBe(bootstrapRepository('https://github.com/acme/demo'));
    for (const value of ['', 'file:///tmp/demo', 'https://github.com/acme',
      'https://github.com/acme/%2Fdemo']) {
      expect(bootstrapRepository(value)).toBeNull();
    }
    expect(bootstrapRepository('ssh://git@gitbox:2222/acme/demo')).toBe('gitbox:2222/acme/demo');
    expect(bootstrapRepository('http://github.com:22/acme/demo')).not.toBe('github.com/acme/demo');
    expect(bootstrapTarget({ name: '   ', repository: 'https://github.com/acme/demo' })).toBeNull();
  });
});

// 运行原两个批准按钮的实际disabled表达式，避免卡片与详情各自漂移。
describe('目标绑定审批的两个现有入口', () => {
  it.each([
    { name: '历史未绑定申请', kind: 'bootstrap', targetBound: false, busy: false, disabled: true },
    { name: '已绑定申请', kind: 'bootstrap', targetBound: true, busy: false, disabled: false },
    { name: '原项目访问申请', kind: 'project', targetBound: false, busy: false, disabled: false },
    { name: '正在处理申请', kind: 'bootstrap', targetBound: true, busy: true, disabled: true },
  ])('$name在卡片和详情保持相同批准资格', ({ kind, targetBound, busy, disabled }) => {
    const source = readFileSync(new URL('../../web/src/components/AccessRequestInbox.tsx', import.meta.url), 'utf8');
    const file = ts.createSourceFile('AccessRequestInbox.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const actual: boolean[] = [], item = { kind, targetBound };
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(file) === 'Button') {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        if (attributes.find(a => a.name.getText(file) === 'onClick')?.initializer?.getText(file).includes('approve(')) {
          const expression = attributes.find(a => a.name.getText(file) === 'disabled')?.initializer;
          if (expression && ts.isJsxExpression(expression) && expression.expression)
            actual.push(Boolean(runInNewContext(expression.expression.getText(file), { item, primary: item, isBusy: busy, primaryBusy: busy })));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(actual).toEqual([disabled, disabled]);
  });
});
