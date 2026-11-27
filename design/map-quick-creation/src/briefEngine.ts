/* 原型的对话起稿引擎（只用于原型，不进源码差异）。
 * 正式实现由服务端的模型完成：每轮按简报缺什么问一个问题、给可点的回答、推荐风格并说明理由；
 * 「可以开始了」等开工意图由模型结构化判定。原型用固定的几条路线演示同样的形状。 */
import type { BriefContext, QcBrief, QcBriefField, QcBriefSession, QcChatMessage, QcScriptScene, QcStyleRec, QcTemplate } from '@/pages/quick-creation-agent/types';
import { attachmentQueue, sampleDoc, templates } from './fixtures';

type Awaiting = 'topic' | 'audience' | 'tone' | 'style' | null;
interface Slots { kindHint?: string; topic?: string; audience?: string; tone?: string; styleChosen?: boolean; recs?: QcStyleRec[]; awaiting: Awaiting }
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

function brief(s: Session): QcBrief {
  const d = docs(s.context);
  const st = style(s.context.templateId);
  const content = d.length ? { value: d[0].name.replace(/\.(md|markdown|txt)$/i, ''), source: 'doc' as const } : s.slots.topic ? { value: s.slots.topic, source: 'chat' as const } : undefined;
  const fields: QcBriefField[] = [
    { key: 'output', label: '做成什么', required: true, value: s.context.kind === 'video' ? '视频' : '网页', source: 'pick' },
    { key: 'content', label: '讲什么', required: true, ...(content ?? {}) },
    { key: 'style', label: '风格', required: true, ...(st ? { value: s.slots.styleChosen ? st.name : `${st.name}（默认，可换）`, source: s.slots.styleChosen ? 'chat' as const : 'default' as const } : {}) },
    { key: 'audience', label: '给谁看', required: false, ...(s.slots.audience ? { value: s.slots.audience, source: 'chat' as const } : {}) },
    { key: 'duration', label: '时长', required: false, value: s.context.kind === 'video' ? '约 1 分钟（默认）' : '4–5 节（默认）', source: 'default' },
  ];
  const missing = fields.filter(f => f.required && !f.value).map(f => f.label);
  const title = content?.value;
  const summary = title ? [
    `${s.context.kind === 'video' ? '视频' : '网页'}：${title}${s.slots.audience ? `，给${s.slots.audience}看` : ''}${s.slots.tone ? `，${s.slots.tone}` : ''}`,
    st ? `风格：${st.name}；${s.context.kind === 'video' ? '约 1 分钟，女声配音' : '4–5 节，适配手机'}` : '',
    content?.source === 'chat' ? '没有稿件：文案由快速创作按对话先写，开工前给你看分镜脚本' : '',
  ].filter(Boolean).join('\n') : undefined;
  return { fields, ready: missing.length === 0, missing, title, summary };
}

function view(s: Session): QcBriefSession {
  return { id: s.id, messages: s.messages, brief: brief(s), model: MODEL, ...(s.context.templateId ? { styleId: s.context.templateId } : {}) };
}

function session(id: string | undefined, context: BriefContext): Session {
  let s = id ? sessions.get(id) : undefined;
  if (!s) { seq += 1; s = { id: `brief-${seq}`, messages: [], slots: { awaiting: null }, context }; sessions.set(s.id, s); }
  s.context = context;
  return s;
}

const agent = (m: Omit<QcChatMessage, 'id' | 'role'>): QcChatMessage => { msgSeq += 1; return { id: `m${msgSeq}`, role: 'agent', ...m }; };

function script(s: Session): QcScriptScene[] {
  const b = brief(s);
  const t = b.title ?? '这次的主题';
  const who = s.slots.audience ?? '观众';
  return [
    { index: 1, visual: `片头：「${t}」大字出现`, narration: `${who}，用一分钟带你看懂${t}。` },
    { index: 2, visual: '提出问题：现在大家遇到的麻烦', narration: '先说说我们为什么要做这件事。' },
    { index: 3, visual: '第一个亮点特写', narration: '第一，它解决了最常见的那一步。' },
    { index: 4, visual: '第二个亮点：前后对比', narration: '第二，原来要半天的事，现在几分钟。' },
    { index: 5, visual: '第三个亮点：真实场景', narration: '第三，放到真实场景里也一样好用。' },
    { index: 6, visual: '收尾：一句口号与联系方式', narration: `${t}，现在就可以开始。` },
  ];
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
    return agent({ text: '好，先出一版分镜脚本给你看。确认后正式排队，一支约 30–60 分钟。', script: script(s) });
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
    return agent({ text: `按「${s.slots.tone}」挑了 3 个风格，点「用这个」，或者说「第二个」。也可以在右栏风格库里看全部 99 种。`, recommendations: s.slots.recs });
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

export function briefScript(id: string, context: BriefContext): QcBriefSession | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  s.context = context;
  const b = brief(s);
  if (!b.ready) { s.messages.push({ ...next(s), missingNote: true }); return view(s); }
  s.messages.push(agent({ text: '好，先出一版分镜脚本给你看。确认后正式排队，一支约 30–60 分钟。', script: script(s) }));
  return view(s);
}
