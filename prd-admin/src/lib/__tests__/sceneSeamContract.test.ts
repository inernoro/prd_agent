import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { translations } from '@/pages/home/i18n/landing';

/**
 * 衔接契约：**旁白说有人点了，画面上就得真有一只手点下去。**
 *
 * 首页每一幕都是「演给你看」。看的人判断真假只有一个依据 —— 所见即所得：
 * 旁白写「点了 AI 改写」，那一拍就该看见指针压上去、然后浮层才出现。
 * 现状是九幕有节拍、只有两幕有指针，另外几幕旁白照样写着「点」「划中」「选一个」，
 * 而画面上东西自己在变。这不是某一处的小瑕疵，是同一个洞开了六次。
 *
 * 这条守卫把它变成机械判据：扫每一幕的旁白，凡是出现**点击类动词**的那一拍，
 * 这一幕的走位表就必须在同一拍有一次 `press`。缺一处 CI 就红。
 *
 * 只管一个方向：有动词就必须有点击。反过来（点了但旁白没写动词）不算错 ——
 * 发送、换风格这类动作旁白常写结果而不写动作，照样该有手。
 *
 * 打字类动词（输入 / 敲 / 搜）**不进这张表**：那一拍指针该停在输入框上，
 * 但不该按下去，按下去反而成了假动作。指针在不在输入框上由 sceneCursorWiring 管。
 */

/**
 * 点击类动词。只收「必须有一次按下」的，打字类不收（理由见上）。
 *
 * 「点」必须带宾语或语气词才算动词 —— 光按单字匹配会把「配图锚点」「痛点榜」
 * 里的名词也判成点击（第一版就这么误报了文学幕一处）。宁可写长一点。
 */
const CLICK_VERBS: [RegExp, string][] = [
  [/点(?:了|一|下|进|击|开|运行|「)/, '点…'],
  [/划中/, '划中'],
  [/选中/, '选中'],
  [/选一个/, '选一个'],
  [/按下/, '按下'],
  [/勾选/, '勾选'],
  [/拖(?:进|到|动|拽)/, '拖…'],
];

const SCENES_DIR = path.resolve(__dirname, '../../pages/home/scenes');

interface SceneFacts {
  file: string;
  /** 旁白取自 i18n 的哪条路径，如 scenes.knowledge / tail.workflow */
  i18nPath: string;
  /** 拍名 → 拍号 */
  beats: Record<string, number>;
  /** 走位表里声明了按下的拍号 */
  pressedAt: Set<number>;
}

function readScenes(): SceneFacts[] {
  const out: SceneFacts[] = [];
  for (const name of fs.readdirSync(SCENES_DIR)) {
    if (!name.endsWith('.tsx')) continue;
    const src = fs.readFileSync(path.join(SCENES_DIR, name), 'utf8');
    if (!src.includes('useSceneTimeline')) continue;      // 没有节拍就没有衔接可言

    const i18n = /const s = t\.((?:scenes|tail)\.\w+)/.exec(src)?.[1];
    if (!i18n) continue;

    const beats: Record<string, number> = {};
    const bBlock = /const B = \{([\s\S]*?)\}\s*as const/.exec(src)?.[1] ?? '';
    for (const m of bBlock.matchAll(/(\w+)\s*:\s*(\d+)/g)) beats[m[1]] = +m[2];

    // 两种写法都认：走位表里的 `[B.x]: { press: true }`，
    // 和内联的 `beat === B.x ? { ..., press: true }`
    const pressedAt = new Set<number>();
    for (const m of src.matchAll(/(?:\[B\.(\w+)\]|beat === B\.(\w+))\s*[?:]\s*\{[^{}]*press:\s*true/g)) {
      const key = m[1] ?? m[2];
      if (key in beats) pressedAt.add(beats[key]);
    }
    out.push({ file: name, i18nPath: i18n, beats, pressedAt });
  }
  return out;
}

function narration(i18nPath: string): string[] {
  let node: unknown = translations.zh;
  for (const seg of i18nPath.split('.')) node = (node as Record<string, unknown>)[seg];
  const beats = (node as { beats?: unknown })?.beats;
  return Array.isArray(beats) ? (beats as string[]) : [];
}

describe('首页衔接契约（旁白说点了，就得真有手点）', () => {
  const scenes = readScenes();

  it('扫到了每一幕（别因为正则没匹配上就空跑成绿灯）', () => {
    // 会跳过的用例必须能看出它到底跑没跑：这里直接断言幕数下限
    expect(scenes.length, `只扫到 ${scenes.length} 幕，正则大概率没匹配上`).toBeGreaterThanOrEqual(8);
    for (const s of scenes) {
      expect(narration(s.i18nPath).length, `${s.file} 的旁白 ${s.i18nPath}.beats 取不到`).toBeGreaterThan(0);
    }
  });

  it('旁白写了点击动作的每一拍，走位表里都有一次按下', () => {
    const missing: string[] = [];
    for (const s of scenes) {
      const lines = narration(s.i18nPath);
      lines.forEach((line, i) => {
        const verb = CLICK_VERBS.find(([re]) => re.test(line))?.[1];
        if (!verb) return;
        if (s.pressedAt.has(i)) return;
        missing.push(`${s.file} 第 ${i} 拍「${line}」含动作词「${verb}」，但这一拍没有按下`);
      });
    }
    expect(
      missing,
      '旁白宣称有人点了，画面上却没有任何东西被点 —— 看的人只会觉得「东西自己在变」。\n'
        + '要么给这一拍补一个指针按下，要么把旁白改成不宣称动作的写法。\n'
        + missing.join('\n'),
    ).toEqual([]);
  });
});
