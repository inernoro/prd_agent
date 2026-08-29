import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectSlideDeck } from './slideDeck';

/**
 * 「这是不是一套幻灯片」在前后端必须是同一个判断（Codex 第二十七轮 P2）。
 *
 * 后端曾用裸子串匹配：`class="reveal"` 单独就算 deck（reveal 是很常见的动画 class 名），
 * 而且写死了双引号，`class='reveal'` 与 `class="a reveal b"` 都漏。前端 slideDeck.ts
 * 则刻意要求 reveal 容器**同时**有内层 .slides，正则也兼容引号与多 class。
 * 于是同一个页面：卡片标「幻灯片」，阅读页当普通网页——两种说法都出自我们自己。
 *
 * 跨语言没法共用一份代码，所以用这条守卫钉：两边的签名表必须逐条对应，
 * 且在同一批样本上给出相同答案。改一边不改另一边就红。
 */
const backend = readFileSync(
  fileURLToPath(new URL('../../../../prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs', import.meta.url)),
  'utf-8',
);
const frontend = readFileSync(fileURLToPath(new URL('./slideDeck.ts', import.meta.url)), 'utf-8');

/** 把两边签名表里的正则主体抽出来，规范化到可比较的形状 */
function backendPatterns(): string[] {
  const block = backend.slice(
    backend.indexOf('SlideDeckSignatures ='),
    backend.indexOf('};', backend.indexOf('SlideDeckSignatures =')),
  );
  return [...block.matchAll(/new\(@"((?:[^"]|"")*)"/g)]
    .map((m) => m[1].replace(/""/g, '"'))
    .sort();
}

function frontendPatterns(): string[] {
  const block = frontend.slice(
    frontend.indexOf('DECK_SIGNATURES'),
    frontend.indexOf('];', frontend.indexOf('DECK_SIGNATURES')),
  );
  return [...block.matchAll(/^\s*\/((?:[^/\\]|\\.)+)\/i,\s*$/gm)].map((m) => m[1]).sort();
}

describe('幻灯片判据前后端一致', () => {
  it('两边的签名表逐条对应', () => {
    const be = backendPatterns();
    const fe = frontendPatterns();
    expect(be.length, '后端签名表没解析出来，守卫要跟着改').toBeGreaterThan(0);
    expect(be).toEqual(fe);
  });

  it('同一批样本上两边答案相同', () => {
    // 每条样本都是历史上真出过分歧、或最容易分歧的形状
    const samples: Array<[string, boolean]> = [
      // 只有 reveal 容器、没有内层 slides —— 普通网页用 reveal 当动画 class 的情形
      ['<div class="reveal">一段带动画的普通网页</div>', false],
      // 完整 reveal deck
      ['<div class="reveal"><div class="slides"><section>第一页</section></div></div>', true],
      // 单引号 + 多 class：裸子串匹配会漏
      ["<div class='a reveal b'><div class='slides'><section>x</section></div></div>", true],
      ['<script src="/js/reveal.min.js"></script>', true],
      ['<div id="impress"><div class="step">x</div></div>', true],
      ['<script>remark.create({ source: "# hi" });</script>', true],
      ['<p>一篇完全普通的网页，没有任何幻灯痕迹</p>', false],
    ];

    for (const [html, expected] of samples) {
      expect(detectSlideDeck(html), `前端判据在这条样本上不符预期：${html.slice(0, 50)}`).toBe(expected);
    }

    // 后端用的是同一批正则（上一条已钉逐条相同），所以答案必然一致；
    // 这里再走一遍前端实现，确保那批正则本身表达的就是我们要的语义。
  });
});
