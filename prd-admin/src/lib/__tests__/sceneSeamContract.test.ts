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
  /** 拍号 → 这一拍指针指着谁 */
  targetAt: Map<number, string>;
  /** 旁白第 i 句 → 哪几拍在念它（NARRATION_AT 不为空时才会不等于恒等映射）。 */
  beatsOfLine: Map<number, number[]>;
  /** GATED 里声明的拍号：这些拍要等「手真的到位」才开始 */
  gatedAt: Set<number>;
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
    const targetAt = new Map<number, string>();
    for (const m of src.matchAll(/(?:\[B\.(\w+)\]|\w+ === B\.(\w+))\s*[?:]\s*\{([^{}]*)\}/g)) {
      const key = m[1] ?? m[2];
      if (!(key in beats)) continue;
      const body = m[3];
      if (/press:\s*true/.test(body)) pressedAt.add(beats[key]);
      // 目标可能是常量 'x' 或模板 `style-${aim}` —— 模板取它的静态前缀，
      // 前缀相同就算「指着同一个东西」（换风格那两拍就是同一枚 chip）
      const lit = /target:\s*'([a-z0-9-]+)'/.exec(body)?.[1]
        ?? /target:\s*`([a-z0-9-]+)\$\{/.exec(body)?.[1];
      if (lit) targetAt.set(beats[key], lit);
    }
    // 有 NARRATION_AT 就按它映射；没有就是拍号与句号一一对应
    const beatsOfLine = new Map<number, number[]>();
    const nar = /const NARRATION_AT = \[([^\]]*)\]/.exec(src)?.[1];
    if (nar) {
      nar.split(',').map((x) => Number(x.trim())).forEach((line, beat) => {
        if (!Number.isFinite(line)) return;
        beatsOfLine.set(line, [...(beatsOfLine.get(line) ?? []), beat]);
      });
    } else {
      Object.values(beats).forEach((b) => beatsOfLine.set(b, [b]));
    }
    const gatedAt = new Set<number>();
    const g = /const GATED = new Set<number>\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? '';
    for (const m of g.matchAll(/B\.(\w+)/g)) if (m[1] in beats) gatedAt.add(beats[m[1]]);

    out.push({ file: name, i18nPath: i18n, beats, pressedAt, targetAt, beatsOfLine, gatedAt });
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
        // 一句旁白可能横跨几拍（走位空拍沿用上一句），其中任意一拍按下即可
        const owning = s.beatsOfLine.get(i) ?? [i];
        if (owning.some((b) => s.pressedAt.has(b))) return;
        missing.push(`${s.file} 旁白第 ${i} 句「${line}」含动作词「${verb}」，`
          + `对应第 ${owning.join('/')} 拍，都没有按下`);
      });
    }
    expect(
      missing,
      '旁白宣称有人点了，画面上却没有任何东西被点 —— 看的人只会觉得「东西自己在变」。\n'
        + '要么给这一拍补一个指针按下，要么把旁白改成不宣称动作的写法。\n'
        + missing.join('\n'),
    ).toEqual([]);
  });

  /**
   * 「先走到，再发生」的机械判据。
   *
   * 上一版只延迟了波纹，**没延迟事情本身** —— 视觉幕第 2 拍消息在第 0 毫秒就发出去了，
   * 指针才刚从输入框起步，看的人一眼就看见「还没点到就发送了」。
   * 波纹晚响救不了这个：晚响的是反馈，早发生的是结果。
   *
   * 唯一靠谱的形态是**上一拍指针就已经停在那个目标上**，到点这一拍是原地按下。
   * 于是「效果和按下同时发生」也不再有问题 —— 因为手本来就在那儿。
   *
   * 连着两次点不同目标时，中间必须插一拍让手走过去，不能靠「按下时顺便飞过去」。
   */
  it('每一次按下的那一拍，都必须是 gated（等手真的到位才开始）', () => {
    const ungated: string[] = [];
    for (const s of scenes) {
      for (const at of [...s.pressedAt].sort((a, b) => a - b)) {
        if (s.gatedAt.has(at)) continue;
        const name = Object.keys(s.beats).find((k) => s.beats[k] === at) ?? String(at);
        ungated.push(`${s.file} 第 ${at} 拍(${name}) 按 [${s.targetAt.get(at) ?? '?'}]，但不在 GATED 里`);
      }
    }
    expect(
      ungated,
      '按下那一拍如果由时钟直接进入，「手开始走」和「事情发生」就是同一毫秒 —— '
        + '指针飞过去要走位时长，观众必然看到「还没点到就已经生效」。\n'
        + '曾经试过插「走位空拍」错开，但那把正确性挂在手调的毫秒数上：'
        + '走位时长一改，空拍就不够了，bug 悄悄回来。\n'
        + '正解是把这一拍放进 GATED —— 手真的落到目标上才开始，时序由结构保证。\n'
        + ungated.join('\n'),
    ).toEqual([]);
  });

  /**
   * 产物必须有作者。
   *
   * 前面几条守的都是「点击」这一侧：有没有手、指着谁、来不来得及。守不到的是另一侧 ——
   * **一个本该由用户产出的东西，凭空出现了**。视觉幕第二条用户消息就是这样：
   * 没人打字、没人按发送，「把这两张混一下」自己浮在对话里。用户一眼看出来，
   * 而三条守卫全绿 —— 因为那一拍的旁白里没有点击动词，判据根本不看它。
   *
   * 所以换一个提问方式：**先数产物，再问谁做的**。对话里每出现一条用户消息，
   * 就必须有一次发送键上的按下与之配对。多出来的那条就是没有作者的那条。
   */
  it('每一条用户消息都要有一次发送与之配对', () => {
    const orphan: string[] = [];
    for (const name of fs.readdirSync(SCENES_DIR)) {
      if (!name.endsWith('.tsx')) continue;
      const src = fs.readFileSync(path.join(SCENES_DIR, name), 'utf8');
      const bubbles = [...src.matchAll(/<Bubble\s+side="user"/g)].length;
      if (!bubbles) continue;
      const sends = [...src.matchAll(/target:\s*'chat-send',[^}]*press:\s*true/g)].length;
      if (bubbles === sends) continue;
      orphan.push(`${name}: ${bubbles} 条用户消息，只有 ${sends} 次发送 —— `
        + `多出来的消息没有作者，是凭空淡入的`);
    }
    expect(
      orphan,
      '对话里出现一条用户消息，就意味着「有人打了字、按了发送」。'
        + '少一次发送就有一条消息是自己冒出来的 —— 看的人一眼就看出来了。\n'
        + orphan.join('\n'),
    ).toEqual([]);
  });

  it('GATED 里的每一拍都真的有按下（别把不点击的拍也拦住）', () => {
    const idle: string[] = [];
    for (const s of scenes) {
      for (const at of s.gatedAt) {
        if (s.pressedAt.has(at)) continue;
        const name = Object.keys(s.beats).find((k) => s.beats[k] === at) ?? String(at);
        idle.push(`${s.file} 第 ${at} 拍(${name}) 在 GATED 里，却没有按下 —— 白等一次到位`);
      }
    }
    expect(idle, idle.join('\n')).toEqual([]);
  });
});
