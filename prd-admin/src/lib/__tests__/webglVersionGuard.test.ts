import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 守卫：**用 GLSL ES 3 写 shader 的地方，必须先确认拿到的真是 WebGL2。**
 *
 * ogl 的 `Renderer` 拿不到 webgl2 会**静默退回** webgl1——构造函数照样成功、不抛异常。
 * 而 `#version 300 es` 的 shader 在 webgl1 上编译失败，ogl 的 `Program` 只把编译错误
 * 打进 console，也不抛。两个「不抛」叠在一起，结果是：canvas 挂上了、rAF 循环转起来了、
 * 一个像素都不画——**比崩掉更糟**，因为它看着像「这台设备就是没效果」，而实际上在烧电。
 *
 * 首页视觉契约（`rule.frontend.landing-visual-style.md` R2）第一条写的是「拿不到就不画，
 * 回落到静态底」。只 try/catch 构造函数兑现不了这句话：那只挡住「完全没有 WebGL」，
 * 挡不住「只有 WebGL1」。所以判据是两样都要有。
 */

const ROOT = join(__dirname, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      out.push(...walk(p));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

/** 同时满足「自己 new 了 ogl 的 Renderer」与「shader 声明了 GLSL ES 3」才算受管 */
const managed = walk(ROOT)
  .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
  .filter(({ source }) => source.includes('new Renderer(') && source.includes('#version 300 es'));

describe('GLSL ES 3 渲染层的版本守卫', () => {
  it('确实扫到了受管文件（否则下面几条是恒真的）', () => {
    expect(managed.length).toBeGreaterThan(0);
  });

  it.each(managed.map(({ path, source }) => [path.slice(ROOT.length + 1), source]))(
    '%s 必须挡住只有 WebGL1 的设备',
    (_name, source) => {
      expect(source).toMatch(/!\s*renderer\.isWebgl2/);
    },
  );

  it.each(managed.map(({ path, source }) => [path.slice(ROOT.length + 1), source]))(
    '%s 仍要挡住完全没有 WebGL 的设备',
    (_name, source) => {
      // 构造 Renderer 那一步要包在 try 里：完全没有上下文时 ogl 会在内部解引用 null 抛出
      expect(source).toMatch(/try\s*\{[\s\S]{0,400}new Renderer\(/);
    },
  );
});
