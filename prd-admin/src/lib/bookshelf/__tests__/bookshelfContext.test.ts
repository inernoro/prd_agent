import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VOLUMES } from '../catalog';

/**
 * 书目上下文的生成器兼守卫。
 *
 * ## 为什么后端要单独存一份
 *
 * 精读稿由后端调模型生成。拼 prompt 需要「这本书是什么 + 它对应我们哪几条规则」，
 * 而这份数据在前端 `catalog.ts` 里。三条路只有一条走得通：
 *
 * 1. 前端把上下文随请求发给后端 —— **不行**。稿子是公共内容，所有人读同一篇；
 *    上下文可篡改就等于任何登录用户都能往公共内容里注入任意 prompt。
 * 2. 后端手抄一份 —— 不行，必然漂移，而且漂移了没人会发现。
 * 3. 从 catalog 生成一份资源给后端读，**并用守卫钉住它和源头一致** —— 就是这条。
 *
 * ## 怎么用
 *
 * 改过 catalog.ts 或规则文件之后，这条会红，跑一次：
 *   UPDATE_BOOKSHELF_CONTEXT=1 pnpm vitest run src/lib/bookshelf/__tests__/bookshelfContext.test.ts
 * 生成的 JSON 必须跟着一起提交（照抄 themeHardcodeRatchet 的基线更新模式）。
 */

const REPO = path.resolve(__dirname, '../../../../..');
const RULES_DIR = path.join(REPO, '.claude/rules');
const OUT = path.join(REPO, 'prd-api/src/PrdAgent.Api/Resources/bookshelf-context.json');

/** 从一条规则里抽出「给模型看的那部分」：导读两行 + 历史背景（真实事故） */
function readRule(name: string) {
  const file = path.join(RULES_DIR, `${name}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? name).trim();
  const oneLine = (text.match(/^\*\*一句话\*\*：(.+)$/m)?.[1] ?? '').trim();
  const whenHit = (text.match(/^\*\*什么时候撞上\*\*：(.+)$/m)?.[1] ?? '').trim();

  /*
   * 历史背景是这份上下文里最值钱的一段：它记着我们自己真实踩过的那次事故。
   * 精读稿里「这本书讲的事我们在哪儿栽过」全靠它 —— 没有它，稿子就退回成网上
   * 到处都是的书摘。
   *
   * 标题写法一共见到 19 种（`## 历史背景`、`## 六、历史背景`、`## 一、这条规则的由来`、
   * `## 反面案例（真实发生过）`、`## 事故台账`…）。第一版只认「## 历史背景」，结果两条
   * 规则全抽成空 —— 判据比它要管的范围窄，本仓库的老毛病。这里按**关键词**认，不按固定格式认。
   *
   * 另外要接受「有些规则本来就没有这一段」（`no-rootless-tree` 就是纯原则式的），
   * 抽不到不算错误，但下面那条判据会逼着填映射的人至少挑一条有故事的。
   */
  const bg = text.match(
    // `$` 在 m 标志下是**行尾**不是文末，写 `(?=\n##\s|$)` 会让非贪婪捕获在第一个位置
    // 就满足而捕获到空串 —— 第二版栽在这儿，标题匹配上了、正文一个字没抽出来。
    // 文末要用 `(?![\s\S])`。60 条规则里 40 条抽得出故事，其余 20 条是纯原则式的。
    /^##[^\n]*(?:历史背景|由来|真实案例|反面案例|事故台账|教训|本次痛点)[^\n]*\n([\s\S]*?)(?=\n##\s|(?![\s\S]))/m,
  );
  return {
    name,
    title,
    oneLine,
    whenHit,
    // 截断：喂给模型的是「够它讲清楚那次事故」，不是整条规则。太长会把书本身挤掉。
    history: (bg?.[1] ?? '').trim().slice(0, 1200),
  };
}

function build() {
  const rulesUsed = new Map<string, ReturnType<typeof readRule>>();
  const volumes = VOLUMES.map((v) => ({
    id: v.id,
    index: v.index,
    name: v.name,
    subtitle: v.subtitle,
    painQuote: v.painQuote,
    cure: v.cure,
    books: v.books.map((b) => {
      (b.relatedRules ?? []).forEach((r) => { if (!rulesUsed.has(r)) rulesUsed.set(r, readRule(r)); });
      return {
        id: b.id,
        title: b.title,
        original: b.original ?? null,
        author: b.author,
        track: b.track,
        level: b.level,
        why: b.why,
        takeaway: b.takeaway,
        relatedRules: b.relatedRules ?? [],
      };
    }),
  }));
  return {
    note: '由 prd-admin 的 bookshelfContext.test.ts 生成，勿手改。源头是 catalog.ts 与 .claude/rules/。',
    volumes,
    rules: [...rulesUsed.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe('书目上下文（后端精读稿用）', () => {
  it('与 catalog.ts 和规则文件保持一致', () => {
    const built = build();
    const serialized = `${JSON.stringify(built, null, 2)}\n`;

    if (process.env.UPDATE_BOOKSHELF_CONTEXT === '1') {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, serialized, 'utf8');
      return;
    }

    expect(fs.existsSync(OUT), `后端上下文还没生成：${OUT}\n跑一次 UPDATE_BOOKSHELF_CONTEXT=1 生成`).toBe(true);
    const current = fs.readFileSync(OUT, 'utf8');
    // 比的是整份内容而不是某几个字段：漂移可能出现在任何一处，
    // 挑字段比等于给漏掉的那些字段发了通行证。
    expect(
      current === serialized,
      '后端的书目上下文与 catalog.ts / 规则文件不一致了。\n'
        + '跑：UPDATE_BOOKSHELF_CONTEXT=1 npx vitest run src/lib/bookshelf/__tests__/bookshelfContext.test.ts\n'
        + '并把生成的 JSON 一起提交。',
    ).toBe(true);
  });

  it('被引用的规则都抽到了导读两行（抽不到说明规则格式变了）', () => {
    const empty = build().rules.filter((r) => !r.oneLine || !r.whenHit).map((r) => r.name);
    expect(empty, `这些规则没抽到「一句话 / 什么时候撞上」：${empty.join('、')}`).toEqual([]);
  });

  /*
   * 每本填了映射的书，至少要有一条规则带得出真实故事。
   *
   * 精读稿的卖点就是最后那一段「这本书讲的事我们在哪儿栽过」。关联的规则全是纯原则、
   * 一个事故都没有的话，那一段就只能空着或者让模型编 —— 而编出来的假事故，
   * 比没有这一段糟得多（读者会照着去翻，然后发现仓库里根本没这回事）。
   */
  it('每本关联了规则的书，至少有一条规则带真实故事', () => {
    const ctx = build();
    const byName = new Map(ctx.rules.map((r) => [r.name, r]));
    const bad: string[] = [];
    ctx.volumes.forEach((v) => v.books.forEach((b) => {
      if (b.relatedRules.length === 0) return;
      const anyStory = b.relatedRules.some((n) => (byName.get(n)?.history?.length ?? 0) > 0);
      if (!anyStory) bad.push(`${b.id}（${b.relatedRules.join('、')}）`);
    }));
    expect(
      bad,
      '这些书关联的规则全都没有「历史背景 / 由来 / 事故台账」那一段，精读稿最后一节会无米下锅：'
        + bad.join('，'),
    ).toEqual([]);
  });
});
