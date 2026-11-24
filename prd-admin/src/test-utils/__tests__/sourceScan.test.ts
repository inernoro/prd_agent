import { describe, expect, it } from 'vitest';

import { stripComments } from '../sourceScan';

describe('stripComments', () => {
  it('去掉行注释，保留代码', () => {
    const out = stripComments('const a = 1; // role="radio" 是反面例子\nconst b = 2;');
    expect(out).not.toContain('role="radio"');
    expect(out).toContain('const a = 1;');
    expect(out).toContain('const b = 2;');
  });

  it('去掉块注释与 JSDoc', () => {
    const out = stripComments('/**\n * 不要写 addEventListener\n */\nmql.addListener(fn);');
    expect(out).not.toContain('addEventListener');
    expect(out).toContain('mql.addListener(fn);');
  });

  it('去掉 JSX 注释', () => {
    const out = stripComments('<div>{/* 别自己写 role="radio" */}<span /></div>');
    expect(out).not.toContain('role="radio"');
    expect(out).toContain('<span />');
  });

  it('注释掉的调用不再被当成调用', () => {
    // 三轮 review 那条守卫踩的就是这个：`// render();` 被认成「初始化还在调」。
    const out = stripComments('  // render();\n  fetchBranchInfo();');
    expect(out).not.toMatch(/^\s*render\(\);/m);
    expect(out).toContain('fetchBranchInfo();');
  });

  it('字符串里的 // 不算注释，整段保留', () => {
    const out = stripComments("const url = 'https://example.com/x'; // 尾注");
    expect(out).toContain("'https://example.com/x'");
    expect(out).not.toContain('尾注');
  });

  it('模板串里的 /* */ 不算注释', () => {
    const out = stripComments('const css = `a{/* keep */}`;');
    expect(out).toContain('/* keep */');
  });

  it('转义引号不会让字符串提前结束', () => {
    const out = stripComments("const s = 'it\\'s // not a comment'; // 真注释");
    expect(out).toContain('// not a comment');
    expect(out).not.toContain('真注释');
  });
});
