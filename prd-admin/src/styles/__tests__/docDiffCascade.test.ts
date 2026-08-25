import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * doc-diff.css 的层叠守卫。
 *
 * 断言的不是「文件里写没写某一行」，而是**最终生效的那个值**
 *（predicate-and-wiring-discipline.md 形状 6：判据读的值必须是真正生效的那个）。
 * 这里按 CSS 的胜负规则算一遍：特异性高的赢，特异性相同时后写的赢。
 *
 * 之所以需要它：`.doc-inline-diff--streaming ins` 与 `.doc-inline-diff ins` 特异性一模一样，
 * 谁赢只取决于谁写在后面。有人把规则往上挪一段、或在后面补一条同名规则，覆盖就会静默失效，
 * 而「一闪一闪」这种毛病肉眼要盯着流式过程才看得出来，回归了也不会有人发现。
 */

const CSS = readFileSync(resolve(__dirname, '../doc-diff.css'), 'utf-8');

/** 去掉 @media / @keyframes 这类带嵌套花括号的块，剩下的才是顶层规则 */
function stripAtBlocks(css: string): string {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] !== '@') { out += css[i]; continue; }
    // 跳到该 at-rule 的第一个 {，然后配对到它的 }
    let j = css.indexOf('{', i);
    if (j < 0) break;
    let depth = 0;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    i = j;
  }
  return out;
}

interface Rule { selector: string; decls: Record<string, string>; order: number }

function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let order = 0;
  while ((m = re.exec(css))) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!selector) continue;
    const decls: Record<string, string> = {};
    for (const d of m[2].split(';')) {
      const k = d.indexOf(':');
      if (k < 0) continue;
      decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
    }
    rules.push({ selector, decls, order: order++ });
  }
  return rules;
}

/** 只数类与标签，够这份文件用 */
function specificity(sel: string): number {
  return (sel.match(/\.[\w-]+/g)?.length ?? 0) * 10 + (sel.match(/(?:^|[\s>])([a-z]+)/g)?.length ?? 0);
}

/**
 * 算「容器带着 containerClasses 这些类时，tag 上的 prop 最终是什么」。
 * 规则要求的每个类都必须在 containerClasses 里，否则这条规则根本不匹配。
 */
function winning(prop: string, tag: string, containerClasses: string[]): { selector: string; value: string } | null {
  const rules = parseRules(stripAtBlocks(CSS))
    .filter((r) => r.decls[prop] !== undefined)
    .filter((r) => new RegExp(`(?:^|[\\s>])${tag}$`).test(r.selector))
    .filter((r) => (r.selector.match(/\.[\w-]+/g) ?? []).every((c) => containerClasses.includes(c.slice(1))));
  if (!rules.length) return null;
  rules.sort((a, b) => (specificity(a.selector) - specificity(b.selector)) || (a.order - b.order));
  const win = rules[rules.length - 1];
  return { selector: win.selector, value: win.decls[prop] };
}

const STREAMING = ['doc-inline-diff', 'doc-inline-diff--streaming'];
const REVIEW = ['doc-inline-diff'];

describe('doc-diff.css 层叠：最终生效值', () => {
  it('流式期间新增块不播逐元素进场动画（这是「一闪一闪像老电脑」的根因）', () => {
    // 正文每来一个 token 就整棵 DOM 重挂，动画被无限重启、永远播不完，
    // 已经写完的字一直在 0.35~0.66 的透明度之间抖。
    expect(winning('animation', 'ins', STREAMING)?.value).toBe('none');
  });

  it('改完待确认那一档保留进场动画：全篇 ins 一起浮现一次', () => {
    expect(winning('animation', 'ins', REVIEW)?.value).toContain('doc-diff-ins-in');
  });

  it('流式期间原文只压灰，不划红删除线', () => {
    expect(winning('text-decoration', 'del', STREAMING)?.value).toBe('none');
    expect(winning('background', 'del', STREAMING)?.value).toBe('transparent');
    // 完成态才是删除线
    expect(winning('text-decoration', 'del', REVIEW)?.value).toBe('line-through');
  });

  it('覆盖不许靠行号成立：流式规则的特异性必须严格高于基础规则', () => {
    const streamingIns = winning('animation', 'ins', STREAMING)!.selector;
    const baseIns = parseRules(stripAtBlocks(CSS))
      .find((r) => r.decls.animation && !r.selector.includes('--streaming'))!.selector;
    expect(specificity(streamingIns)).toBeGreaterThan(specificity(baseIns));
  });
});
