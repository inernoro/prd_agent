import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 2026-09-20 实测：OpenDesign 的第 14 次模型调用撞上 413，栈里是 raw-body——
 * CDS 的全局 `express.json()`（默认 100kb）把自己的解析上限套在了一条**转发给 MAP**
 * 的请求上。容器拿到的是一个 HTML 的 413，读起来像模型出错。
 *
 * 这个洞此前已经以另外两种形态出现过两次（验收报告正文、快捷提 bug 的截图附件），
 * 同一个文件的注释里写着同一句诊断。第三次了，所以这里钉成判据。
 *
 * 判据选「跳过清单里有它」而不是「解析器的 limit 是多少」：CDS 没有任何理由去解析
 * 一条它只负责转发的请求体，调大上限只是把下一次 413 推后。
 * 红绿闭环：把那行 `if (isDesignRuntimeModelProxyPath(...)) return next();` 删掉，本条变红。
 */
describe('CDS must not body-parse what it only forwards', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/server.ts'),
    'utf8',
  );

  it('skips the global JSON parser for the OpenDesign model proxy', () => {
    const guard = source.slice(
      source.indexOf('const globalJsonParser = express.json({'),
      source.indexOf('return globalJsonParser(req, res, next);'),
    );

    expect(guard).toContain('if (isDesignRuntimeModelProxyPath(req.path)) return next();');
  });

  it('matches only the two proxy endpoints, not the whole design-artifacts family', () => {
    // 判定函数是 server.ts 里的局部箭头函数，这里按它的定义逐字复核匹配范围——
    // 裸前缀会把用户自己的 design-artifacts 接口一起收走，那些该照常解析。
    const decl = source.slice(source.indexOf('const isDesignRuntimeModelProxyPath ='));
    expect(decl).toContain("requestPath.startsWith('/api/design-artifacts/runtime/')");
    expect(decl).toContain("requestPath.endsWith('/llm/v1/chat/completions')");
    expect(decl).toContain("requestPath.endsWith('/llm/v1/responses')");

    const match = (p: string) => p.startsWith('/api/design-artifacts/runtime/')
      && (p.endsWith('/llm/v1/chat/completions') || p.endsWith('/llm/v1/responses'));
    expect(match('/api/design-artifacts/runtime/r1/llm/v1/responses')).toBe(true);
    expect(match('/api/design-artifacts/runtime/r1/llm/v1/chat/completions')).toBe(true);
    expect(match('/api/design-artifacts/runtime/r1/workspace/result')).toBe(false);
    expect(match('/api/design-artifacts/runs')).toBe(false);
  });
});
