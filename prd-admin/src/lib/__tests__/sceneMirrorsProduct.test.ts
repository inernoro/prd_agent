import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守卫：**demo 里演的功能，真实页面得真有。**
 *
 * 首页每一幕都声称自己是某个真实页面的复刻。但「复刻」这件事在源码里没有任何
 * 约束——我可以随手加一条真实页面没有的顶栏、或者一个它根本不支持的交互，
 * 编译过、测试绿、通读也挑不出来，因为**多出来的东西不会让任何断言变红**。
 *
 * 已经这样错过两次，都是用户一眼看出来的：
 *   · 文学创作 demo 顶部加了一条「风格 沉静/暖光/林间/夜航」切换条 ——
 *     真实编辑器顶部只有「返回 + 文件名 + 模型切换器」，风格是右侧配置行的一枚 pill。
 *   · 文学创作 demo 里做了「鼠标划中一句话」的选区 —— 那是知识库 DocBrowser 的功能，
 *     `ArticleIllustrationEditorPage` 里 `getSelection` 一处都没有。
 *
 * 完整的「一比一对照」没法机械化，但**特性级**可以：给每个容易被凭空发明的
 * 交互特性登记一条「真实页面必须出现的证据串」，幕里用了这个特性，
 * 它 MIRRORS 指向的那个文件里就必须找得到证据。找不到 = 这个功能是编的。
 *
 * 这张表是增量的：以后每被抓到一次「demo 有、产品没有」，就往里加一行，
 * 而不是只把那一处删掉了事。
 */

const SCENES_DIR = path.resolve(__dirname, '../../pages/home/scenes');
const REPO_SRC = path.resolve(__dirname, '../..');

interface FeatureRule {
  /** 幕里怎么算「用了这个特性」 */
  used: RegExp;
  label: string;
  /** 真实页面里必须出现的证据串（能证明这个能力确实存在） */
  evidence: string;
  why: string;
}

const FEATURES: FeatureRule[] = [
  {
    used: /<SelectionSweep/,
    label: '鼠标划词选区',
    evidence: 'getSelection',
    why: '划词要真实页面自己处理文本选择；没有 getSelection 就是没有这个功能',
  },
];

function scenes() {
  return fs.readdirSync(SCENES_DIR)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(SCENES_DIR, f), 'utf8') }))
    .map((x) => ({ ...x, mirrors: /export const MIRRORS = '([^']+)'/.exec(x.src)?.[1] ?? null }));
}

describe('首页各幕与真实页面的对照', () => {
  const all = scenes();

  it('声明了 MIRRORS 的幕，指向的文件真的存在', () => {
    const missing = all.filter((s) => s.mirrors).filter((s) => !fs.existsSync(path.resolve(REPO_SRC, '..', s.mirrors!)));
    expect(
      missing.map((s) => `${s.file} -> ${s.mirrors}（文件不存在）`),
      'MIRRORS 指向的真实页面找不到 —— 要么路径写错，要么那个页面已经被删/改名，'
        + '对照关系已经断了',
    ).toEqual([]);
  });

  it('至少三幕声明了 MIRRORS（别因为一条都没扫到就空跑成绿灯）', () => {
    expect(all.filter((s) => s.mirrors).length).toBeGreaterThanOrEqual(3);
  });

  it('幕里演的特性，真实页面必须真有', () => {
    const invented: string[] = [];
    for (const s of all) {
      for (const f of FEATURES) {
        if (!f.used.test(s.src)) continue;
        if (!s.mirrors) {
          invented.push(`${s.file} 用了「${f.label}」，但没声明 MIRRORS —— 无从核对它是不是真的存在`);
          continue;
        }
        const real = path.resolve(REPO_SRC, '..', s.mirrors);
        const realSrc = fs.existsSync(real) ? fs.readFileSync(real, 'utf8') : '';
        if (realSrc.includes(f.evidence)) continue;
        invented.push(`${s.file} 演了「${f.label}」，但它复刻的 ${s.mirrors} 里找不到 ${f.evidence} —— `
          + `${f.why}。这个功能是编的，要么删掉，要么挪到真有它的那一幕`);
      }
    }
    expect(invented, invented.join('\n')).toEqual([]);
  });
});
