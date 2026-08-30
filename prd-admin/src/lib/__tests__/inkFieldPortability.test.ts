import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INK_FIELD_SATURATION_CEILING, isInkFieldSaturated } from '@/components/backgrounds/InkFieldBackdrop';

/**
 * 守卫首页那层全屏墨场的两件事：**同一份代码在不同显卡上算出同一张图**，
 * 以及**万一还是糊了，页面自己认得出来并把这层撤掉**。
 *
 * 起因：用户两台机器对着看同一个首页——Apple 那台是一缕一缕的墨，NVIDIA 5080 那台
 * 整屏糊成一层暖橙盖住正文。代码里没有任何随机：相位、指针、SPA 重挂载都量过，
 * 都不足以解释（各自只让平均色动几个 RGB 单位）。剩下的解释是 shader 里那个到处抄的
 * fract(sin(dot(p,k)) * 43758.5453)——它算什么取决于驱动怎么实现大参数的 sin。
 *
 * 这类问题在 CI 上**永远复现不出来**：无头浏览器跑的是软件渲染（SwiftShader），
 * 它甚至把 mediump 当 highp 编，实测 highp/mediump 两路输出逐位相同。所以下面这些
 * 判据都不是"跑一遍看看对不对"，而是"把已知会翻车的写法钉死在门外"。
 */

const SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'src/components/backgrounds/InkFieldBackdrop.tsx'),
  'utf8',
);

/** 取出真正会被编译的那段 shader，注释和 TS 代码不算数。 */
function fragmentShader(): string {
  const body = SOURCE.split('const FRAG = `#version 300 es\n')[1]?.split('\n`;\n')[0];
  if (!body) throw new Error('没能从 InkFieldBackdrop.tsx 里取到 FRAG —— 结构变了，先修这个测试');
  // 逐行去掉注释：注释里**要**出现 fract(sin( 那串（它在解释为什么不能用），
  // 判据只看会被 GPU 执行的代码，否则这条守卫会被自己的说明文字弄红。
  return body
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/*') && !l.trimStart().startsWith('//'))
    .map((l) => l.replace(/\/\/.*$/, '')) // 行尾注释也去掉，否则注释里提一句 sin 就能把判据弄红
    .join('\n');
}

describe('首页墨场的跨显卡一致性', () => {
  it('这段 shader 里不许出现三角函数，它们的精度由驱动说了算', () => {
    // 判据故意管得比「那一句写法」宽：只认 fract(sin(...)) 的直写法，
    // 把 sin 的结果先存进临时变量、之后再 fract 乘个别的数，就绕过去了——
    // 而绕过去的那个版本恢复的正是本 PR 要消灭的驱动相关行为。
    //
    // 所以这里禁的是整类：这段 shader 的随机性只该来自那个整数 hash，
    // 它不需要任何三角函数。日后真有正当用途（比如拿 sin(t) 做一次振荡），
    // 那是一次要当面想清楚的改动——改这条守卫时先回答一句：新加的这个
    // sin 有没有参与噪声取值？参与了就不行，没参与就在这里显式放行并写明理由。
    const glsl = fragmentShader();
    expect(glsl).not.toMatch(/\b(sin|cos|tan)\s*\(/);
    expect(glsl).not.toContain('43758.5453');
  });

  it('整数必须显式声明 highp：片元着色器里 int 的默认精度是 mediump', () => {
    // 只写 precision highp float 是不够的。整数默认 mediump（规范只保证 16 位），
    // 而下面那个 hash 全押在 32 位无符号溢出和右移 16 位上——mediump 下全被截断，
    // 噪声又变回设备相关，等于这次改动白做。
    const glsl = fragmentShader();
    expect(glsl).toContain('precision highp int;');
    expect(glsl.indexOf('precision highp int;')).toBeLessThan(glsl.indexOf('uvec2 uhash'));
  });

  it('运行时还要问一句这台设备的 highp int 到底是几位', () => {
    // 源码里写了 highp 不等于拿到了 32 位。拿不到就不画这层，回落静态底。
    expect(SOURCE).toContain('gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_INT)');
    expect(SOURCE).toMatch(/rangeMax\s*<\s*31/);
  });

  it('hash 走整数位运算：uint 的乘法溢出、移位、异或逐位有定义', () => {
    const glsl = fragmentShader();
    expect(glsl).toContain('uvec2 uhash(uvec2 x)');
    // 三样缺一不可：溢出乘（扩散）、右移异或（折叠）、以及把结果映回 0..1
    expect(glsl).toMatch(/x\s*=\s*x\s*\*\s*\d+u\s*\+\s*\d+u;/);
    expect(glsl).toMatch(/x\s*\^=\s*x\s*>>\s*\d+u;/);
    expect(glsl).toContain('4294967296.0');
  });

  it('时间以本次挂载为原点，不用 rAF 那个从导航开始算的时间戳', () => {
    // 用 ms 直接当 uTime 的话，同一个页面开着越久相位漂得越远：
    // 截图对不上、视觉回归没法复现，噪声坐标也会被推到很大的量级。
    expect(SOURCE).not.toMatch(/uTime\.value\s*=\s*ms\s*\*/);
    expect(SOURCE).toMatch(/uTime\.value\s*=\s*\(ms\s*-\s*t0\)\s*\*/);
  });

  it('第一帧画完要读回来自检一次', () => {
    expect(SOURCE).toContain('gl.readPixels');
    expect(SOURCE).toMatch(/if\s*\(!checked\)\s*\{\s*checked\s*=\s*true;\s*selfCheck\(\);\s*\}/);
  });
});

describe('isInkFieldSaturated —— 糊没糊的判据', () => {
  const INTENSITY = 0.3;
  /** 真实测量值：换成整数 hash 后，无头浏览器跑这段 shader 的平均 alpha 在 17..21 之间 */
  const HEALTHY = [17.2, 17.8, 17.5, 19, 20.3].map((v) => Math.round(v));

  it('正常的墨有大片留白，判为没糊', () => {
    for (const mean of HEALTHY) {
      expect(isInkFieldSaturated(new Array(64).fill(mean), INTENSITY)).toBe(false);
    }
  });

  it('整屏糊住时判为糊了', () => {
    // 用户拍到的那种：veil 处处顶到 intensity，只剩上浓下淡那条竖直渐变
    const washed = Array.from({ length: 64 }, (_, i) => 255 * INTENSITY * (0.3 + 0.7 * (i / 63)));
    expect(isInkFieldSaturated(washed, INTENSITY)).toBe(true);
  });

  it('阈值对着真实测量值留有余量，不是贴边定的', () => {
    const worstHealthyRatio = Math.max(...HEALTHY) / 255 / INTENSITY;
    expect(worstHealthyRatio).toBeLessThan(INK_FIELD_SATURATION_CEILING * 0.7);
  });

  it('判据跟着浓度走：调 intensity 不用改阈值', () => {
    // 同一张图，浓度调低一半，像素 alpha 也低一半 —— 比值不变，判定不该翻转
    const alphas = new Array(64).fill(19);
    expect(isInkFieldSaturated(alphas, 0.3)).toBe(false);
    expect(isInkFieldSaturated(alphas.map((a) => a / 2), 0.15)).toBe(false);
    // 而浓度不变、像素翻上去，就该判糊
    expect(isInkFieldSaturated(alphas.map((a) => a * 3), 0.3)).toBe(true);
  });

  it('拿不到样本或浓度为 0 时不下结论，不误伤', () => {
    expect(isInkFieldSaturated([], 0.3)).toBe(false);
    expect(isInkFieldSaturated([255], 0)).toBe(false);
  });
});
