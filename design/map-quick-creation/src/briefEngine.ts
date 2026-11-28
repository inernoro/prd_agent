/* 原型的对话起稿引擎（只用于原型，不进源码差异）。
 * 正式实现由服务端的模型完成：每轮按简报缺什么问一个问题、给可点的回答、推荐风格并说明理由；
 * 「可以开始了」等开工意图由模型结构化判定。原型用固定的几条路线演示同样的形状。 */
import type { BriefContext, DurationChoice, QcBrief, QcBriefField, QcBriefSession, QcChatMessage, QcScriptScene, QcStyleRec, QcTemplate } from '@/pages/quick-creation-agent/types';
import { CHARS_PER_SEC, estimate, scenesFor } from './estimate';
import { attachmentQueue, sampleDoc, templates } from './fixtures';

type Awaiting = 'topic' | 'audience' | 'duration' | 'tone' | 'style' | null;
interface Slots { kindHint?: string; topic?: string; audience?: string; tone?: string; styleChosen?: boolean; recs?: QcStyleRec[]; awaiting: Awaiting; durationAsked?: boolean; durationSaid?: boolean }
interface Session { id: string; messages: QcChatMessage[]; slots: Slots; context: BriefContext }

const sessions = new Map<string, Session>();
let seq = 0;
let msgSeq = 0;
const MODEL = { model: 'deepseek-v3', platform: '模型池「创作对话」' };
const style = (id?: string): QcTemplate | undefined => templates.find(t => t.id === id);
const docs = (ctx: BriefContext) => [sampleDoc, ...attachmentQueue].filter(a => ctx.attachmentIds.includes(a.id) && a.kind !== 'image' && a.status === 'ready');

const REC: Record<string, QcStyleRec[]> = {
  科技感: [
    { templateId: 'dark-keynote', reason: '暗场发布会的节奏，产品一项项亮相，适合新品宣传' },
    { templateId: 'glass-product', reason: '玻璃质感特写，把注意力全放在产品本身' },
    { templateId: 'hologram-hud', reason: '全息界面的未来感，适合讲功能和数据' },
  ],
  活泼有趣: [
    { templateId: 'brick-toy', reason: '积木小世界，轻松好记，适合面向大众' },
    { templateId: 'memphis-diorama', reason: '孟菲斯配色的微缩场景，年轻有活力' },
    { templateId: 'pixel-rpg', reason: '像素游戏的闯关感，适合讲成长与步骤' },
  ],
  稳重专业: [
    { templateId: 'swiss-motion', reason: '瑞士网格与大字排版，干净可信' },
    { templateId: 'news-package', reason: '电视新闻包装，权威、信息密度高' },
    { templateId: 'white-model', reason: '白模投影讲空间与流程，克制专业' },
  ],
};

const LADDER: Exclude<DurationChoice, 'auto'>[] = [60, 180, 300, 600];
const fmtMin = (sec: number) => (sec < 60 ? `${sec} 秒` : `${Math.round(sec / 60)} 分钟`);
const est = (s: Session) => estimate({ kind: s.context.kind, docs: docs(s.context), duration: s.context.duration ?? 'auto' });

function brief(s: Session): QcBrief {
  const d = docs(s.context);
  const e = est(s);
  const choice = s.context.duration ?? 'auto';
  const st = style(s.context.templateId);
  const content = d.length ? { value: d[0].name.replace(/\.(md|markdown|txt)$/i, ''), source: 'doc' as const } : s.slots.topic ? { value: s.slots.topic, source: 'chat' as const } : undefined;
  const fields: QcBriefField[] = [
    { key: 'output', label: '做成什么', required: true, value: s.context.kind === 'video' ? '视频' : '网页', source: 'pick' },
    { key: 'content', label: '讲什么', required: true, ...(content ?? {}) },
    { key: 'style', label: '风格', required: true, ...(st ? { value: s.slots.styleChosen ? st.name : `${st.name}（默认，可换）`, source: s.slots.styleChosen ? 'chat' as const : 'default' as const } : {}) },
    { key: 'audience', label: '给谁看', required: false, ...(s.slots.audience ? { value: s.slots.audience, source: 'chat' as const } : {}) },
    { key: 'duration', label: '时长', required: false, value: s.context.kind === 'video' ? `约 ${fmtMin(e.targetSec)}${choice === 'auto' ? '（自动）' : ''}` : '4–5 节（默认）', source: choice === 'auto' ? 'default' : s.slots.durationSaid ? 'chat' : 'pick' },
  ];
  const missing = fields.filter(f => f.required && !f.value).map(f => f.label);
  const title = content?.value;
  const summary = title ? [
    `${s.context.kind === 'video' ? '视频' : '网页'}：${title}${s.slots.audience ? `，给${s.slots.audience}看` : ''}${s.slots.tone ? `，${s.slots.tone}` : ''}`,
    st ? `风格：${st.name}；${s.context.kind === 'video' ? `约 ${fmtMin(e.targetSec)}、${e.scenes} 幕，女声配音；生成约 ${e.generateMin[0]}–${e.generateMin[1]} 分钟` : '4–5 节，适配手机'}` : '',
    content?.source === 'chat' ? '没有稿件：文案由快速创作按对话先写，开工前给你看分镜脚本' : '',
  ].filter(Boolean).join('\n') : undefined;
  return { fields, ready: missing.length === 0, missing, title, summary };
}

function view(s: Session): QcBriefSession {
  return { id: s.id, messages: s.messages, brief: brief(s), model: MODEL, ...(s.context.templateId ? { styleId: s.context.templateId } : {}), durationChoice: s.context.duration ?? 'auto' };
}

function session(id: string | undefined, context: BriefContext): Session {
  let s = id ? sessions.get(id) : undefined;
  if (!s) { seq += 1; s = { id: `brief-${seq}`, messages: [], slots: { awaiting: null }, context }; sessions.set(s.id, s); }
  s.context = context;
  return s;
}

const agent = (m: Omit<QcChatMessage, 'id' | 'role'>): QcChatMessage => { msgSeq += 1; return { id: `m${msgSeq}`, role: 'agent', ...m }; };

/* 按目标时长写脚本：幕数 = 目标 ÷ 每幕约 14 秒；每幕旁白字数 = 每幕秒数 × 配音语速。
 * 正式实现由模型写，服务端用同一个公式校验总时长，差得多就补写或压缩，不交给模型自觉。 */
const BEATS = [
  ['片头：「{t}」大字出现', '{who}，花几分钟带你把{t}讲清楚。'],
  ['提出问题：现在大家卡在哪', '先说说为什么要做这件事，大家平时最容易卡在哪一步。'],
  ['第一个要点：概念图', '第一个要点：先把目标说成一句话，让所有人对齐要解决的问题。'],
  ['第一个要点：一个真实例子', '举个例子，上周的评审里，目标写成三段，大家各说各的，最后改了两轮。'],
  ['第二个要点：前后对比', '第二个要点：把不做的事写下来，范围清楚了，讨论就不会跑偏。'],
  ['第二个要点：清单动画', '具体可以这样做：列出这次不做的三件事，每件写一句为什么。'],
  ['第三个要点：验收标准', '第三个要点：验收标准要能被别人照着检查，而不是写给自己看的。'],
  ['第三个要点：照着检查的演示', '我们照着这条标准走一遍：打开页面、点一下、看到结果，就算通过。'],
  ['常见问题：问与答', '新同事常问：评审前要准备什么？其实读一遍目标和边界就够了。'],
  ['小结：三点回顾', '回顾一下：目标一句话、写明不做的事、验收能照着检查。'],
  ['收尾：一句口号与下一步', '{t}，现在就可以用起来。'],
];

/* 补足字数用的细节句：按顺序取，不在同一幕里重复 */
const DETAILS = [
  '这一步不难，难的是每次都记得做。', '我们用一个真实的例子来看。', '注意看画面右边的变化。', '很多人在这里会跳过，结果后面返工。',
  '做到这一点，讨论时间能省下一半。', '你可以先在下一次评审里试一次。', '把它写进模板，就不用每次重新想。', '如果只记住一句话，就记这句。',
  '这里有个小技巧：先写结论，再写原因。', '换个角度看，这其实是在帮评审的人省时间。', '下面这张清单可以直接照着用。', '做完之后，花一分钟回头检查一遍。',
];

function script(s: Session): QcScriptScene[] {
  const b = brief(s);
  const t = b.title ?? '这次的主题';
  const who = s.slots.audience ?? '大家';
  const target = est(s).targetSec;
  const n = scenesFor(target);
  const perScene = Math.round((target * CHARS_PER_SEC) / n);
  let detail = 0;
  return Array.from({ length: n }, (_, i) => {
    const beat = i === 0 ? BEATS[0] : i === n - 1 ? BEATS[BEATS.length - 1] : BEATS[1 + ((i - 1) % (BEATS.length - 2))];
    const round = i === 0 || i === n - 1 ? 0 : Math.floor((i - 1) / (BEATS.length - 2));
    const fill = (x: string) => x.replace(/\{t\}/g, t).replace(/\{who\}/g, who);
    /* 原型用固定句子拼到目标字数；秒数由字数按配音语速算出 */
    let narration = fill(beat[1]);
    while (narration.length < perScene * 0.85) { narration += DETAILS[detail % DETAILS.length]; detail += 1; }
    return { index: i + 1, visual: fill(beat[0]) + (round ? `（续 ${round + 1}）` : ''), narration, seconds: Math.max(4, Math.round(narration.length / CHARS_PER_SEC)) };
  });
}

function next(s: Session): QcChatMessage {
  const b = brief(s);
  if (!b.fields.find(f => f.key === 'content')?.value) {
    s.slots.awaiting = 'topic';
    return agent({ text: '想做的内容是什么？有稿件可以放进来，没有也行，用一两句话告诉我要讲的事。', quickReplies: ['新产品发布', '公司年会', '招聘宣传'] });
  }
  if (!s.slots.audience) {
    s.slots.awaiting = 'audience';
    return agent({ text: '主要给谁看、在哪里放？', quickReplies: ['客户', '新员工', '展会现场观众'] });
  }
  /* 培训、教程类最容易被做短：问一次想要多长，给出按内容估算的建议 */
  if (s.context.kind === 'video' && !s.slots.durationAsked && !s.slots.durationSaid && /培训|教程|课程|教学|新同事|上手/.test(`${s.slots.topic ?? ''}${docs(s.context).map(a => a.name).join('')}`)) {
    s.slots.durationAsked = true;
    s.slots.awaiting = 'duration';
    const e = est(s);
    return agent({ text: `想要多长？教程类讲清楚一般要 3–5 分钟。不选的话按内容自动，现在估算约 ${fmtMin(e.autoSec)}。`, quickReplies: ['约 3 分钟讲清楚', '约 5 分钟一步步教', '约 1 分钟讲重点', '按内容自动'] });
  }
  if (!s.slots.styleChosen) {
    s.slots.awaiting = 'tone';
    return agent({ text: '想要什么感觉？我按感觉推荐风格。', quickReplies: ['稳重专业', '活泼有趣', '科技感'] });
  }
  s.slots.awaiting = null;
  return agent({ text: '必填的都齐了，下面是我理解的这一支。没问题就点「开始生成」，或者直接说「可以开始了」；想改哪里也可以接着说。', ready: true });
}

function reply(s: Session, text: string): QcChatMessage {
  const t = text.trim();
  if (/可以开始|开始吧|开始生成|就这样|开工/.test(t)) {
    const b = brief(s);
    if (!b.ready) {
      const m = next(s);
      return { ...m, text: `还不能开始：还缺${b.missing.join('、')}。${m.text}`, missingNote: true };
    }
    s.slots.awaiting = null;
    return scriptMessage(s);
  }
  const mins = t.match(/(\d+|一|三|五|十)\s*分钟/);
  if (s.context.kind === 'video' && (mins || /自动|长一点|短一点|长一些|短一些/.test(t)) && (s.slots.awaiting === 'duration' || mins || /长一点|短一点|长一些|短一些/.test(t))) {
    const cur = est(s).targetSec;
    const zh: Record<string, number> = { 一: 1, 三: 3, 五: 5, 十: 10 };
    const asked = mins ? (zh[mins[1]] ?? Number(mins[1])) * 60 : undefined;
    const choice: DurationChoice = /自动/.test(t) && !mins ? 'auto'
      : asked ? LADDER.reduce((a, b) => (Math.abs(b - asked) < Math.abs(a - asked) ? b : a))
      : /长/.test(t) ? (LADDER.find(x => x > cur) ?? 600) : ([...LADDER].reverse().find(x => x < cur) ?? 60);
    s.context = { ...s.context, duration: choice };
    s.slots.durationSaid = choice !== 'auto';
    s.slots.durationAsked = true;
    return next(s);
  }
  const ordinal = t.match(/第\s*([一二三123])\s*个/);
  const named = templates.find(x => t.includes(x.name));
  if ((s.slots.awaiting === 'style' || /就用|用这个/.test(t)) && (ordinal || named)) {
    const idx = ordinal ? '一二三'.includes(ordinal[1]) ? '一二三'.indexOf(ordinal[1]) : Number(ordinal[1]) - 1 : -1;
    const pick = idx >= 0 ? s.slots.recs?.[idx]?.templateId : named?.id;
    if (pick) { s.context = { ...s.context, templateId: pick }; s.slots.styleChosen = true; }
    return next(s);
  }
  if (/宣传片|宣传/.test(t) && !s.slots.kindHint) {
    s.slots.kindHint = '宣传片';
    s.slots.awaiting = 'topic';
    return agent({ text: '好的，做一支宣传片。宣传的是什么？', quickReplies: ['新产品发布', '公司年会', '招聘宣传'] });
  }
  if (s.slots.awaiting === 'topic' || (!s.slots.topic && !docs(s.context).length && !/风格|推荐|不知道/.test(t))) {
    s.slots.topic = s.slots.kindHint ? `${s.slots.kindHint}：${t}` : t;
    return next(s);
  }
  if (s.slots.awaiting === 'audience') { s.slots.audience = t; return next(s); }
  if (s.slots.awaiting === 'tone' || /稳重|活泼|科技/.test(t)) {
    s.slots.tone = /科技/.test(t) ? '科技感' : /活泼|有趣/.test(t) ? '活泼有趣' : '稳重专业';
    s.slots.recs = REC[s.slots.tone];
    s.slots.awaiting = 'style';
    return agent({ text: `按「${s.slots.tone}」挑了 3 个风格，点「用这个风格」，或者说「第二个」。想看全部，点「全部 99 种」。`, recommendations: s.slots.recs });
  }
  if (/风格|推荐|不知道/.test(t)) return next(s);
  return next(s);
}

export function briefMessage(body: { sessionId?: string; text: string; context: BriefContext }): QcBriefSession {
  const s = session(body.sessionId, body.context);
  msgSeq += 1;
  s.messages.push({ id: `m${msgSeq}`, role: 'user', text: body.text });
  s.messages.push(reply(s, body.text));
  return view(s);
}

export function briefContext(body: { sessionId?: string; context: BriefContext }): QcBriefSession {
  const s = session(body.sessionId, body.context);
  /* 在输入框或右栏里手动选了风格，也算选定 */
  if (body.context.templateId && s.slots.recs && !s.slots.recs.some(r => r.templateId === body.context.templateId)) s.slots.styleChosen = true;
  return view(s);
}

function scriptMessage(s: Session, adjusted?: 'shorter' | 'longer'): QcChatMessage {
  const e = est(s);
  const sc = script(s);
  const total = sc.reduce((n, x) => n + (x.seconds ?? 0), 0);
  const lead = adjusted ? `改成约 ${fmtMin(e.targetSec)}，重写了这版脚本：` : '好，先出一版分镜脚本给你看：';
  return agent({ text: `${lead}${sc.length} 幕，合计约 ${Math.floor(total / 60)} 分 ${total % 60} 秒。确认后正式排队，生成约 ${e.generateMin[0]}–${e.generateMin[1]} 分钟。`, script: sc, scriptTargetSec: e.targetSec });
}

export function briefScript(id: string, context: BriefContext, adjust?: 'shorter' | 'longer'): QcBriefSession | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  s.context = context;
  const b = brief(s);
  if (!b.ready) { s.messages.push({ ...next(s), missingNote: true }); return view(s); }
  if (adjust) {
    const cur = est(s).targetSec;
    const choice = adjust === 'longer' ? (LADDER.find(x => x > cur) ?? 600) : ([...LADDER].reverse().find(x => x < cur) ?? 60);
    s.context = { ...s.context, duration: choice };
    msgSeq += 1;
    s.messages.push({ id: `m${msgSeq}`, role: 'user', text: adjust === 'longer' ? '长一点' : '短一点' });
  }
  s.messages.push(scriptMessage(s, adjust));
  return view(s);
}
