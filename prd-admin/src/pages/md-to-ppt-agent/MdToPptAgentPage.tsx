import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  FileText,
  Globe,
  X,
  ChevronLeft,
  ChevronRight,
  Wand2,
  Send,
  Plus,
  Upload,
  BookOpen,
  Check,
  AlertCircle,
  RotateCcw,
  Pencil,
  Download,
  Maximize2,
  BoxSelect,
  History,
  ImagePlus,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { StreamingText } from '@/components/streaming/StreamingText';
import {
  type ClarifyQuestion,
  type MdToPptDiagEvent,
  type MdToPptRunSummary,
  type MdToPptTemplateItem,
  type OutlineSlide,
  streamMdToPptConvert,
  streamMdToPptPatch,
  publishMdToPpt,
  getMdToPptRun,
  getRecentMdToPptRuns,
  getMdToPptOutline,
  getMdToPptTemplates,
  createMdToPptTemplate,
  deleteMdToPptTemplate,
  prewarmMdToPpt,
} from '@/services/real/mdToPptService';
import { apiRequest } from '@/services/real/apiClient';
import { NextStepBar } from './NextStepBar';
import { SelectionFeedbackOverlay, type SelectionRectPct } from './SelectionFeedbackOverlay';

// ─── Types ───────────────────────────────────────────────────────────────────

type ChatRole = 'user' | 'assistant';

interface Attachment {
  name: string;
  content: string;
}

interface KbRef {
  storeName: string;
  entryTitle: string;
  content: string;
}

type MsgPhase = 'outline' | 'generating' | 'done' | 'error' | 'patching' | 'text';

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  phase?: MsgPhase;
  outline?: OutlineSlide[];
  totalPages?: number;
  summary?: string;
  runId?: string;
  attachments?: Attachment[];
  kbRefs?: KbRef[];
  error?: string;
}

/** 大纲工作稿：右侧编辑器的唯一数据源（状态机 outline-ready 阶段）。
    用户的每次手工编辑即时落进它并持久化（刷新回来还在这个状态），
    点「确认生成」前可以停留任意久。 */
interface OutlineDraft {
  /** 用户原始内容 + 附件 + 知识库（生成时的主上下文，调整大纲时保持不变） */
  sourceText: string;
  summary: string;
  totalPages: number;
  outline: OutlineSlide[];
  /** AI 觉得有歧义时给出的澄清问卷（最多 3 题） */
  clarify?: ClarifyQuestion[];
  clarifyAnswers?: Record<string, string | string[]>;
  clarifySent?: boolean;
}

interface SessionState {
  messages: ChatMessage[];
  activeRunId: string;
  theme: string;
  /** 选中的自定义模板 ID（null = 用官方主题 theme） */
  templateId?: string | null;
  /** 大纲工作稿（outline-ready 阶段的刷新恢复） */
  outlineDraft?: OutlineDraft | null;
}

interface KbStore {
  id: string;
  name: string;
  documentCount: number;
}

interface KbEntry {
  id: string;
  title: string;
  summary?: string;
  contentType: string;
}

const SESSION_KEY = 'md-to-ppt-chat-v1';

// dotBg/dotRing 用于预览工具栏的风格色点；preview 用于画廊迷你幻灯预览。
// 「风格」语义（2026-06-10 用户纠偏）：风格是 AI 生成 HTML 时参照的设计语言（提示词里的
// 设计 token + 字体 + 版式气质），切换风格 = 让 AI 按新风格整体重绘，
// 绝不是前端注入一层 !important CSS 把 AI 的设计盖掉换个皮。
// value 必须与后端 MdToPptController.ThemeTokens 的 case 一一对应。
interface ThemePreview {
  /** 迷你幻灯容器样式（背景可用渐变/格纸纹理） */
  style: CSSProperties;
  /** 标题主色 */
  ink: string;
  /** 强调色（eyebrow 条 / 角标数字） */
  accent: string;
  /** 标题字体（衬线/等宽主题用） */
  titleFontFamily?: string;
  /** 示例标题（表达该模板的内容气质） */
  sampleTitle: string;
  /** 右下角示例数字 + 注脚（让缩略图像一页真的幻灯） */
  stat: string;
  statLabel: string;
}

const THEME_OPTIONS: Array<{
  value: string;
  label: string;
  desc: string;
  dotBg: string;
  dotRing: string;
  preview: ThemePreview;
}> = [
  {
    value: 'tech-dark', label: 'Tech 极黑', desc: '深色代码感 + 霓虹绿强调，技术方案与发布首选',
    dotBg: '#0d1117', dotRing: '#7ee787',
    preview: {
      style: { background: 'linear-gradient(135deg, #0d1117 0%, #161b22 100%)' },
      ink: '#e6edf3', accent: '#7ee787',
      titleFontFamily: "'JetBrains Mono', ui-monospace, monospace",
      sampleTitle: '系统架构总览', stat: '99.9%', statLabel: 'UPTIME',
    },
  },
  {
    value: 'cobalt-grid', label: '钴蓝格纸', desc: '米白格纸 + 国际钴蓝，数据报告的理性气质',
    dotBg: '#F0EBDE', dotRing: '#1F2BE0',
    preview: {
      style: {
        background: '#F0EBDE',
        backgroundImage:
          'linear-gradient(rgba(31,43,224,0.10) 1px, transparent 1px), linear-gradient(90deg, rgba(31,43,224,0.10) 1px, transparent 1px)',
        backgroundSize: '14px 14px',
      },
      ink: '#16208f', accent: '#1F2BE0',
      sampleTitle: '季度数据报告', stat: '240%', statLabel: '同比增长',
    },
  },
  {
    value: 'editorial-ink', label: '纸墨编辑', desc: '纸面杂志排版，衬线标题与大段留白',
    dotBg: '#f1efea', dotRing: '#0a0a0b',
    preview: {
      style: { background: '#f1efea' },
      ink: '#0a0a0b', accent: '#b91c1c',
      titleFontFamily: "'Noto Serif SC', Georgia, serif",
      sampleTitle: '观点与论证', stat: '04', statLabel: 'CHAPTER',
    },
  },
  {
    value: 'warm-zine', label: '复古 Zine', desc: '复古拼贴暖调，创意提案的手作感',
    dotBg: '#C8B99A', dotRing: '#008F4D',
    preview: {
      style: { background: 'linear-gradient(160deg, #C8B99A 0%, #BFAD8C 100%)' },
      ink: '#2b2418', accent: '#008F4D',
      sampleTitle: '创意提案集', stat: 'No.7', statLabel: 'ISSUE',
    },
  },
  {
    value: 'swiss-minimal', label: 'Swiss 极简', desc: '瑞士网格极简，黑白灰 + 一抹克莱因蓝',
    dotBg: '#fafaf8', dotRing: '#002FA7',
    preview: {
      style: { background: '#fafaf8' },
      ink: '#111111', accent: '#002FA7',
      sampleTitle: '极简设计原则', stat: '03', statLabel: 'PRINCIPLES',
    },
  },
  {
    value: 'aurora-gradient', label: '极光渐变', desc: '深空极光渐变 + 玻璃卡片，未来感产品愿景',
    dotBg: '#0a0e27', dotRing: '#818cf8',
    preview: {
      style: {
        background:
          'radial-gradient(120% 90% at 85% 0%, rgba(192,132,252,0.45), transparent 55%), radial-gradient(120% 90% at 0% 100%, rgba(56,189,248,0.40), transparent 55%), #0a0e27',
      },
      ink: '#eef2ff', accent: '#818cf8',
      sampleTitle: '未来产品愿景', stat: '10x', statLabel: 'LEAP',
    },
  },
  {
    value: 'sunset-bold', label: '日落炽橙', desc: '日落炽橙大色块，发布会级视觉冲击',
    dotBg: '#1c1210', dotRing: '#fb923c',
    preview: {
      style: { background: 'linear-gradient(140deg, #1c1210 30%, #3b1a12 72%, #58241a 100%)' },
      ink: '#fff7ed', accent: '#fb923c',
      sampleTitle: '品牌发布之夜', stat: '2026', statLabel: 'LAUNCH',
    },
  },
  {
    value: 'forest-organic', label: '森林有机', desc: '苔绿米纸自然系，衬线标题的温润质感',
    dotBg: '#f4f1e8', dotRing: '#2f6b3c',
    preview: {
      style: {
        background: 'radial-gradient(90% 70% at 100% 0%, rgba(47,107,60,0.14), transparent 60%), #f4f1e8',
      },
      ink: '#1f3d26', accent: '#2f6b3c',
      titleFontFamily: "'Noto Serif SC', Georgia, serif",
      sampleTitle: '可持续增长', stat: '+38%', statLabel: '年复合增速',
    },
  },
  {
    value: 'royal-velvet', label: '鎏金深紫', desc: '深紫丝绒 + 鎏金衬线，年度盛典与高端致辞',
    dotBg: '#17102b', dotRing: '#d4af37',
    preview: {
      style: {
        background: 'radial-gradient(120% 100% at 50% 0%, rgba(212,175,55,0.16), transparent 55%), #17102b',
      },
      ink: '#f3e9d2', accent: '#d4af37',
      titleFontFamily: "'Playfair Display', 'Noto Serif SC', serif",
      sampleTitle: '年度旗舰致辞', stat: 'X', statLabel: 'ANNIVERSARY',
    },
  },
  {
    value: 'ocean-glass', label: '海洋玻璃', desc: '浅海蓝玻璃拟态，轻盈通透的信息层次',
    dotBg: '#eaf4fb', dotRing: '#0369a1',
    preview: {
      style: { background: 'linear-gradient(135deg, #eaf4fb 0%, #d6eaf8 55%, #c2e0f4 100%)' },
      ink: '#0c4a6e', accent: '#0369a1',
      sampleTitle: '轻盈信息层', stat: '78%', statLabel: '透明度',
    },
  },
];

// 空状态快速开始示例（零摩擦输入：点击填入输入框，用户可改后再发送）
const QUICK_STARTS = [
  {
    label: '产品发布会',
    text: '帮我做一个新产品发布会 PPT，共 8 页，面向客户，包含产品亮点、应用场景、客户案例、定价与发布计划',
  },
  {
    label: '季度业务汇报',
    text: '生成一份季度业务汇报 PPT，共 10 页，包含业绩回顾、关键指标达成、问题复盘、下季度目标与行动计划',
  },
  {
    label: '技术方案评审',
    text: '做一份技术方案评审 PPT，共 8 页，包含项目背景、目标与非目标、整体架构、关键设计取舍、风险与排期',
  },
];

// 按内容长度估算页数（约 700 字/页，夹在 4~20 页）
function estimatePages(content: string): number {
  const len = content.trim().length;
  if (len === 0) return 8;
  return Math.max(4, Math.min(20, Math.round(len / 700)));
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// 校验是否为有效 PPT HTML
function looksLikeDeck(html: string): boolean {
  if (!html || html.length < 200) return false;
  const low = html.toLowerCase();
  if (!low.includes('<!doctype html') && !low.includes('<html')) return false;
  if (low.includes('id="root"')) return false;
  return low.includes('reveal') || low.includes('<section');
}

// ─── 安全 iframe 渲染（P1 安全债偿还）─────────────────────────────────────────
//
// 旧方案：sandbox="allow-scripts allow-same-origin" + nav-guard 注入
//   风险：same-origin + allow-scripts 让生成 HTML 以本管理后台同源运行，
//         prompt-injection 出的 <script> 能读 auth token / 冒用用户身份调 API。
//
// 新方案（本次实现）：sandbox="allow-scripts"（opaque origin）+ storage shim
//   - 去掉 allow-same-origin → iframe 得到 opaque origin，天然与主应用源隔离，
//     无法读取主应用的 localStorage/sessionStorage/cookie/IndexedDB。
//   - 注入 in-memory storage shim → 替换 window.localStorage/sessionStorage，
//     避免 reveal.js init 访问 storage 时抛错导致整页空白。
//   - 注入 nav-guard（保留）→ 阻止生成 HTML 中的链接把 iframe 导航到主应用。
//
// 验收口径：生成含 <script>fetch(...localStorage...)</script> 的 deck，
//   确认脚本拿不到主应用 token、不能以用户身份调 API，且 reveal 仍正常渲染可翻页。
// 所有主题字体（允许跨源 CSS 加载，不受 opaque origin 限制）
// 涵盖 5 个主题：Inter/JetBrains Mono(tech-dark) / Newsreader+Hanken Grotesk(cobalt-grid) /
//   Playfair Display(editorial-ink) / Space Grotesk(warm-zine) / Inter Tight(swiss-minimal)
// data-map-inject 标记：编辑模式序列化回传 HTML 时剥离所有注入节点，保证存回的是纯净 deck
const FONT_LINKS =
  '<link rel="preconnect" href="https://fonts.googleapis.com" data-map-inject>' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin data-map-inject>' +
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&family=Newsreader:ital,wght@0,400;0,500;1,300;1,400&family=Hanken+Grotesk:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,400;0,700;0,800;1,400;1,600&family=Space+Grotesk:wght@300;400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&family=Noto+Serif+SC:wght@300;400;700&display=swap" rel="stylesheet" data-map-inject>';

function prepareIframeHtml(html: string, opts?: { editor?: boolean }): string {
  if (!html) return html;

  // 1. in-memory storage shim（遮蔽 opaque origin 下 reveal 对 storage 的访问）
  const storageshim =
    '<script data-map-inject>' +
    '(function(){' +
    'var m={};' +
    'var s={' +
    'getItem:function(k){return m.hasOwnProperty(k)?m[k]:null;},' +
    'setItem:function(k,v){m[k]=String(v);},' +
    'removeItem:function(k){delete m[k];},' +
    'clear:function(){m={};},' +
    'key:function(i){return Object.keys(m)[i]||null;},' +
    'get length(){return Object.keys(m).length;}' +
    '};' +
    'try{Object.defineProperty(window,"localStorage",{get:function(){return s;},configurable:true});}catch(e){}' +
    'try{Object.defineProperty(window,"sessionStorage",{get:function(){return s;},configurable:true});}catch(e){}' +
    '})();' +
    '</script>';

  // 2. nav-guard（阻止 reveal 内链接把 iframe 导航到主应用）
  const navguard =
    '<script data-map-inject>(function(){try{' +
    'var n=function(){return null;};' +
    'try{history.pushState=n;history.replaceState=n;}catch(e){}' +
    "document.addEventListener('click',function(e){var t=e.target;while(t&&t!==document){if(t.tagName==='A'){var h=t.getAttribute('href')||'';if(h&&h.charAt(0)!=='#'){e.preventDefault();e.stopPropagation();}break;}t=t.parentNode;}},true);" +
    '}catch(e){}})();</script>';

  // 3. 控制脚本（常注入）：页码上报 + 父窗口翻页/跳页指令监听 + 圈选信息桥。
  //    opaque origin（sandbox 仅 allow-scripts）下父页面无法访问 contentWindow.Reveal，
  //    postMessage 是唯一可靠通道——翻页按钮/页码指示/圈选取信息全靠它。
  //    桥就绪后上报 map-ppt-ready（ready-signal 模式），防止父页面在桥未装好时发指令被丢。
  const controlScript =
    '<script data-map-inject>(function(){' +
    'function tot(){var s=document.querySelectorAll(".reveal .slides>section");return s.length||1;}' +
    'function cur(){try{if(window.Reveal&&Reveal.getIndices){return (Reveal.getIndices().h||0)+1;}}catch(e){}return 1;}' +
    'function rep(){try{parent.postMessage({type:"map-ppt-slide",cur:cur(),total:tot()},"*");}catch(e){}}' +
    // 圈选信息桥：父页面发来视口百分比矩形，换算像素后在中心点 + 四角内缩 10% 共 5 个采样点
    // elementFromPoint 取元素，向上找最近的语义祖先（到 .slides 为止），去重收集至多 5 条描述回传。
    // 任何异常也必须回传（texts 为空数组），不许静默吞掉。
    'function rectInfo(d){var texts=[];try{' +
    'var W=window.innerWidth,H=window.innerHeight;' +
    'var x=W*d.xPct/100,y=H*d.yPct/100,w=W*d.wPct/100,h=H*d.hPct/100;' +
    'var pts=[[x+w/2,y+h/2],[x+w*0.1,y+h*0.1],[x+w*0.9,y+h*0.1],[x+w*0.1,y+h*0.9],[x+w*0.9,y+h*0.9]];' +
    'var SEL="h1,h2,h3,h4,p,li,blockquote,td,th,img,.card,.feat,section";' +
    'var seen=[];' +
    'for(var i=0;i<pts.length;i++){var el=document.elementFromPoint(pts[i][0],pts[i][1]);' +
    'while(el&&el.matches&&!el.matches(SEL)){if(el.classList&&el.classList.contains("slides")){el=null;break;}el=el.parentElement;}' +
    'if(el&&el.matches&&seen.indexOf(el)<0&&seen.length<5){seen.push(el);}}' +
    'for(var j=0;j<seen.length;j++){var nd=seen[j];var tag=(nd.tagName||"").toLowerCase();' +
    'var txt=tag==="img"?(nd.getAttribute("alt")||"img"):(nd.textContent||"").replace(/\\s+/g," ").trim().slice(0,60);' +
    'texts.push(tag+":"+txt);}' +
    '}catch(e){}' +
    'try{parent.postMessage({type:"map-ppt-rect-info",id:d.id,slide:cur(),texts:texts},"*");}catch(e){}}' +
    'window.addEventListener("message",function(e){var d=e.data||{};try{' +
    'if(d.type==="map-ppt-nav"&&window.Reveal){if(d.dir==="prev"){Reveal.prev();}else{Reveal.next();}setTimeout(rep,80);}' +
    // 页位恢复：父页面指定 0-based 横向索引直接跳页
    'if(d.type==="map-ppt-goto"&&window.Reveal&&typeof d.h==="number"){Reveal.slide(d.h);setTimeout(rep,80);}' +
    'if(d.type==="map-ppt-rect-query"){rectInfo(d);}' +
    '}catch(err){if(d.type==="map-ppt-rect-query"){try{parent.postMessage({type:"map-ppt-rect-info",id:d.id,slide:1,texts:[]},"*");}catch(e2){}}}});' +
    'var n=0;var iv=setInterval(function(){n++;var R=window.Reveal;' +
    'if(R&&R.getIndices){clearInterval(iv);rep();try{if(R.on){R.on("slidechanged",rep);}else if(R.addEventListener){R.addEventListener("slidechanged",rep);}}catch(e){}' +
    // 桥安装完成（找到 Reveal 且首次 rep 已发）→ 通知父页面可以下发指令了
    'try{parent.postMessage({type:"map-ppt-ready"},"*");}catch(e){}}' +
    'else if(n>60){clearInterval(iv);}},250);' +
    '})();</script>';

  // 4. 编辑器脚本（仅编辑模式注入）：点击文字 contenteditable 直接改、
  //    悬浮工具条 撤销/A+/A-/颜色/对齐，改动 debounce 序列化（剥离全部注入节点 +
  //    清洗 reveal 运行时状态）postMessage 回父页面。
  //    撤销：最多 20 条的 innerHTML 快照栈，修改发生前压栈（连续打字用 dirty 标志只压一次）。
  const editorScript = !opts?.editor
    ? ''
    : '<style data-map-inject>' +
      '.__map_editing__{outline:2px dashed #c084fc!important;outline-offset:4px!important;cursor:text;}' +
      '#__map_editor_toolbar__{position:fixed;display:none;z-index:99999;gap:6px;align-items:center;background:#17181c;color:#eee;border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:6px 8px;font:12px/1 Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);}' +
      '#__map_editor_toolbar__ button{all:unset;cursor:pointer;padding:4px 8px;border-radius:5px;background:rgba(255,255,255,.08);color:#fff;font-weight:600;}' +
      '#__map_editor_toolbar__ button:hover{background:rgba(255,255,255,.18);}' +
      // 颜色圆点：14px 圆形按钮，1px 浅描边便于暗底辨认；背景色走元素内联 style（内联优先于此规则）
      '#__map_editor_toolbar__ button.__map_dot__{width:14px;height:14px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.35);box-sizing:border-box;}' +
      '#__map_editor_toolbar__ span{color:rgba(255,255,255,.5);font-size:10px;}' +
      '</style>' +
      '<script data-map-inject>(function(){' +
      'var SEL="h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th,.stat,.stat-l,.lead,.eyebrow,.chip,.quote";var cur=null;var t=null;' +
      // 撤销栈（最多 20 条）+ dirty 标志：beforeinput 首次触发时压栈（即"首次 input 前"的修改前快照），
      // blur/换目标/按钮操作后复位 dirty
      'var hist=[];var dirty=false;' +
      'function slidesEl(){return document.querySelector(".reveal .slides");}' +
      'function snap(){try{var s=slidesEl();if(s){hist.push(s.innerHTML);if(hist.length>20){hist.shift();}}}catch(e){}}' +
      'function onBI(){if(!dirty){snap();dirty=true;}}' +
      'function serialize(){try{' +
      'var root=document.documentElement.cloneNode(true);' +
      'var rm=root.querySelectorAll("[data-map-inject],#__map_editor_toolbar__");' +
      'for(var i=0;i<rm.length;i++){if(rm[i].parentNode){rm[i].parentNode.removeChild(rm[i]);}}' +
      'var ce=root.querySelectorAll("[contenteditable]");for(var j=0;j<ce.length;j++){ce[j].removeAttribute("contenteditable");}' +
      'var ed=root.querySelectorAll(".__map_editing__");for(var k=0;k<ed.length;k++){ed[k].classList.remove("__map_editing__");if(!ed[k].getAttribute("class")){ed[k].removeAttribute("class");}}' +
      // 清洗 reveal 运行时状态：序列化的是活 DOM，必须剥掉 reveal 注入的运行时节点/类/内联样式，
      // 否则产物带着 present/past/future、display:none、slides transform 等脏状态
      'try{var rt=root.querySelectorAll(".reveal .backgrounds,.reveal .progress,.reveal .controls,.reveal .slide-number,.reveal .speaker-notes,.reveal .pause-overlay");for(var a=0;a<rt.length;a++){if(rt[a].parentNode){rt[a].parentNode.removeChild(rt[a]);}}}catch(e1){}' +
      'try{var sc=root.querySelectorAll(".slides section");for(var b=0;b<sc.length;b++){var sn=sc[b];sn.classList.remove("present");sn.classList.remove("past");sn.classList.remove("future");if(!sn.getAttribute("class")){sn.removeAttribute("class");}sn.removeAttribute("hidden");sn.removeAttribute("aria-hidden");sn.style.removeProperty("display");sn.style.removeProperty("top");if(!sn.getAttribute("style")){sn.removeAttribute("style");}}}catch(e2){}' +
      'try{var sl=root.querySelector(".reveal .slides");if(sl){sl.removeAttribute("style");}}catch(e3){}' +
      'try{var rv=root.querySelector(".reveal");if(rv){rv.classList.remove("ready");rv.classList.remove("overview");rv.classList.remove("paused");}}catch(e4){}' +
      'parent.postMessage({type:"map-ppt-html",html:"<!DOCTYPE html>\\n"+root.outerHTML},"*");' +
      '}catch(e){}}' +
      'function sched(){clearTimeout(t);t=setTimeout(serialize,500);}' +
      'var tb=document.createElement("div");tb.id="__map_editor_toolbar__";' +
      "tb.innerHTML='<button data-act=\"undo\">撤销</button><button data-act=\"minus\">A-</button><button data-act=\"plus\">A+</button>" +
      "<button class=\"__map_dot__\" data-act=\"color\" data-color=\"#e6edf3\" style=\"background:#e6edf3\"></button>" +
      "<button class=\"__map_dot__\" data-act=\"color\" data-color=\"#7ee787\" style=\"background:#7ee787\"></button>" +
      "<button class=\"__map_dot__\" data-act=\"color\" data-color=\"#79c0ff\" style=\"background:#79c0ff\"></button>" +
      "<button class=\"__map_dot__\" data-act=\"color\" data-color=\"#d2a8ff\" style=\"background:#d2a8ff\"></button>" +
      "<button class=\"__map_dot__\" data-act=\"color\" data-color=\"#ffd166\" style=\"background:#ffd166\"></button>" +
      "<button class=\"__map_dot__\" data-act=\"color\" data-color=\"#ff6b6b\" style=\"background:#ff6b6b\"></button>" +
      "<button data-act=\"align\" data-align=\"left\">左</button><button data-act=\"align\" data-align=\"center\">中</button><button data-act=\"align\" data-align=\"right\">右</button>" +
      "<span>编辑中 · Esc 退出</span>';" +
      'tb.addEventListener("mousedown",function(e){e.preventDefault();e.stopPropagation();});' +
      'tb.addEventListener("click",function(e){var b2=e.target.closest?e.target.closest("button"):null;if(!b2){return;}e.preventDefault();e.stopPropagation();var act=b2.getAttribute("data-act");' +
      // 撤销：弹栈回填 slides → 清空选中态 → 同步 reveal 布局 → 序列化回传；栈空时无操作
      'if(act==="undo"){if(!hist.length){return;}var se=slidesEl();if(!se){return;}se.innerHTML=hist.pop();cur=null;dirty=false;tb.style.display="none";try{if(window.Reveal&&Reveal.sync){Reveal.sync();}}catch(e1){}try{if(window.Reveal&&Reveal.layout){Reveal.layout();}}catch(e2){}sched();return;}' +
      'if(!cur){return;}snap();dirty=false;' +
      // 主题覆盖层（themeOverride）对标题等元素带 !important，普通内联样式会被压住；
      // 内联 setProperty(...,"important") 优先级最高，编辑结果在任何主题下都生效
      'if(act==="plus"||act==="minus"){var fs=parseFloat(getComputedStyle(cur).fontSize)||24;var nv=act==="plus"?fs*1.12:fs/1.12;cur.style.setProperty("font-size",nv.toFixed(1)+"px","important");}' +
      'else if(act==="color"){cur.style.setProperty("color",b2.getAttribute("data-color")||"","important");}' +
      'else if(act==="align"){cur.style.setProperty("text-align",b2.getAttribute("data-align")||"","important");}' +
      'sched();place();});' +
      'function place(){if(!cur)return;var r=cur.getBoundingClientRect();tb.style.display="flex";var top=r.top-46;if(top<8){top=r.bottom+10;}tb.style.top=top+"px";tb.style.left=Math.max(8,Math.min(window.innerWidth-460,r.left))+"px";}' +
      'function desel(skip){if(!cur)return;cur.removeEventListener("input",sched);cur.removeEventListener("beforeinput",onBI);cur.removeAttribute("contenteditable");cur.classList.remove("__map_editing__");cur=null;dirty=false;tb.style.display="none";if(!skip){serialize();}}' +
      'function sel(el){if(cur===el)return;desel(true);cur=el;el.classList.add("__map_editing__");el.setAttribute("contenteditable","true");el.addEventListener("beforeinput",onBI);el.addEventListener("input",sched);place();try{el.focus();}catch(e){}}' +
      'document.addEventListener("click",function(e){' +
      'if(e.target.closest&&e.target.closest("#__map_editor_toolbar__")){return;}' +
      'var el=e.target.closest?e.target.closest(SEL):null;' +
      'if(el&&el.closest(".slides")){e.preventDefault();e.stopPropagation();sel(el);}else{desel(false);}' +
      '},true);' +
      'document.addEventListener("keydown",function(e){if(e.key==="Escape"){desel(false);}},true);' +
      'window.addEventListener("resize",function(){place();});' +
      'function mount(){if(document.body){document.body.appendChild(tb);}else{setTimeout(mount,100);}}mount();' +
      '})();</script>';

  // 不再注入任何主题 CSS 覆盖层：AI 输出的 <style> 就是最终视觉（风格语义见 THEME_OPTIONS 注释）。
  // 历史上这里有一层 !important 覆盖把 AI 的设计强行盖掉换皮，已按用户纠偏删除（2026-06-10）。
  const headInject = storageshim + navguard + controlScript + editorScript + FONT_LINKS;

  let result = html;
  if (/<head[^>]*>/i.test(result)) {
    result = result.replace(/<head[^>]*>/i, (m) => m + headInject);
  } else if (/<html[^>]*>/i.test(result)) {
    result = result.replace(/<html[^>]*>/i, (m) => m + headInject);
  } else {
    result = headInject + result;
  }
  return result;
}

// 导出/发布用 HTML：只补字体链接（AI 的 CSS 引用了这些字体名），不带 shim/编辑器等运行时注入。
function prepareExportHtml(html: string): string {
  if (!html) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, FONT_LINKS + '</head>');
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + FONT_LINKS);
  return FONT_LINKS + html;
}

// 从生成 HTML 提取 <title>，用作下载文件名与发布标题
function extractDeckTitle(html: string): string {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].trim() : '';
}

// 生成阶段提示文案（流式数据未到达时的兜底；数据到达后由幻灯进度卡接管主视觉）
function genStageMsg(sec: number, isPatch: boolean): string {
  if (isPatch)
    return sec < 8 ? '正在理解修改指令...' : sec < 25 ? '正在重排指定页面...' : '正在收尾排版...';
  if (sec < 5) return '正在分析内容结构...';
  if (sec < 18) return '正在设计版式与配色...';
  if (sec < 38) return '正在逐页生成幻灯片...';
  if (sec < 60) return '正在排版与收尾...';
  return '内容较多，正在精修中（大模型生成约需 1 分钟）...';
}

// ─── 幻灯进度解析（Gamma 式"页面一张张点亮"）────────────────────────────────
// 从已接收的 HTML 流里数 <section>：闭合的算"已生成"（抽出页内首个标题展示），
// 已开口未闭合的算"正在绘制"。deck 是扁平 section 结构，正则解析足够。
export interface SlideProgress {
  titles: string[];
  building: boolean;
}

export function parseSlideProgress(html: string): SlideProgress {
  const titles: string[] = [];
  const re = /<section\b[^>]*>([\s\S]*?)<\/section>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(m[1]);
    const title = t ? t[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    titles.push(title);
  }
  const opens = (html.match(/<section\b/gi) ?? []).length;
  return { titles, building: opens > titles.length };
}

// ─── 生成期实况渲染（Gamma 式：等待时看到的就是真实幻灯页本身，不是状态面板）──
// 从流里取已闭合的 <section> 原文 + <head> 里已完整到达的 <link>/<style>，
// 拼一个"单页静态 deck"文档灌进实况 iframe：不带 Reveal 运行时（脚本通常在文件
// 末尾还没流到），靠注入 CSS 把 section 静态铺满视口。
// 输入未出新页时输出字符串恒等 → React 跳过 srcDoc 更新 → iframe 不重载不闪烁。

export function extractCompletedSections(html: string): string[] {
  return html.match(/<section\b[^>]*>[\s\S]*?<\/section>/gi) ?? [];
}

export function extractHeadAssets(html: string): string {
  const bodyAt = html.search(/<body\b/i);
  const head = bodyAt >= 0 ? html.slice(0, bodyAt) : html;
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  const styles = head.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? [];
  return links.join('') + styles.join('');
}

// 无 Reveal 运行时的静态铺版：中和 reveal.css 对 slides/section 的定位与隐藏
const LIVE_SLIDE_CSS =
  'html,body{margin:0;width:100%;height:100%;overflow:hidden;}' +
  '.reveal{width:100%;height:100%;position:relative;overflow:hidden;font-size:28px;}' +
  '.reveal .slides{position:absolute !important;inset:0 !important;width:100% !important;height:100% !important;' +
  'transform:none !important;margin:0 !important;display:block !important;text-align:left;}' +
  '.reveal .slides section{display:flex !important;flex-direction:column;justify-content:center;' +
  'position:absolute !important;inset:0;width:auto !important;height:auto !important;' +
  'visibility:visible !important;opacity:1 !important;transform:none !important;' +
  'overflow:hidden;box-sizing:border-box;padding:5vh 6vw;}';

export function buildLiveSlideDoc(headAssets: string, sectionHtml: string): string {
  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    FONT_LINKS +
    headAssets +
    '<style>' +
    LIVE_SLIDE_CSS +
    '</style></head>' +
    '<body><div class="reveal"><div class="slides">' +
    sectionHtml +
    '</div></div></body></html>'
  );
}

// 读取 sessionStorage（安全）
function loadSession(): SessionState | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

function saveSession(s: SessionState): void {
  try {
    // 不持久化 HTML 到 sessionStorage（太大），只存消息和 runId
    const toSave: SessionState = {
      ...s,
      messages: s.messages.map((m) => ({ ...m, outline: m.outline })),
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(toSave));
  } catch {
    /* ignore quota errors */
  }
}

// ─── 知识库选择模态（库 → 文档列表 → 内容预览 → 引用）──────────────────────
// 不是只给名字让用户盲选：点文档可先看内容，确认是想要的再引用。

interface KbPickerProps {
  onClose: () => void;
  onSelect: (ref: KbRef) => void;
}

function KbPicker({ onClose, onSelect }: KbPickerProps) {
  const [stores, setStores] = useState<KbStore[]>([]);
  const [selectedStore, setSelectedStore] = useState<KbStore | null>(null);
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [entriesLoading, setEntriesLoading] = useState(false);
  // 预览态：选中的文档 + 已加载的内容
  const [previewEntry, setPreviewEntry] = useState<KbEntry | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    setStoresLoading(true);
    apiRequest<{ items: KbStore[] }>('/api/document-store/stores?pageSize=50')
      .then((res) => {
        if (res.success && res.data) setStores(res.data.items ?? []);
      })
      .finally(() => setStoresLoading(false));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openStore = useCallback(async (store: KbStore) => {
    setSelectedStore(store);
    setPreviewEntry(null);
    setPreviewContent(null);
    setEntriesLoading(true);
    const res = await apiRequest<{ items: KbEntry[] }>(
      `/api/document-store/stores/${encodeURIComponent(store.id)}/entries?pageSize=200&all=true`
    );
    if (res.success && res.data) setEntries(res.data.items ?? []);
    setEntriesLoading(false);
  }, []);

  const openPreview = useCallback(async (entry: KbEntry) => {
    setPreviewEntry(entry);
    setPreviewContent(null);
    setPreviewLoading(true);
    const res = await apiRequest<{ content: string | null; title: string }>(
      `/api/document-store/entries/${encodeURIComponent(entry.id)}/content`
    );
    setPreviewLoading(false);
    setPreviewContent(res.success ? (res.data?.content ?? '') : '（内容加载失败）');
  }, []);

  const confirmSelect = useCallback(() => {
    if (!selectedStore || !previewEntry || previewContent == null) return;
    onSelect({
      storeName: selectedStore.name,
      entryTitle: previewEntry.title,
      content: previewContent,
    });
  }, [selectedStore, previewEntry, previewContent, onSelect]);

  const modal = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/45" onClick={onClose}>
      <div
        data-testid="kb-picker-modal"
        className="rounded-xl border border-white/10 bg-[var(--bg-elevated)] shadow-2xl flex flex-col"
        style={{ width: 'min(860px, 92vw)', height: '76vh', maxHeight: '76vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/8">
          <span className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
            <BookOpen size={13} className="text-blue-400" />
            引用知识库
            {selectedStore && <span className="text-[var(--text-tertiary)] font-normal">/ {selectedStore.name}</span>}
            {previewEntry && <span className="text-[var(--text-tertiary)] font-normal truncate max-w-[260px]">/ {previewEntry.title}</span>}
          </span>
          <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-1" style={{ minHeight: 0 }}>
          {/* 左列：知识库列表 */}
          <div
            className="w-52 shrink-0 border-r border-white/8"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {storesLoading && <div className="flex justify-center py-6"><MapSpinner size={14} /></div>}
            {!storesLoading && stores.map((st) => (
              <button
                key={st.id}
                onClick={() => void openStore(st)}
                className={[
                  'w-full flex items-start gap-2 px-3 py-2.5 text-left border-b border-white/4',
                  selectedStore?.id === st.id ? 'bg-blue-500/12' : 'hover:bg-white/4',
                ].join(' ')}
              >
                <BookOpen size={12} className={selectedStore?.id === st.id ? 'shrink-0 mt-0.5 text-blue-400' : 'shrink-0 mt-0.5 text-[var(--text-tertiary)]'} />
                <div className="min-w-0">
                  <div className={['text-[11px] truncate', selectedStore?.id === st.id ? 'text-blue-200 font-medium' : 'text-[var(--text-primary)]'].join(' ')}>
                    {st.name}
                  </div>
                  <div className="text-[9px] text-[var(--text-tertiary)]">{st.documentCount} 篇</div>
                </div>
              </button>
            ))}
          </div>

          {/* 右区：文档列表 / 内容预览 */}
          <div className="flex-1 flex flex-col" style={{ minWidth: 0, minHeight: 0 }}>
            {!selectedStore && (
              <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-tertiary)]">
                左侧选择一个知识库
              </div>
            )}

            {selectedStore && !previewEntry && (
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                {entriesLoading && <div className="flex justify-center py-6"><MapSpinner size={14} /></div>}
                {!entriesLoading && entries.length === 0 && (
                  <div className="py-10 text-center text-xs text-[var(--text-tertiary)]">该知识库暂无文档</div>
                )}
                {!entriesLoading && entries.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => void openPreview(entry)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/4 border-b border-white/4 text-left"
                  >
                    <FileText size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                    <div className="min-w-0">
                      <div className="text-xs text-[var(--text-primary)] truncate">{entry.title}</div>
                      {entry.summary && (
                        <div className="text-[10px] text-[var(--text-tertiary)] truncate mt-0.5">{entry.summary}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {selectedStore && previewEntry && (
              <>
                <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-white/6">
                  <button
                    onClick={() => { setPreviewEntry(null); setPreviewContent(null); }}
                    className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                  >
                    <ChevronLeft size={12} />
                    返回列表
                  </button>
                  <span className="flex-1" />
                  <button
                    onClick={confirmSelect}
                    disabled={previewLoading || previewContent == null}
                    data-testid="kb-confirm-select"
                    className="flex items-center gap-1 px-3 py-1 rounded-md text-[11px] font-semibold bg-blue-500/85 text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    <Check size={11} />
                    引用此文档
                  </button>
                </div>
                <div
                  className="flex-1 px-4 py-3"
                  style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
                >
                  {previewLoading && <div className="flex justify-center py-8"><MapSpinner size={14} /></div>}
                  {!previewLoading && (
                    previewContent
                      ? <MarkdownContent content={previewContent} className="text-[12px]" />
                      : <div className="text-xs text-[var(--text-tertiary)]">（空文档）</div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// ─── Outline 确认气泡内容 ──────────────────────────────────────────────────────

interface OutlineBubbleProps {
  msg: ChatMessage;
  onConfirm: (msg: ChatMessage) => void;
  onAdjust: (msg: ChatMessage, instruction: string) => void;
  disabled: boolean;
}

function OutlineBubble({ msg, onConfirm, onAdjust, disabled }: OutlineBubbleProps) {
  const [adjustText, setAdjustText] = useState('');
  const [showAdjust, setShowAdjust] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      {msg.summary && (
        <p className="text-xs text-[var(--text-secondary)]">{msg.summary}</p>
      )}
      <div className="text-[10px] text-[var(--text-tertiary)] mb-1">
        建议 {msg.totalPages ?? msg.outline?.length ?? 0} 页大纲：
      </div>
      <div className="flex flex-col gap-1.5">
        {(msg.outline ?? []).map((slide, i) => (
          <div
            key={i}
            className="rounded-md bg-white/4 border border-white/6 px-2.5 py-1.5"
          >
            <div className="text-[11px] font-semibold text-[var(--text-primary)] mb-0.5">
              {i + 1}. {slide.title}
            </div>
            {slide.bullets.length > 0 && (
              <ul className="space-y-0.5">
                {slide.bullets.map((b, j) => (
                  <li key={j} className="text-[10px] text-[var(--text-tertiary)] pl-2">
                    - {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>

      {showAdjust && (
        <div className="flex gap-1.5 mt-1">
          <input
            type="text"
            value={adjustText}
            onChange={(e) => setAdjustText(e.target.value)}
            placeholder="调整说明，如：把第3页改成竞品分析"
            className="flex-1 text-xs bg-white/5 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] border border-white/10 rounded-md px-2 py-1.5 outline-none focus:border-purple-500/40"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && adjustText.trim()) {
                onAdjust(msg, adjustText.trim());
                setAdjustText('');
                setShowAdjust(false);
              }
            }}
          />
          <button
            disabled={!adjustText.trim() || disabled}
            onClick={() => {
              if (adjustText.trim()) {
                onAdjust(msg, adjustText.trim());
                setAdjustText('');
                setShowAdjust(false);
              }
            }}
            className="px-2 py-1 rounded-md bg-white/6 text-[10px] text-[var(--text-secondary)] hover:bg-white/10 disabled:opacity-40"
          >
            调整
          </button>
        </div>
      )}

      <div className="flex gap-2 mt-1">
        <button
          onClick={() => onConfirm(msg)}
          disabled={disabled}
          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 border border-purple-500/25 disabled:opacity-40"
        >
          <Check size={11} />
          确认，生成 PPT
        </button>
        <button
          onClick={() => setShowAdjust((v) => !v)}
          disabled={disabled}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-white/5 text-[var(--text-secondary)] hover:bg-white/8 border border-white/8 disabled:opacity-40"
        >
          调整大纲
        </button>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function MdToPptAgentPage() {
  // ─── Session lazy-load: run BEFORE any other useState so saveSession
  // never overwrites sessionStorage with empty initial state on first render.
  const [savedSession] = useState<SessionState | null>(loadSession);

  // ─── Global settings (收进设置区，不占对话空间）
  // 引擎只有 CDS Agent 一条路（2026-06-10 用户拍板移除 MAP 直出），无引擎/模型选择；
  // 模型由 Agent 运行配置决定，经 SSE model 事件回显（ai-model-visibility）。
  const [theme, setTheme] = useState(savedSession?.theme ?? 'tech-dark');
  // 自定义模板（上传参考图 → 视觉模型提取风格规范，生成时优先于官方主题）
  const [templateId, setTemplateId] = useState<string | null>(savedSession?.templateId ?? null);
  const [customTemplates, setCustomTemplates] = useState<MdToPptTemplateItem[]>([]);
  const templatesLoadedRef = useRef(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const templateFileRef = useRef<HTMLInputElement>(null);

  // 大纲工作稿（右侧编辑器数据源；sessionStorage 持久化，刷新恢复到 outline-ready 状态）
  const [outlineDraft, setOutlineDraft] = useState<OutlineDraft | null>(savedSession?.outlineDraft ?? null);
  const [outlineAiText, setOutlineAiText] = useState('');
  // AI 调整中：编辑器保持在场，卡片蒙层降透明（不许整屏消失）
  const [outlineAdjusting, setOutlineAdjusting] = useState(false);
  // 被 AI 改动 / 拖拽换位的卡片索引：1.6s 渐变高亮，让用户看清"变化发生在哪"
  const [flashCards, setFlashCards] = useState<Set<number>>(new Set());
  // 拖拽排序：被拖卡索引
  const dragIdxRef = useRef<number | null>(null);

  // 历史生成（server-authority：runs 落库，随时可载入继续精修/编辑/发布）
  const [showHistory, setShowHistory] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<MdToPptRunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyOpeningId, setHistoryOpeningId] = useState<string | null>(null);

  // ─── Chat state
  const [messages, setMessages] = useState<ChatMessage[]>(savedSession?.messages ?? []);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // ─── Artifact state（右侧）
  const [generatedHtml, setGeneratedHtml] = useState('');
  const [activeRunId, setActiveRunId] = useState(savedSession?.activeRunId ?? '');
  const [publishedUrl, setPublishedUrl] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [artifactPhase, setArtifactPhase] = useState<'idle' | 'outlining' | 'generating' | 'patching' | 'done'>('idle');
  const [diagLines, setDiagLines] = useState<MdToPptDiagEvent[]>([]);
  const [modelInfo, setModelInfo] = useState<{ model: string; platform: string } | null>(null);

  // ─── 生成期流式可视化（2 秒定理：等待时屏幕必须有持续变化的内容）
  //     delta 先进 ref，150ms 节流刷进 state，避免大 HTML 每个 token 触发整页 re-render。
  const [streamPreview, setStreamPreview] = useState('');
  // 本轮预计页数（来自大纲），驱动"逐页点亮"进度卡的占位格子数
  const [expectedPages, setExpectedPages] = useState<number | null>(null);
  const streamBufRef = useRef('');
  const streamFlushTimerRef = useRef<number | null>(null);

  // 幻灯进度：从流里解析已闭合的 <section>（页标题逐张点亮）
  const slideProgress = useMemo(() => parseSlideProgress(streamPreview), [streamPreview]);

  // ─── 并行逐页生成进度（pages 模式）：壳子 head + 每页完成即点亮（真实进度，不依赖 token 流）
  const [frameHead, setFrameHead] = useState('');
  const [pagesTotal, setPagesTotal] = useState(0);
  const [pagesDone, setPagesDone] = useState<Record<number, string>>({});

  // ─── 计时基准（服务器权威性）：刷新恢复时用 run.createdAt，不许前端从 0 重数
  const genStartAtRef = useRef<number>(0);

  // ─── 生成实况预览（主视觉）：已完成的页直接真实渲染，默认跟随最新完成页
  const [liveSlideSel, setLiveSlideSel] = useState<number | null>(null);
  const liveSections = useMemo(() => extractCompletedSections(streamPreview), [streamPreview]);
  const liveHeadAssets = useMemo(() => extractHeadAssets(streamPreview), [streamPreview]);
  const liveIdx =
    liveSlideSel != null && liveSlideSel < liveSections.length
      ? liveSlideSel
      : liveSections.length - 1;
  const liveDoc = useMemo(
    () => (liveSections.length === 0 ? '' : buildLiveSlideDoc(liveHeadAssets, liveSections[liveIdx] ?? '')),
    [liveSections, liveHeadAssets, liveIdx]
  );

  // pages 模式实况：壳子 head（设计系统完整）+ 选中/最新完成页（并行完成，非顺序）
  const pagesDoneIdxs = useMemo(
    () => Object.keys(pagesDone).map(Number).sort((a, b) => a - b),
    [pagesDone]
  );
  const pagesLiveIdx =
    liveSlideSel != null && pagesDone[liveSlideSel] != null
      ? liveSlideSel
      : pagesDoneIdxs.length > 0
        ? pagesDoneIdxs[pagesDoneIdxs.length - 1]
        : -1;
  const pagesLiveDoc = useMemo(() => {
    if (!frameHead || pagesLiveIdx < 0) return '';
    return buildLiveSlideDoc(extractHeadAssets(frameHead + '<body>'), pagesDone[pagesLiveIdx] ?? '');
  }, [frameHead, pagesLiveIdx, pagesDone]);

  // ─── 思考过程流（推理模型先想后写：deepseek-v3.2 实测思考可占总耗时 90%，
  //     正文集中尾部爆发。思考期间产物无片段可渲染，就渲染思考本身——它就是此刻的产物）
  const [thinkingPreview, setThinkingPreview] = useState('');
  const thinkingBufRef = useRef('');
  const thinkingFlushTimerRef = useRef<number | null>(null);

  const resetStreamPreview = useCallback(() => {
    streamBufRef.current = '';
    thinkingBufRef.current = '';
    if (streamFlushTimerRef.current != null) {
      window.clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    if (thinkingFlushTimerRef.current != null) {
      window.clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
    setStreamPreview('');
    setThinkingPreview('');
    setLiveSlideSel(null);
    setFrameHead('');
    setPagesTotal(0);
    setPagesDone({});
  }, []);

  const handleStreamDelta = useCallback((text: string) => {
    if (!text) return;
    streamBufRef.current += text;
    if (streamFlushTimerRef.current == null) {
      streamFlushTimerRef.current = window.setTimeout(() => {
        streamFlushTimerRef.current = null;
        setStreamPreview(streamBufRef.current);
      }, 150);
    }
  }, []);

  const handleThinkingDelta = useCallback((text: string) => {
    if (!text) return;
    thinkingBufRef.current += text;
    if (thinkingFlushTimerRef.current == null) {
      thinkingFlushTimerRef.current = window.setTimeout(() => {
        thinkingFlushTimerRef.current = null;
        setThinkingPreview(thinkingBufRef.current);
      }, 150);
    }
  }, []);

  // ─── 所见即所得编辑 + 页码（iframe postMessage 通道）
  const [editMode, setEditMode] = useState(false);
  const [dirtyEdits, setDirtyEdits] = useState(false);
  const [slidePos, setSlidePos] = useState<{ cur: number; total: number } | null>(null);
  const editedHtmlRef = useRef<string>('');
  const previewWrapRef = useRef<HTMLDivElement>(null);

  // ─── 页位恢复：restoreSlideRef 实时跟踪当前页（0-based）；触发 iframe 重载的动作
  //     （换主题/进出编辑/精修）先把它快照进 pendingRestoreRef，ready 信号到达时按快照回跳。
  //     不能直接用实时 ref——新 iframe 初始化时会先上报第 1 页，把实时 ref 清零（竞态，已踩过）。
  const restoreSlideRef = useRef(0);
  const pendingRestoreRef = useRef<number | null>(null);

  // ─── 圈选反馈：拖框圈选幻灯片区域 → 反查元素文本 → 组装精修指令填入输入框
  const [feedbackMode, setFeedbackMode] = useState(false);
  const pendingRectRef = useRef<{ id: string; note: string; rect: SelectionRectPct; slide: number; timer: number } | null>(null);

  // ─── Attachments & KB
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [pendingKbRefs, setPendingKbRefs] = useState<KbRef[]>([]);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showKbPicker, setShowKbPicker] = useState(false);

  // 左侧对话栏宽度（可拖拽，280-640px；纯 UI 偏好走 localStorage——关浏览器仍记住）
  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem('md2ppt-chat-width') ?? '', 10);
      return v >= 280 && v <= 640 ? v : 340;
    } catch {
      return 340;
    }
  });
  const chatResizeRef = useRef<{ startX: number; startW: number; lastW: number } | null>(null);

  const onChatResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    chatResizeRef.current = { startX: e.clientX, startW: chatWidth, lastW: chatWidth };
    const onMove = (ev: PointerEvent) => {
      const st = chatResizeRef.current;
      if (!st) return;
      const w = Math.max(280, Math.min(640, st.startW + (ev.clientX - st.startX)));
      st.lastW = w;
      setChatWidth(w);
    };
    const onUp = () => {
      const st = chatResizeRef.current;
      chatResizeRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (st) {
        try { localStorage.setItem('md2ppt-chat-width', String(st.lastW)); } catch { /* ignore */ }
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [chatWidth]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ─── Elapsed timer for artifact progress
  useEffect(() => {
    if (artifactPhase === 'generating' || artifactPhase === 'patching') {
      if (!genStartAtRef.current) genStartAtRef.current = Date.now();
      const tick = () => setElapsedSec(Math.max(0, Math.floor((Date.now() - genStartAtRef.current) / 1000)));
      tick();
      const t = window.setInterval(tick, 1000);
      return () => window.clearInterval(t);
    } else {
      genStartAtRef.current = 0;
      setElapsedSec(0);
    }
  }, [artifactPhase]);

  // ─── Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  // ─── Session persistence: restore HTML for active run on mount
  // (theme/messages are already restored via lazy useState above)
  useEffect(() => {
    const runId = savedSession?.activeRunId;
    if (!runId) return;

    let cancelled = false;
    let timer: number | undefined;

    // 恢复对账：把聊天里残留的「正在生成/修改」气泡按 run 真实状态翻转——
    // 此前只恢复 deck 不对账消息，刷新后气泡永远停在"正在生成 PPT..."（2026-06-11 实测）
    const reconcileMessages = (status: 'done' | 'error', error?: string | null) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.role === 'assistant' && (m.phase === 'generating' || m.phase === 'patching')
            ? status === 'done'
              ? { ...m, phase: 'done', content: 'PPT 已生成！你可以继续对话精修、编辑内容、换模板或发布。' }
              : { ...m, phase: 'error', content: '生成失败：' + (error ?? '未知错误') }
            : m
        )
      );
    };

    const poll = async () => {
      const run = await getMdToPptRun(runId);
      if (cancelled) return;
      if (!run) return;
      if (run.status === 'done' && run.html) {
        setGeneratedHtml(run.html);
        setActiveRunId(runId);
        setArtifactPhase('done');
        reconcileMessages('done');
      } else if (run.status === 'error') {
        setArtifactPhase('idle');
        reconcileMessages('error', run.error);
      } else if (run.status === 'running') {
        // 计时基准 = 服务端 run.createdAt（服务器权威性：刷新后显示真实已等待时长）
        genStartAtRef.current = new Date(run.createdAt).getTime();
        setArtifactPhase('generating');
        timer = window.setTimeout(poll, 3000);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Session persistence: save on state change
  useEffect(() => {
    saveSession({ messages, activeRunId, theme, templateId, outlineDraft });
  }, [messages, activeRunId, theme, templateId, outlineDraft]);

  // 模板列表进页即载（右侧模板画廊是空状态主视觉，必须秒出）
  useEffect(() => {
    if (templatesLoadedRef.current) return;
    templatesLoadedRef.current = true;
    void getMdToPptTemplates().then(setCustomTemplates);
  }, []);

  // ─── 圈选反馈指令组装（texts 为空时退化为坐标描述）
  const composeFeedback = useCallback((slide: number, texts: string[], note: string, rect: SelectionRectPct) => {
    const what = texts.length > 0
      ? `圈选内容：${texts.join('；')}`
      : `圈选区域：左上(${rect.xPct.toFixed(0)}%,${rect.yPct.toFixed(0)}%) 大小(${rect.wPct.toFixed(0)}%x${rect.hPct.toFixed(0)}%)`;
    return `第${slide}页，${what}。修改要求：${note}`;
  }, []);

  // ─── iframe postMessage 监听：页码上报 + 编辑稿回传 + ready 页位恢复 + 圈选信息
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // opaque origin 下 e.origin === 'null'，只认来自当前预览 iframe 的消息
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as {
        type?: string; html?: string; cur?: number; total?: number;
        id?: string; slide?: number; texts?: string[];
      } | null;
      if (!d || typeof d !== 'object') return;
      if (d.type === 'map-ppt-slide' && typeof d.cur === 'number' && typeof d.total === 'number') {
        setSlidePos({ cur: d.cur, total: d.total });
        restoreSlideRef.current = d.cur - 1;
      }
      if (d.type === 'map-ppt-html' && typeof d.html === 'string' && looksLikeDeck(d.html)) {
        editedHtmlRef.current = d.html;
        setDirtyEdits(true);
      }
      // 桥就绪：按重载前的快照回跳（open-design ready-signal 模式）
      if (d.type === 'map-ppt-ready') {
        const target = pendingRestoreRef.current;
        pendingRestoreRef.current = null;
        if (target != null && target > 0) {
          iframeRef.current?.contentWindow?.postMessage({ type: 'map-ppt-goto', h: target }, '*');
        }
      }
      // 圈选反查结果：组装精修指令填入输入框（不自动发送，控制权交给用户）
      if (d.type === 'map-ppt-rect-info' && typeof d.id === 'string') {
        const pending = pendingRectRef.current;
        if (!pending || pending.id !== d.id) return;
        window.clearTimeout(pending.timer);
        pendingRectRef.current = null;
        const slide = typeof d.slide === 'number' && d.slide > 0 ? d.slide : pending.slide;
        const texts = Array.isArray(d.texts) ? d.texts.filter((t): t is string => typeof t === 'string') : [];
        setInput(composeFeedback(slide, texts, pending.note, pending.rect));
        inputRef.current?.focus();
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [composeFeedback]);

  // ─── 圈选提交：向 iframe 反查选区内元素，1s 无响应则退化为坐标描述
  const handleFeedbackSubmit = useCallback((payload: { rect: SelectionRectPct; note: string }) => {
    setFeedbackMode(false);
    const id = genId();
    const slide = slidePos?.cur ?? 1;
    const timer = window.setTimeout(() => {
      // 桥无响应兜底：不让用户白画一个框
      if (pendingRectRef.current?.id !== id) return;
      pendingRectRef.current = null;
      setInput(composeFeedback(slide, [], payload.note, payload.rect));
      inputRef.current?.focus();
    }, 1000);
    pendingRectRef.current = { id, note: payload.note, rect: payload.rect, slide, timer };
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'map-ppt-rect-query', id, xPct: payload.rect.xPct, yPct: payload.rect.yPct, wPct: payload.rect.wPct, hPct: payload.rect.hPct },
      '*'
    );
  }, [slidePos, composeFeedback]);

  // ─── Nav: 翻页走 postMessage（opaque origin 下无法直接访问 contentWindow.Reveal）
  const deckNav = useCallback((dir: 'prev' | 'next') => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'map-ppt-nav', dir }, '*');
  }, []);

  // ─── 编辑产物：取最新 HTML（编辑模式下优先未提交的编辑稿）
  const latestHtml = useCallback(() => {
    return editedHtmlRef.current && looksLikeDeck(editedHtmlRef.current)
      ? editedHtmlRef.current
      : generatedHtml;
  }, [generatedHtml]);

  // ─── 提交编辑（把 iframe 回传的编辑稿存为正式产物）
  const commitEdits = useCallback(() => {
    if (editedHtmlRef.current && looksLikeDeck(editedHtmlRef.current)) {
      setGeneratedHtml(editedHtmlRef.current);
    }
    editedHtmlRef.current = '';
    setDirtyEdits(false);
  }, []);

  const toggleEditMode = useCallback(() => {
    pendingRestoreRef.current = restoreSlideRef.current; // 进出编辑都触发 iframe 重载，先快照页位
    if (editMode) {
      commitEdits();
      setEditMode(false);
    } else {
      setFeedbackMode(false); // 编辑与圈选互斥
      setEditMode(true);
    }
  }, [editMode, commitEdits]);

  // ─── 全屏演示
  const handleFullscreen = useCallback(() => {
    void previewWrapRef.current?.requestFullscreen?.();
  }, []);

  // ─── 下载独立 HTML（含当前主题样式，可直接双击打开演示）
  const handleDownload = useCallback(() => {
    const base = latestHtml();
    if (!base) return;
    const out = prepareExportHtml(base);
    const blob = new Blob([out], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // 文件名清洗非法字符；挂载 DOM 后再 click（Firefox 要求 anchor 在文档内）
    const safeName = (extractDeckTitle(base) || '网页PPT').replace(/[\\/:*?"<>|]/g, '_').trim();
    a.download = safeName + '.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [latestHtml]);

  // ─── Add message helper
  const pushMsg = useCallback(
    (msg: Omit<ChatMessage, 'id'>): ChatMessage => {
      const full: ChatMessage = { ...msg, id: genId() };
      setMessages((prev) => [...prev, full]);
      return full;
    },
    []
  );

  const updateLastAssistantMsg = useCallback((update: Partial<ChatMessage>) => {
    setMessages((prev) => {
      const last = [...prev].reverse().find((m) => m.role === 'assistant');
      if (!last) return prev;
      return prev.map((m) => (m.id === last.id ? { ...m, ...update } : m));
    });
  }, []);

  // ─── File attachment
  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';
      const content = await file.text();
      setPendingAttachments((prev) => [...prev, { name: file.name, content }]);
      setShowPlusMenu(false);
    },
    []
  );

  // ─── KB pick callback
  const handleKbSelect = useCallback((ref: KbRef) => {
    setPendingKbRefs((prev) => [...prev, ref]);
    setShowKbPicker(false);
  }, []);

  // ─── Remove attachment / KB ref
  const removeAttachment = useCallback((idx: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const removeKbRef = useCallback((idx: number) => {
    setPendingKbRefs((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // ─── Outline flow
  const requestOutline = useCallback(
    async (
      userText: string,
      attachments: Attachment[],
      kbRefs: KbRef[],
      targetPagesOverride?: number,
      sourceTextOverride?: string,
      adjustMode?: boolean
    ) => {
      setIsProcessing(true);
      // 调整模式：编辑器保持在场（内联 busy 蒙层），不切全屏「规划中」——
      // 否则用户手里的大纲整个消失，像被清空了（2026-06-11 用户原话「好像全都消失了」）
      if (adjustMode) {
        setOutlineAdjusting(true);
      } else {
        setArtifactPhase('outlining');
      }
      setDiagLines([]);

      const attachmentText = attachments.map((a) => `## 附件：${a.name}\n\n${a.content}`).join('\n\n');
      const kbContext = kbRefs.map((r) => `## 知识库「${r.storeName}」>「${r.entryTitle}」\n\n${r.content}`).join('\n\n');

      // 历史摘要：只取最近 3 轮用户消息
      const historyMsgs = messages.filter((m) => m.role === 'user').slice(-3);
      const chatHistory = historyMsgs.map((m) => `用户: ${m.content}`).join('\n');

      const targetPages = targetPagesOverride ?? estimatePages(userText + attachmentText + kbContext);

      const assistantMsg = pushMsg({
        role: 'assistant',
        content: '正在规划大纲...',
        phase: 'outline',
      });

      const result = await getMdToPptOutline({
        content: userText,
        attachmentText: attachmentText || undefined,
        kbContext: kbContext || undefined,
        chatHistory: chatHistory || undefined,
        targetPages,
      });

      if (!result.success) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: '大纲生成失败：' + result.error, phase: 'error', error: result.error }
              : m
          )
        );
        setIsProcessing(false);
        setOutlineAdjusting(false);
        setArtifactPhase('idle');
        return;
      }

      // diff：找出本次被 AI 改动的页（与旧稿逐页比较），1s 渐变高亮让用户看清"改了哪"
      const prevOutline = outlineDraft?.outline ?? [];
      const changed = new Set<number>();
      result.data.outline.forEach((sl, i) => {
        const old0 = prevOutline[i];
        if (!old0 || old0.title !== sl.title || old0.bullets.join('\n') !== sl.bullets.join('\n')) {
          changed.add(i);
        }
      });
      if (adjustMode && changed.size > 0) {
        setFlashCards(changed);
        window.setTimeout(() => setFlashCards(new Set()), 1600);
      }

      // 工作稿写入右侧编辑器（状态进入 outline-ready，刷新可恢复）
      const sourceText =
        sourceTextOverride ??
        [userText, attachmentText, kbContext].filter(Boolean).join('\n\n---\n\n').trim();
      setOutlineDraft({
        sourceText,
        summary: result.data.summary,
        totalPages: result.data.totalPages,
        outline: result.data.outline,
        clarify: result.data.clarify?.slice(0, 3),
        clarifyAnswers: {},
        clarifySent: false,
      });

      const hasClarify = (result.data.clarify?.length ?? 0) > 0;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                content:
                  '大纲已生成，在右侧展开了：可以直接改每页标题和要点、增删页，' +
                  (hasClarify ? '顶部有几个澄清问题帮我消除歧义，' : '') +
                  '也可以在下方输入框让我调整。改好后点右侧「确认，生成 PPT」。',
                phase: 'text',
              }
            : m
        )
      );

      // 预热 CDS Agent 会话：用户阅读/确认大纲的十几秒里把环境启动做完，
      // 点「确认生成」时后端直接复用，启动开销对用户不可见（产物即体验）
      prewarmMdToPpt();

      setIsProcessing(false);
      setOutlineAdjusting(false);
      setArtifactPhase('idle');
    },
    [messages, pushMsg, outlineDraft]
  );

  // ─── Convert 核心（大纲编辑器「确认生成」与旧版气泡共用）
  const launchConvert = useCallback(
    (fullContent: string, pages: number | null, outlinePages?: OutlineSlide[], summary?: string) => {
      if (isProcessing) return;
      setIsProcessing(true);
      setArtifactPhase('generating');
      setPublishedUrl('');
      setFeedbackMode(false);
      resetStreamPreview();
      setExpectedPages(pages);
      restoreSlideRef.current = 0; // 新一轮生成回到第 1 页
      pendingRestoreRef.current = null;

      const genMsg = pushMsg({
        role: 'assistant',
        content: '正在生成 PPT...',
        phase: 'generating',
      });

      const cleanup = streamMdToPptConvert({
        content: fullContent,
        theme,
        templateId: templateId ?? undefined,
        slideCount: pages ?? undefined,
        outlinePages,
        summary,
        onFrame: (f) => {
          setFrameHead(f.head);
          setPagesTotal(f.total);
        },
        onPage: (pg) => {
          setPagesTotal(pg.total);
          setPagesDone((prev) => ({ ...prev, [pg.index]: pg.html }));
        },
        onRun: (runId) => {
          if (runId) setActiveRunId(runId);
          try {
            sessionStorage.setItem(SESSION_KEY + '-run', runId);
          } catch { /* ignore */ }
        },
        onModel: (info) => setModelInfo(info),
        onDiag: (d) => setDiagLines((prev) => [...prev, d]),
        onThinking: handleThinkingDelta,
        onDelta: handleStreamDelta,
        onDone: (result) => {
          const html = result.html;
          if (!looksLikeDeck(html)) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === genMsg.id
                  ? { ...m, content: '生成结果异常，未得到有效 PPT，请重试。', phase: 'error' }
                  : m
              )
            );
            setIsProcessing(false);
            setArtifactPhase('idle');
            return;
          }
          setGeneratedHtml(html);
          setArtifactPhase('done');
          setIsProcessing(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === genMsg.id
                ? {
                    ...m,
                    content: 'PPT 已生成！你可以继续对话精修，例如：「第3页改两栏对比」「整体换商务蓝」「加一页讲 ROI」',
                    phase: 'done',
                  }
                : m
            )
          );
        },
        onError: (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === genMsg.id
                ? { ...m, content: '生成失败：' + err, phase: 'error', error: err }
                : m
            )
          );
          setIsProcessing(false);
          setArtifactPhase('idle');
        },
      });

      cleanupRef.current = cleanup;
    },
    [isProcessing, pushMsg, theme, templateId, resetStreamPreview, handleStreamDelta, handleThinkingDelta]
  );

  // 序列化大纲（注入生成提示词 / 调整上下文共用）
  const serializeOutline = useCallback((outline: OutlineSlide[]) => {
    return outline
      .map((sl, i) => `${i + 1}. ${sl.title}\n${sl.bullets.map((b) => `   - ${b}`).join('\n')}`)
      .join('\n');
  }, []);

  // 序列化澄清回答（有就拼进生成上下文，消歧义）
  const serializeClarifyAnswers = useCallback((draft: OutlineDraft) => {
    const qs = draft.clarify ?? [];
    const answers = draft.clarifyAnswers ?? {};
    const lines = qs
      .map((q) => {
        const a = answers[q.id];
        if (a == null || (Array.isArray(a) && a.length === 0) || a === '') return null;
        return `- ${q.question}：${Array.isArray(a) ? a.join('、') : a}`;
      })
      .filter(Boolean);
    return lines.length > 0 ? '\n\n## 澄清回答\n' + lines.join('\n') : '';
  }, []);

  // ─── 大纲编辑器「确认，生成 PPT」：以右侧工作稿（含用户手工编辑 + 澄清回答）为准
  const confirmOutlineDraft = useCallback(() => {
    const draft = outlineDraft;
    if (!draft || isProcessing) return;
    const fullContent =
      draft.sourceText +
      serializeClarifyAnswers(draft) +
      `\n\n---\n\n## 大纲结构（请严格按此页数和标题生成）\n\n${serializeOutline(draft.outline)}`;
    launchConvert(
      fullContent,
      draft.totalPages || draft.outline.length || null,
      draft.outline,
      draft.summary
    );
  }, [outlineDraft, isProcessing, serializeClarifyAnswers, serializeOutline, launchConvert]);

  // ─── 旧版气泡确认（兼容历史会话里带内嵌大纲的消息）
  const startConvert = useCallback(
    (outlineMsg: ChatMessage) => {
      if (isProcessing) return;
      const msgIdx = messages.findIndex((m) => m.id === outlineMsg.id);
      const userMsg = [...messages.slice(0, msgIdx)].reverse().find((m) => m.role === 'user');
      const userContent = userMsg?.content ?? '';
      const attachmentText = (userMsg?.attachments ?? [])
        .map((a) => `## 附件：${a.name}\n\n${a.content}`)
        .join('\n\n');
      const kbContext = (userMsg?.kbRefs ?? [])
        .map((r) => `## KB「${r.storeName}」>「${r.entryTitle}」\n\n${r.content}`)
        .join('\n\n');
      const outlineText = serializeOutline(outlineMsg.outline ?? []);
      const fullContent =
        [userContent, attachmentText, kbContext].filter(Boolean).join('\n\n---\n\n').trim() +
        (outlineText ? `\n\n---\n\n## 大纲结构（请严格按此页数和标题生成）\n\n${outlineText}` : '');
      launchConvert(
        fullContent,
        outlineMsg.totalPages ?? outlineMsg.outline?.length ?? null,
        outlineMsg.outline,
        outlineMsg.summary
      );
    },
    [isProcessing, messages, serializeOutline, launchConvert]
  );

  // ─── 让 AI 调整大纲（以右侧工作稿为基底：尊重用户手工编辑，页数守护）
  const requestOutlineAdjust = useCallback(
    (instruction: string) => {
      const draft = outlineDraft;
      if (!draft || isProcessing) return;
      void requestOutline(
        draft.sourceText +
          serializeClarifyAnswers(draft) +
          '\n\n当前大纲（用户可能已手工编辑，请在此基础上调整）：\n' +
          serializeOutline(draft.outline) +
          '\n\n调整要求：' + instruction +
          '\n（硬约束：只改动与调整要求直接相关的页；其余页的标题与要点必须逐字原样保留，' +
          '禁止任何改写、润色、增删、换序。除非调整要求明确提到增减页数，否则总页数保持不变）',
        [], [],
        draft.totalPages || draft.outline.length,
        draft.sourceText,
        true
      );
    },
    [outlineDraft, isProcessing, requestOutline, serializeClarifyAnswers, serializeOutline]
  );

  // ─── Patch flow（对话式精修）。baseHtml 允许携带编辑模式未提交的最新稿；
  //     styleOverride 用于「换风格/换模板 = AI 按新参照重绘」（不传则沿用当前选择；
  //     templateId 传 null 表示明确切回官方主题）。
  const startPatch = useCallback(
    (instruction: string, baseHtml?: string, styleOverride?: { theme?: string; templateId?: string | null }) => {
      const base = baseHtml ?? generatedHtml;
      if (!base || isProcessing) return;

      setIsProcessing(true);
      setArtifactPhase('patching');
      resetStreamPreview();
      setExpectedPages(slidePos?.total ?? null); // 精修重出整份 deck，按当前页数占位
      pendingRestoreRef.current = restoreSlideRef.current; // 精修完成重载后回到当前页

      const patchMsg = pushMsg({
        role: 'assistant',
        content: '正在修改 PPT...',
        phase: 'patching',
      });

      const effTemplateId = styleOverride?.templateId !== undefined ? styleOverride.templateId : templateId;
      const cleanup = streamMdToPptPatch({
        currentHtml: base,
        slideRequest: instruction,
        theme: styleOverride?.theme ?? theme,
        templateId: effTemplateId ?? undefined,
        onRun: (runId) => {
          if (runId) setActiveRunId(runId);
        },
        onModel: (info) => setModelInfo(info),
        onDiag: (d) => setDiagLines((prev) => [...prev, d]),
        onThinking: handleThinkingDelta,
        onDelta: handleStreamDelta,
        onDone: (result) => {
          const html = result.html;
          if (!looksLikeDeck(html)) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === patchMsg.id
                  ? { ...m, content: '修改结果异常，请重试。', phase: 'error' }
                  : m
              )
            );
            setIsProcessing(false);
            setArtifactPhase('done');
            return;
          }
          setGeneratedHtml(html);
          setArtifactPhase('done');
          setIsProcessing(false);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === patchMsg.id
                ? { ...m, content: '已更新，右侧预览已刷新。继续告诉我你想修改什么。', phase: 'done' }
                : m
            )
          );
        },
        onError: (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === patchMsg.id
                ? { ...m, content: '修改失败：' + err, phase: 'error', error: err }
                : m
            )
          );
          setIsProcessing(false);
          setArtifactPhase('done');
        },
      });

      cleanupRef.current = cleanup;
    },
    [generatedHtml, isProcessing, pushMsg, theme, templateId, slidePos, resetStreamPreview, handleStreamDelta, handleThinkingDelta]
  );

  // ─── 换风格/换模板 = AI 参照新设计参照整体重绘（2026-06-10 用户纠偏：风格是
  //     AI 的设计参照，不是前端 CSS 换皮）。无产物时只改选择（影响下一次生成）；
  //     有产物时把当前 HTML 交给 AI 按新参照重新设计排版与配色。
  const switchTheme = useCallback(
    (value: string) => {
      if (value === theme && templateId == null) return;
      setTheme(value);
      setTemplateId(null);
      if (!generatedHtml || isProcessing) return;

      const label = THEME_OPTIONS.find((o) => o.value === value)?.label ?? value;
      const base = latestHtml();
      if (editMode) {
        commitEdits();
        setEditMode(false);
      }
      pushMsg({ role: 'user', content: `整体换成「${label}」风格` });
      startPatch(
        `参照「${label}」风格把整份 PPT 重新设计：配色、字体、版式气质全部按该风格重绘，内容与页数保持不变。`,
        base,
        { theme: value, templateId: null }
      );
    },
    [theme, templateId, generatedHtml, isProcessing, latestHtml, editMode, commitEdits, pushMsg, startPatch]
  );

  // ─── 选自定义模板（参考图提取的风格规范作为生成参照）
  const selectCustomTemplate = useCallback(
    (t: MdToPptTemplateItem) => {
      setTemplateId(t.id);
      if (!generatedHtml || isProcessing) return;
      const base = latestHtml();
      if (editMode) {
        commitEdits();
        setEditMode(false);
      }
      pushMsg({ role: 'user', content: `整体换成自定义模板「${t.name}」的风格` });
      startPatch(
        `参照自定义模板「${t.name}」的风格规范把整份 PPT 重新设计：配色、字体、版式气质全部按规范重绘，内容与页数保持不变。`,
        base,
        { templateId: t.id }
      );
    },
    [generatedHtml, isProcessing, latestHtml, editMode, commitEdits, pushMsg, startPatch]
  );

  // ─── 上传参考图创建模板（零摩擦：选图即建，名字默认取文件名；视觉提取约 5-15s）
  const handleTemplateFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = '';
      if (file.size > 6 * 1024 * 1024) {
        pushMsg({ role: 'assistant', content: '参考图超过 6MB，请压缩后再试。', phase: 'error' });
        return;
      }
      setTemplateBusy(true);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error('读取图片失败'));
          reader.readAsDataURL(file);
        });
        const name = file.name.replace(/\.[^.]+$/, '') || '自定义模板';
        const result = await createMdToPptTemplate({ name, imageDataUrl: dataUrl });
        if (result.success) {
          setCustomTemplates((prev) => [result.template, ...prev]);
          setTemplateId(result.template.id);
          pushMsg({
            role: 'assistant',
            content: `自定义模板「${result.template.name}」已创建并选中（参考图风格已提取）。下次生成按它执行；想立即把当前 PPT 重绘成该风格，点设置里的模板色点即可。`,
            phase: 'text',
          });
        } else {
          pushMsg({ role: 'assistant', content: '模板创建失败：' + result.error, phase: 'error' });
        }
      } catch (err) {
        pushMsg({ role: 'assistant', content: '模板创建失败：' + (err as Error).message, phase: 'error' });
      } finally {
        setTemplateBusy(false);
      }
    },
    [pushMsg]
  );

  const removeTemplate = useCallback(
    async (t: MdToPptTemplateItem) => {
      const ok = await deleteMdToPptTemplate(t.id);
      if (!ok) return;
      setCustomTemplates((prev) => prev.filter((x) => x.id !== t.id));
      setTemplateId((cur) => (cur === t.id ? null : cur));
    },
    []
  );

  // ─── 历史生成：打开抽屉拉列表；点击条目载入 deck 继续精修/编辑/发布
  const openHistory = useCallback(() => {
    setShowHistory(true);
    setHistoryLoading(true);
    void getRecentMdToPptRuns()
      .then(setHistoryRuns)
      .finally(() => setHistoryLoading(false));
  }, []);

  const loadHistoryRun = useCallback(
    async (summary: MdToPptRunSummary) => {
      if (isProcessing || historyOpeningId) return;
      setHistoryOpeningId(summary.id);
      const run = await getMdToPptRun(summary.id);
      setHistoryOpeningId(null);
      if (!run || !run.html || !looksLikeDeck(run.html)) {
        pushMsg({ role: 'assistant', content: `历史记录「${summary.title || '未命名'}」没有可用的 PPT 产物（状态：${run?.status ?? '未知'}）。`, phase: 'error' });
        return;
      }
      // 载入为当前产物：可继续对话精修 / 编辑 / 换风格 / 发布
      setGeneratedHtml(run.html);
      setActiveRunId(run.id);
      setArtifactPhase('done');
      setPublishedUrl('');
      setEditMode(false);
      setDirtyEdits(false);
      setFeedbackMode(false);
      editedHtmlRef.current = '';
      restoreSlideRef.current = 0;
      pendingRestoreRef.current = null;
      setShowHistory(false);
      pushMsg({
        role: 'assistant',
        content: `已载入历史生成「${run.title || '未命名 PPT'}」（${new Date(run.createdAt).toLocaleString()}）。可以继续对话精修、编辑内容、换风格或发布。`,
        phase: 'text',
      });
    },
    [isProcessing, historyOpeningId, pushMsg]
  );

  // ─── Outline adjust（调整大纲后重新请求）
  const adjustOutline = useCallback(
    (outlineMsg: ChatMessage, instruction: string) => {
      if (isProcessing) return;

      // 找对应的用户消息
      const msgIdx = messages.findIndex((m) => m.id === outlineMsg.id);
      const userMsg = [...messages.slice(0, msgIdx)].reverse().find((m) => m.role === 'user');
      const userContent = userMsg?.content ?? '';

      // 追加一条用户消息
      pushMsg({ role: 'user', content: instruction });

      // 页数沿用上一版大纲（修 2026-06-10 实测 bug：调整一句结语，页数从 6 被重估成 4——
      // estimatePages 按文本长度估页对"调整"场景完全不适用；除非用户明确要求改页数）
      void requestOutline(
        userContent + '\n\n调整要求：' + instruction + '\n（除非调整要求里明确提到增减页数，否则总页数保持不变）',
        [], [],
        outlineMsg.totalPages ?? outlineMsg.outline?.length
      );
    },
    [isProcessing, messages, pushMsg, requestOutline]
  );

  // ─── Main send handler
  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isProcessing) return;

    const atts = [...pendingAttachments];
    const kbs = [...pendingKbRefs];
    setInput('');
    setPendingAttachments([]);
    setPendingKbRefs([]);
    setShowPlusMenu(false);

    pushMsg({
      role: 'user',
      content: text,
      attachments: atts.length > 0 ? atts : undefined,
      kbRefs: kbs.length > 0 ? kbs : undefined,
    });

    // 决策：有 HTML → patch；有大纲工作稿（且无新附件）→ AI 调整大纲；否则 → 请求大纲
    if (generatedHtml) {
      // 对话精修模式。若编辑模式有未提交修改，以编辑稿为基底并先落盘。
      const base = latestHtml();
      if (editMode) {
        commitEdits();
        setEditMode(false);
      }
      startPatch(text, base);
    } else if (outlineDraft && atts.length === 0 && kbs.length === 0) {
      // outline-ready 阶段：输入即调整大纲（右侧工作稿为基底）
      requestOutlineAdjust(text);
    } else {
      // 初次生成：大纲先行
      void requestOutline(text, atts, kbs);
    }
  }, [input, isProcessing, pendingAttachments, pendingKbRefs, generatedHtml, outlineDraft, pushMsg, startPatch, requestOutline, requestOutlineAdjust, latestHtml, editMode, commitEdits]);

  // ─── Publish（携带主题样式发布，标题取自 deck <title>）
  const handlePublish = useCallback(async () => {
    const base = latestHtml();
    if (!base) return;
    if (editMode) {
      commitEdits();
      setEditMode(false);
    }
    setIsPublishing(true);
    const result = await publishMdToPpt({
      htmlContent: prepareExportHtml(base),
      title: extractDeckTitle(base) || 'PPT 演示',
    });
    setIsPublishing(false);
    if (result.success && result.siteUrl) {
      setPublishedUrl(result.siteUrl);
    }
  }, [latestHtml, editMode, commitEdits]);

  // ─── Abort
  const handleAbort = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setIsProcessing(false);
    setArtifactPhase(generatedHtml ? 'done' : 'idle');
    resetStreamPreview();
    updateLastAssistantMsg({ content: '已中止。', phase: 'text' });
  }, [generatedHtml, updateLastAssistantMsg, resetStreamPreview]);

  // ─── Reset
  const handleReset = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setMessages([]);
    setGeneratedHtml('');
    setActiveRunId('');
    setPublishedUrl('');
    setIsProcessing(false);
    setArtifactPhase('idle');
    setPendingAttachments([]);
    setPendingKbRefs([]);
    setEditMode(false);
    setDirtyEdits(false);
    setSlidePos(null);
    setFeedbackMode(false);
    setOutlineDraft(null);
    resetStreamPreview();
    editedHtmlRef.current = '';
    restoreSlideRef.current = 0;
    pendingRestoreRef.current = null;
    if (pendingRectRef.current) {
      window.clearTimeout(pendingRectRef.current.timer);
      pendingRectRef.current = null;
    }
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }, [resetStreamPreview]);

  const isStreaming = artifactPhase === 'generating' || artifactPhase === 'patching';

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-white/8">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-purple-500/15 flex items-center justify-center">
            <FileText size={13} className="text-purple-400" />
          </div>
          <span className="text-sm font-semibold text-[var(--text-primary)]">PPT 创作工作台</span>
        </div>

        <div className="flex items-center gap-2">
          {isStreaming && (
            <button
              onClick={handleAbort}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-400 hover:bg-red-500/10 border border-red-500/20"
            >
              <X size={11} />
              中止
            </button>
          )}

          {generatedHtml && !isStreaming && (
            <button
              onClick={() => void handlePublish()}
              disabled={isPublishing}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-blue-500/15 text-blue-400 hover:bg-blue-500/20 border border-blue-500/25 disabled:opacity-50"
            >
              {isPublishing ? <MapSpinner size={11} /> : <Globe size={11} />}
              {isPublishing ? '发布中...' : '发布为网页'}
            </button>
          )}

          <button
            onClick={openHistory}
            disabled={isStreaming}
            title="历史生成：查看并载入以前生成的 PPT 继续精修"
            data-testid="history-button"
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-white/5 disabled:opacity-40"
          >
            <History size={12} />
            历史
          </button>

          <button
            onClick={handleReset}
            title="新建对话"
            className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-white/5"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      {/* 模板选择只有两个入口（不再有「设置」收起面板，那是画廊的重复）：
          生成前 = 右侧模板画廊（大卡片迷你预览）；生成后 = 预览工具栏色点（AI 整体重绘）。
          隐藏的上传 input 常驻在此，画廊「上传参考图新建」按钮引用它。 */}
      <input
        ref={templateFileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => void handleTemplateFile(e)}
        className="hidden"
      />

      {/* Published URL banner */}
      {publishedUrl && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-green-500/8 border-b border-green-500/15 text-xs text-green-400">
          <Globe size={12} />
          <span>已发布：</span>
          <a href={publishedUrl} target="_blank" rel="noreferrer" className="underline hover:text-green-300">
            {publishedUrl}
          </a>
        </div>
      )}

      {/* Main: left chat + right artifact */}
      <div className="flex flex-1 min-h-0">

        {/* ─── Left: Chat panel（宽度可拖拽，右缘手柄） ───────────────────── */}
        <div
          className="shrink-0 flex flex-col border-r border-white/8"
          style={{ minHeight: 0, width: chatWidth, position: 'relative' }}
        >
          <div
            data-testid="chat-resize-handle"
            onPointerDown={onChatResizeStart}
            title="拖拽调整对话栏宽度"
            className="absolute top-0 right-0 h-full hover:bg-purple-500/40 transition-colors"
            style={{ width: 5, cursor: 'col-resize', zIndex: 10, marginRight: -2.5 }}
          />
          {/* Messages */}
          <div
            className="flex-1 px-3 py-3 flex flex-col gap-3"
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
          >
            {/* Empty state */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                <div className="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center">
                  <Wand2 size={18} className="text-purple-400" />
                </div>
                <div>
                  <p className="text-xs font-medium text-[var(--text-secondary)]">
                    告诉我你想做什么样的 PPT
                  </p>
                  <p className="text-[10px] text-[var(--text-tertiary)] mt-1 leading-relaxed">
                    支持附件和知识库引用，生成后可直接<br />
                    点击文字编辑、切换主题、下载、发布
                  </p>
                </div>

                {/* 快速开始：点击填入输入框，可修改后再发送 */}
                <div className="flex flex-col gap-1.5 w-full mt-1" data-testid="quick-starts">
                  {QUICK_STARTS.map((q) => (
                    <button
                      key={q.label}
                      onClick={() => {
                        setInput(q.text);
                        inputRef.current?.focus();
                      }}
                      className="text-left px-2.5 py-2 rounded-lg bg-white/4 border border-white/8 hover:bg-purple-500/10 hover:border-purple-500/25 transition-colors"
                    >
                      <div className="text-[11px] font-medium text-[var(--text-secondary)]">
                        {q.label}
                      </div>
                      <div className="text-[9px] text-[var(--text-tertiary)] truncate mt-0.5">
                        {q.text}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Message list */}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                {/* Role indicator */}
                <span className="text-[9px] text-[var(--text-tertiary)] px-0.5">
                  {msg.role === 'user' ? '你' : 'AI'}
                </span>

                {/* Bubble */}
                <div
                  className={[
                    'rounded-xl px-3 py-2 text-xs leading-relaxed max-w-[90%]',
                    msg.role === 'user'
                      ? 'bg-purple-500/15 text-[var(--text-primary)] border border-purple-500/20'
                      : 'bg-white/5 text-[var(--text-secondary)] border border-white/8',
                  ].join(' ')}
                >
                  {/* User message content */}
                  {msg.role === 'user' && (
                    <div>
                      <p>{msg.content}</p>
                      {(msg.attachments ?? []).map((a, i) => (
                        <div key={i} className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-tertiary)]">
                          <Upload size={9} />
                          {a.name}
                        </div>
                      ))}
                      {(msg.kbRefs ?? []).map((r, i) => (
                        <div key={i} className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-tertiary)]">
                          <BookOpen size={9} />
                          {r.storeName} &gt; {r.entryTitle}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Assistant: outline phase */}
                  {msg.role === 'assistant' && msg.phase === 'outline' && msg.outline && (
                    <OutlineBubble
                      msg={msg}
                      onConfirm={startConvert}
                      onAdjust={adjustOutline}
                      disabled={isProcessing}
                    />
                  )}

                  {/* Assistant: generating / patching（思考流作为 AI 输出进对话气泡——
                        对话归对话，中间只放 PPT 预览，两不干扰） */}
                  {msg.role === 'assistant' &&
                    (msg.phase === 'generating' || msg.phase === 'patching') && (
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <MapSpinner size={11} />
                          <span>{msg.content}</span>
                        </div>
                        {isStreaming && streamPreview.length === 0 && thinkingPreview.length === 0 && diagLines.length > 0 && (
                          <div className="text-[9px] font-mono text-[var(--text-tertiary)]">
                            环境准备 {diagLines.slice(-1)[0].stage}
                            {typeof diagLines.slice(-1)[0].elapsedMs === 'number'
                              ? ` ${Math.round((diagLines.slice(-1)[0].elapsedMs as number) / 100) / 10}s`
                              : ''}
                          </div>
                        )}
                        {isStreaming && thinkingPreview.length > 0 && (
                          <div
                            data-testid="thinking-bubble"
                            className="rounded-md bg-purple-500/6 border border-purple-500/15 px-2 py-1.5"
                          >
                            <div className="text-[9px] text-purple-300/80 font-semibold mb-0.5 flex items-center gap-1">
                              <span className="w-1 h-1 rounded-full bg-purple-400 animate-pulse" />
                              AI 思考中 · {thinkingPreview.length.toLocaleString()} 字
                            </div>
                            <div
                              className="text-[10px] leading-relaxed text-[var(--text-tertiary)]"
                              style={{ maxHeight: 110, overflow: 'hidden', wordBreak: 'break-word' }}
                            >
                              <StreamingText text={thinkingPreview} streaming maxTailChars={300} className="whitespace-pre-wrap" />
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                  {/* Assistant: outline (still loading) */}
                  {msg.role === 'assistant' && msg.phase === 'outline' && !msg.outline && (
                    <div className="flex items-center gap-2">
                      <MapSpinner size={11} />
                      <span>{msg.content}</span>
                    </div>
                  )}

                  {/* Assistant: error */}
                  {msg.role === 'assistant' && msg.phase === 'error' && (
                    <div className="flex items-start gap-2 text-red-400">
                      <AlertCircle size={11} className="mt-0.5 shrink-0" />
                      <span>{msg.content}</span>
                    </div>
                  )}

                  {/* Assistant: done / text */}
                  {msg.role === 'assistant' &&
                    (msg.phase === 'done' || msg.phase === 'text' || !msg.phase) && (
                      <p>{msg.content}</p>
                    )}
                </div>
              </div>
            ))}

            <div ref={chatEndRef} />
          </div>

          {/* ─── Input area（composer-shell 卡片式，借鉴 open-design：
                输入区是一张完整卡片——附件 chips 在卡内顶部、textarea 无边框透明、
                底部工具行（+ 菜单 / 快捷键提示 / 实底发送主按钮），focus-within 高亮整卡。
                底部额外留白避免被 CDS 预览挂件（左下角 fixed 条）遮挡。 */}
          <div className="shrink-0 border-t border-white/8 px-3 pt-3" style={{ paddingBottom: 34 }}>
            <div
              data-testid="composer-shell"
              className="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-white/4 px-2.5 pt-2.5 pb-2 transition-all focus-within:border-purple-400/70 focus-within:bg-white/6 focus-within:ring-2 focus-within:ring-purple-500/30 focus-within:shadow-[0_0_18px_rgba(168,85,247,.15)]"
            >
              {/* Pending attachments & KB refs（卡内顶部） */}
              {(pendingAttachments.length > 0 || pendingKbRefs.length > 0) && (
                <div className="flex flex-wrap gap-1.5">
                  {pendingAttachments.map((a, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/6 text-[10px] text-[var(--text-secondary)] border border-white/8"
                    >
                      <Upload size={9} />
                      <span className="truncate max-w-[120px]">{a.name}</span>
                      <button onClick={() => removeAttachment(i)}>
                        <X size={9} />
                      </button>
                    </div>
                  ))}
                  {pendingKbRefs.map((r, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/10 text-[10px] text-blue-300 border border-blue-500/15"
                    >
                      <BookOpen size={9} />
                      <span className="truncate max-w-[120px]">{r.entryTitle}</span>
                      <button onClick={() => removeKbRef(i)}>
                        <X size={9} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 无边框 textarea，随内容自动增高（60-180px） */}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  const el = e.target;
                  el.style.height = 'auto';
                  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={
                  generatedHtml
                    ? '继续精修，如：第3页改两栏对比...'
                    : '告诉 AI 你想做什么 PPT...'
                }
                rows={3}
                disabled={isProcessing}
                className="w-full resize-none text-xs leading-relaxed bg-transparent text-[var(--text-primary)] placeholder-[var(--text-tertiary)] border-0 outline-none focus:outline-none focus-visible:outline-none disabled:opacity-50"
                style={{ minHeight: 60, maxHeight: 180, overflowY: 'auto', overscrollBehavior: 'contain', outline: 'none', boxShadow: 'none' }}
              />

              {/* 底部工具行 */}
              <div className="flex items-center gap-2 pt-1.5 border-t border-white/6">
                {/* "+" menu */}
                <div className="relative shrink-0">
                  <button
                    onClick={() => setShowPlusMenu((v) => !v)}
                    disabled={isProcessing}
                    title="添加文件 / 引用知识库"
                    className="flex items-center justify-center w-7 h-7 rounded-lg bg-white/5 text-[var(--text-tertiary)] hover:bg-white/8 hover:text-[var(--text-secondary)] border border-white/8 disabled:opacity-40"
                  >
                    <Plus size={13} />
                  </button>

                  {showPlusMenu && (
                    <div className="absolute bottom-full left-0 mb-1 w-40 rounded-lg border border-white/10 bg-[var(--bg-elevated)] shadow-xl z-10">
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-[var(--text-secondary)] hover:bg-white/5"
                        onClick={() => {
                          setShowPlusMenu(false);
                          fileInputRef.current?.click();
                        }}
                      >
                        <Upload size={12} />
                        添加文件
                      </button>
                      <button
                        className="w-full flex items-center gap-2 px-3 py-2.5 text-xs text-[var(--text-secondary)] hover:bg-white/5 border-t border-white/6"
                        onClick={() => {
                          setShowPlusMenu(false);
                          setShowKbPicker(true);
                        }}
                      >
                        <BookOpen size={12} />
                        引用知识库
                      </button>
                    </div>
                  )}
                </div>

                <span className="text-[9px] text-[var(--text-tertiary)] select-none">
                  Enter 发送 · Shift+Enter 换行
                </span>
                <span className="flex-1" />

                {/* 实底主按钮（主操作一眼可见） */}
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isProcessing}
                  className="shrink-0 flex items-center gap-1.5 h-7 px-3 rounded-lg text-[11px] font-semibold bg-purple-500/85 text-white hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isProcessing ? <MapSpinner size={11} /> : <Send size={11} />}
                  发送
                </button>
              </div>
            </div>
          </div>

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.txt,.markdown,.pdf,.doc,.docx"
            onChange={(e) => void handleFileChange(e)}
            className="hidden"
          />
        </div>

        {/* ─── Right: Artifact panel ──────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col" style={{ minHeight: 0 }}>
          {/* Idle = 模板画廊：右侧大空间选模板（模板 = AI 生成参照），不藏设置里。
                官方 10 套大卡片（迷你风格预览）+ 自定义模板 + 上传参考图新建。 */}
          {artifactPhase === 'idle' && !generatedHtml && !outlineDraft && (
            <div
              className="flex-1 flex flex-col px-6 py-5 gap-4"
              style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
              data-testid="template-gallery"
            >
              <div className="shrink-0 flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-purple-500/10 flex items-center justify-center">
                  <Wand2 size={17} className="text-purple-400/80" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">选择模板，然后在左侧告诉 AI 你想做什么</p>
                  <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">
                    模板是 AI 生成时参照的设计语言（配色 / 字体 / 版式气质），生成后也可一键换模板重绘
                  </p>
                </div>
              </div>

              {/* 官方模板：每张卡用模板自己的设计语言画一页迷你幻灯
                  （渐变/格纸底 + 主题字体标题 + 角标数据），所见即生成参照 */}
              <div className="shrink-0">
                <div className="text-[11px] font-semibold text-[var(--text-tertiary)] mb-2">官方模板</div>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                  {THEME_OPTIONS.map((opt) => {
                    const active = templateId == null && theme === opt.value;
                    const pv = opt.preview;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => switchTheme(opt.value)}
                        data-testid={'tpl-official-' + opt.value}
                        title={opt.desc}
                        className={[
                          'group text-left rounded-xl border overflow-hidden transition-all',
                          active
                            ? 'border-purple-400/70 ring-2 ring-purple-500/30'
                            : 'border-white/10 hover:border-white/25',
                        ].join(' ')}
                      >
                        <div className="relative px-4 pt-3.5 pb-3 overflow-hidden" style={{ height: 112, ...pv.style }}>
                          <div className="w-7 rounded-full mb-2" style={{ background: pv.accent, height: 3 }} />
                          <div
                            className="text-[15px] font-extrabold leading-tight"
                            style={{ color: pv.ink, fontFamily: pv.titleFontFamily }}
                          >
                            {pv.sampleTitle}
                          </div>
                          <div className="mt-2 h-1.5 w-3/4 rounded" style={{ background: pv.ink, opacity: 0.22 }} />
                          <div className="mt-1 h-1.5 w-1/2 rounded" style={{ background: pv.ink, opacity: 0.14 }} />
                          <div className="absolute right-3.5 bottom-2.5 text-right">
                            <div
                              className="text-[19px] font-extrabold leading-none tabular-nums"
                              style={{ color: pv.accent, fontFamily: pv.titleFontFamily }}
                            >
                              {pv.stat}
                            </div>
                            <div className="text-[8px] mt-0.5 tracking-widest" style={{ color: pv.ink, opacity: 0.5 }}>
                              {pv.statLabel}
                            </div>
                          </div>
                        </div>
                        <div className="px-3 py-2 bg-white/4">
                          <div className="flex items-center justify-between">
                            <span className={['text-[12px] font-semibold', active ? 'text-purple-200' : 'text-[var(--text-primary)]'].join(' ')}>
                              {opt.label}
                            </span>
                            {active && <Check size={12} className="text-purple-300 shrink-0" />}
                          </div>
                          <div className="text-[10px] text-[var(--text-tertiary)] truncate mt-0.5">{opt.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 自定义模板（上传参考图，AI 提取风格规范作为参照） */}
              <div className="shrink-0">
                <div className="text-[11px] font-semibold text-[var(--text-tertiary)] mb-2">自定义模板</div>
                <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                  {customTemplates.map((t) => {
                    const active = templateId === t.id;
                    return (
                      <div
                        key={t.id}
                        className={[
                          'group relative rounded-xl border overflow-hidden transition-all',
                          active
                            ? 'border-purple-400/70 ring-2 ring-purple-500/30'
                            : 'border-white/10 hover:border-white/25',
                        ].join(' ')}
                      >
                        <button onClick={() => selectCustomTemplate(t)} className="block w-full text-left">
                          <div className="px-4 pt-4 pb-3" style={{ background: t.bgColor, height: 112 }}>
                            <div className="w-8 h-1 rounded-full mb-2" style={{ background: t.accentColor }} />
                            <div className="text-[15px] font-extrabold leading-tight" style={{ color: t.accentColor }}>
                              Aa {t.name.slice(0, 6)}
                            </div>
                            <div className="mt-1.5 h-1.5 w-3/4 rounded" style={{ background: t.accentColor, opacity: 0.25 }} />
                          </div>
                          <div className="flex items-center justify-between px-3 py-2 bg-white/4">
                            <span className={['text-[12px] font-medium truncate', active ? 'text-purple-200' : 'text-[var(--text-secondary)]'].join(' ')}>
                              {t.name}
                            </span>
                            {active && <Check size={12} className="text-purple-300 shrink-0" />}
                          </div>
                        </button>
                        <button
                          onClick={() => void removeTemplate(t)}
                          title={'删除模板：' + t.name}
                          className="absolute top-2 right-2 w-6 h-6 rounded-md bg-black/45 text-white/60 hover:text-red-300 hover:bg-black/65 items-center justify-center hidden group-hover:flex"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}

                  {/* 上传参考图新建（零摩擦：选图即建，名字取文件名） */}
                  <button
                    onClick={() => templateFileRef.current?.click()}
                    disabled={templateBusy}
                    data-testid="gallery-upload-template"
                    className="rounded-xl border border-dashed border-white/15 hover:border-purple-400/50 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] flex flex-col items-center justify-center gap-2 transition-colors disabled:opacity-50"
                    style={{ minHeight: 150 }}
                  >
                    {templateBusy ? <MapSpinner size={18} /> : <ImagePlus size={18} />}
                    <span className="text-[11px] font-medium">
                      {templateBusy ? '正在提取风格（约 10s）...' : '上传参考图新建模板'}
                    </span>
                    <span className="text-[9px] px-4 text-center leading-relaxed">
                      截图 / 海报 / 喜欢的 PPT 页面，AI 提取配色字体版式作为生成参照
                    </span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ─── 大纲编辑器（outline-ready 状态）：右侧大空间直接编辑，即改即存（刷新还在）。
                顶部澄清问卷（AI 有歧义才出现）→ 中间逐页卡片可编辑/增删/上下移 →
                底部「让 AI 调整」。确认生成在头部常驻。 ─── */}
          {artifactPhase === 'idle' && !generatedHtml && outlineDraft && (
            <div className="flex-1 flex flex-col" style={{ minHeight: 0 }} data-testid="outline-editor">
              {/* 头部：摘要 + 页数 + 确认 */}
              <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-white/8">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
                    大纲编辑器
                    {outlineAdjusting ? (
                      <span className="flex items-center gap-1.5 text-[11px] font-normal text-purple-300">
                        <MapSpinner size={11} />
                        AI 正在按你的要求调整（只动相关页，其余逐字保留）...
                      </span>
                    ) : (
                      <span className="text-[11px] font-normal text-[var(--text-tertiary)] tabular-nums">
                        {outlineDraft.outline.length} 页 · 点击编辑 / 拖卡片换位，改动即时保存（刷新不丢）
                      </span>
                    )}
                  </p>
                  {outlineDraft.summary && (
                    <p className="text-[11px] text-[var(--text-tertiary)] truncate mt-0.5">{outlineDraft.summary}</p>
                  )}
                </div>
                <button
                  onClick={confirmOutlineDraft}
                  disabled={isProcessing || outlineDraft.outline.length === 0}
                  data-testid="outline-confirm"
                  className="shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-purple-500/85 text-white hover:bg-purple-500 disabled:opacity-40"
                >
                  <Check size={12} />
                  确认，生成 PPT
                </button>
              </div>

              <div
                className="flex-1 px-5 py-4 flex flex-col gap-3"
                style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
              >
                {/* 澄清问卷（AI 确有歧义才出现；保存即入工作稿，发送给 AI 重排大纲） */}
                {(outlineDraft.clarify?.length ?? 0) > 0 && !outlineDraft.clarifySent && (
                  <div
                    data-testid="clarify-card"
                    className="shrink-0 rounded-xl border border-blue-500/25 bg-blue-500/6 px-4 py-3"
                  >
                    <div className="text-[12px] font-semibold text-blue-300 mb-2">
                      AI 有几个问题想确认（消除歧义，可不答直接生成）
                    </div>
                    <div className="flex flex-col gap-2.5">
                      {(outlineDraft.clarify ?? []).map((q) => {
                        const ans = outlineDraft.clarifyAnswers?.[q.id];
                        const setAns = (v: string | string[]) =>
                          setOutlineDraft((d) => d ? { ...d, clarifyAnswers: { ...(d.clarifyAnswers ?? {}), [q.id]: v } } : d);
                        return (
                          <div key={q.id}>
                            <div className="text-[11px] text-[var(--text-secondary)] mb-1">{q.question}</div>
                            {q.type === 'text' ? (
                              <input
                                type="text"
                                value={typeof ans === 'string' ? ans : ''}
                                onChange={(e) => setAns(e.target.value)}
                                placeholder="输入你的回答..."
                                className="w-full text-[11px] bg-white/5 text-[var(--text-primary)] border border-white/10 rounded-md px-2 py-1.5 outline-none focus:border-blue-500/40"
                              />
                            ) : (
                              <div className="flex flex-wrap gap-1.5">
                                {(q.options ?? []).map((opt) => {
                                  const selected = q.type === 'multi'
                                    ? Array.isArray(ans) && ans.includes(opt)
                                    : ans === opt;
                                  return (
                                    <button
                                      key={opt}
                                      onClick={() => {
                                        if (q.type === 'multi') {
                                          const cur = Array.isArray(ans) ? ans : [];
                                          setAns(selected ? cur.filter((x) => x !== opt) : [...cur, opt]);
                                        } else {
                                          setAns(selected ? '' : opt);
                                        }
                                      }}
                                      className={[
                                        'px-2.5 py-1 rounded-full text-[11px] border transition-colors',
                                        selected
                                          ? 'bg-blue-500/25 border-blue-400/50 text-blue-200 font-medium'
                                          : 'bg-white/4 border-white/10 text-[var(--text-secondary)] hover:bg-white/8',
                                      ].join(' ')}
                                    >
                                      {opt}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2 mt-2.5">
                      <button
                        onClick={() => {
                          const draft = outlineDraft;
                          if (!draft) return;
                          const answered = serializeClarifyAnswers(draft);
                          setOutlineDraft((d) => (d ? { ...d, clarifySent: true } : d));
                          if (answered) {
                            pushMsg({ role: 'user', content: '澄清回答：' + answered.replace('\n\n## 澄清回答\n', ' ').replace(/\n- /g, '；') });
                            requestOutlineAdjust('按上述澄清回答更新大纲内容与侧重。');
                          }
                        }}
                        disabled={isProcessing}
                        data-testid="clarify-send"
                        className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-blue-500/85 text-white hover:bg-blue-500 disabled:opacity-40"
                      >
                        <Send size={10} />
                        保存并发送给 AI
                      </button>
                      <button
                        onClick={() => setOutlineDraft((d) => (d ? { ...d, clarifySent: true } : d))}
                        className="px-2 py-1 rounded-md text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-white/5"
                      >
                        跳过
                      </button>
                    </div>
                  </div>
                )}

                {/* 逐页卡片网格：3:4 竖卡（幻灯缩略卡比例），拖拽换位（抓住卡头序号区拖到目标卡上），
                      换位/AI 改动的卡 1.6s 紫色渐变高亮——变化必须被看见 */}
                <div
                  className={['shrink-0 grid gap-3 transition-opacity', outlineAdjusting ? 'opacity-50 pointer-events-none' : ''].join(' ')}
                  style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(225px, 1fr))' }}
                  data-testid="outline-grid"
                >
                {outlineDraft.outline.map((slide, i) => (
                  <div
                    key={i}
                    draggable
                    onDragStart={(e) => {
                      dragIdxRef.current = i;
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragIdxRef.current;
                      dragIdxRef.current = null;
                      if (from == null || from === i) return;
                      setOutlineDraft((d) => {
                        if (!d) return d;
                        const outline = [...d.outline];
                        const [moved] = outline.splice(from, 1);
                        outline.splice(i, 0, moved);
                        return { ...d, outline };
                      });
                      // 序号渐变：换位涉及的区间全部高亮 1.6s，避免用户感知不到变化
                      const lo = Math.min(from, i);
                      const hi = Math.max(from, i);
                      setFlashCards(new Set(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)));
                      window.setTimeout(() => setFlashCards(new Set()), 1600);
                    }}
                    className={[
                      'rounded-xl border px-3.5 py-3 flex flex-col cursor-grab active:cursor-grabbing',
                      'transition-all duration-700',
                      flashCards.has(i)
                        ? 'border-purple-400/70 bg-purple-500/12 shadow-[0_0_18px_rgba(168,85,247,.25)]'
                        : 'border-white/10 bg-white/3',
                    ].join(' ')}
                    style={{ aspectRatio: '3 / 4', minHeight: 0 }}
                    data-testid={'outline-card-' + i}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        title="按住拖拽换位"
                        className={[
                          'shrink-0 w-6 h-6 rounded-md text-[11px] font-bold tabular-nums flex items-center justify-center transition-colors duration-700',
                          flashCards.has(i) ? 'bg-purple-400/60 text-white' : 'bg-purple-500/15 text-purple-300',
                        ].join(' ')}
                      >
                        {i + 1}
                      </span>
                      <input
                        type="text"
                        value={slide.title}
                        onChange={(e) =>
                          setOutlineDraft((d) => {
                            if (!d) return d;
                            const outline = d.outline.map((sl, j) => (j === i ? { ...sl, title: e.target.value } : sl));
                            return { ...d, outline };
                          })
                        }
                        placeholder="本页标题"
                        className="flex-1 min-w-0 text-[13px] font-semibold bg-transparent text-[var(--text-primary)] border-0 border-b border-transparent focus:border-purple-500/40 outline-none py-0.5"
                      />
                      <button
                        onClick={() => setOutlineDraft((d) => {
                          if (!d) return d;
                          const outline = d.outline.filter((_, j) => j !== i);
                          return { ...d, outline, totalPages: outline.length };
                        })}
                        title="删除本页"
                        className="w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-red-400 hover:bg-white/6 flex items-center justify-center"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    <textarea
                      value={slide.bullets.join('\n')}
                      onChange={(e) =>
                        setOutlineDraft((d) => {
                          if (!d) return d;
                          const bullets = e.target.value.split('\n');
                          const outline = d.outline.map((sl, j) => (j === i ? { ...sl, bullets } : sl));
                          return { ...d, outline };
                        })
                      }
                      onBlur={() =>
                        setOutlineDraft((d) => {
                          if (!d) return d;
                          const outline = d.outline.map((sl, j) =>
                            j === i ? { ...sl, bullets: sl.bullets.map((b) => b.trim()).filter(Boolean) } : sl
                          );
                          return { ...d, outline };
                        })
                      }
                      rows={Math.max(3, slide.bullets.length)}
                      placeholder="每行一条要点"
                      className="w-full flex-1 resize-none text-[11px] leading-relaxed bg-transparent text-[var(--text-secondary)] placeholder-[var(--text-tertiary)] border border-white/6 focus:border-purple-500/30 rounded-md px-2 py-1.5 outline-none"
                      style={{ outline: 'none', boxShadow: 'none', minHeight: 64 }}
                    />
                  </div>
                ))}

                <button
                  onClick={() => setOutlineDraft((d) => {
                    if (!d) return d;
                    const outline = [...d.outline, { title: '', bullets: [''] }];
                    return { ...d, outline, totalPages: outline.length };
                  })}
                  data-testid="outline-add-page"
                  className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/15 hover:border-purple-400/50 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] text-[11px]"
                  style={{ aspectRatio: '3 / 4', minHeight: 0 }}
                >
                  <Plus size={12} />
                  添加一页
                </button>
                </div>

                {/* 让 AI 调整（也可以直接在左侧对话输入，效果相同） */}
                <div className="shrink-0 flex items-center gap-2 pb-1">
                  <Sparkles size={12} className="shrink-0 text-purple-400/70" />
                  <input
                    type="text"
                    value={outlineAiText}
                    onChange={(e) => setOutlineAiText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && outlineAiText.trim() && !isProcessing) {
                        const t = outlineAiText.trim();
                        setOutlineAiText('');
                        pushMsg({ role: 'user', content: t });
                        requestOutlineAdjust(t);
                      }
                    }}
                    disabled={isProcessing}
                    placeholder="让 AI 调整大纲，如：第3页拆成两页讲 / 整体更面向高管..."
                    data-testid="outline-ai-input"
                    className="flex-1 text-[11px] bg-white/4 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] border border-white/10 rounded-lg px-2.5 py-1.5 outline-none focus:border-purple-500/40 disabled:opacity-50"
                    style={{ outline: 'none', boxShadow: 'none' }}
                  />
                  <button
                    onClick={() => {
                      const t = outlineAiText.trim();
                      if (!t || isProcessing) return;
                      setOutlineAiText('');
                      pushMsg({ role: 'user', content: t });
                      requestOutlineAdjust(t);
                    }}
                    disabled={!outlineAiText.trim() || isProcessing}
                    className="shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white/6 text-[var(--text-secondary)] hover:bg-white/10 border border-white/10 disabled:opacity-40"
                  >
                    AI 调整
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Outlining progress：产物形状动画——大纲卡骨架逐张脉冲浮现（产物即体验：
                等的是大纲，看到的就是大纲在长出来的样子，不是一个孤零零的转圈） */}
          {artifactPhase === 'outlining' && (
            <div className="flex-1 flex flex-col px-6 py-5 gap-4" style={{ minHeight: 0, overflow: 'hidden' }}>
              <div className="shrink-0 flex items-center gap-2.5">
                <MapSpinner size={16} />
                <div>
                  <p className="text-sm text-[var(--text-secondary)]">正在规划大纲...</p>
                  <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5">分析内容结构，生成最优页面分配</p>
                </div>
              </div>
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(225px, 1fr))' }}
                aria-hidden
              >
                {Array.from({ length: 8 }, (_, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-white/8 bg-white/3 px-3.5 py-3 flex flex-col gap-2 animate-pulse"
                    style={{ aspectRatio: '3 / 4', minHeight: 0, animationDelay: `${i * 180}ms` }}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-md bg-purple-500/15" />
                      <div className="h-3 rounded bg-white/10" style={{ width: `${55 + ((i * 17) % 30)}%` }} />
                    </div>
                    <div className="h-2 rounded bg-white/6 w-full" />
                    <div className="h-2 rounded bg-white/6" style={{ width: `${60 + ((i * 23) % 30)}%` }} />
                    <div className="h-2 rounded bg-white/6" style={{ width: `${45 + ((i * 13) % 35)}%` }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Generating progress —— Gamma 式实况渲染：等待期的主视觉就是真实幻灯页本身。
                已完成的页流式解析后立即真实渲染（实况 iframe），底部页卡可点击回看任意已完成页；
                第一页出来之前用骨架幻灯 + 代码流尾巴 + Agent 环境准备过渡，全程无静止空等。 */}
          {(artifactPhase === 'generating' || artifactPhase === 'patching') && (() => {
            const pagesMode = pagesTotal > 0;
            const doneCount = pagesMode ? pagesDoneIdxs.length : slideProgress.titles.length;
            const building = pagesMode ? doneCount < pagesTotal : slideProgress.building;
            const totalSlots = pagesMode
              ? pagesTotal
              : Math.max(expectedPages ?? 0, doneCount + (building ? 1 : 0));
            const effLiveDoc = pagesMode ? pagesLiveDoc : liveDoc;
            const effLiveIdx = pagesMode ? pagesLiveIdx : liveIdx;
            const agentPrepared =
              modelInfo != null ||
              diagLines.some((d) => d.stage === 'send' || d.stage === 'first_event' || d.stage === 'first_text_delta');
            const stageText = pagesMode
              ? doneCount === 0
                ? `${pagesTotal} 路子智能体并行绘制中（每页独立设计）...`
                : doneCount < pagesTotal
                  ? `已完成 ${doneCount} / ${pagesTotal} 页（并行绘制中，可点亮起的页卡先看）...`
                  : '全部页面完成，正在拼装 deck...'
              : streamPreview.length === 0
                ? thinkingPreview.length > 0
                  ? '模型深度思考中（推理模型先想后写，思考过程见下方）...'
                  : agentPrepared
                    ? '模型已就绪，正在构思整体设计与版式...'
                    : '正在连接 CDS Agent 环境...'
                : doneCount > 0 || building
                  ? building
                    ? `正在绘制第 ${doneCount + 1} 页${expectedPages ? `（共约 ${expectedPages} 页）` : ''}...`
                    : doneCount >= (expectedPages ?? Infinity)
                      ? '全部页面已生成，正在收尾排版...'
                      : `已完成 ${doneCount} 页，正在排版后续页面...`
                  : genStageMsg(elapsedSec, artifactPhase === 'patching');
            const pct = totalSlots > 0 ? Math.min(99, Math.round((doneCount / totalSlots) * 100)) : 0;
            return (
              <div className="flex-1 flex flex-col gap-2.5 px-4 py-3" style={{ minHeight: 0 }}>
                {/* 状态行 */}
                <div className="shrink-0 flex items-center gap-3">
                  <MapSpinner size={16} />
                  <div className="min-w-0">
                    <p className="text-sm text-[var(--text-secondary)] truncate">{stageText}</p>
                    <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 tabular-nums">
                      已等待 {elapsedSec}s
                      {pagesMode
                        ? ` · ${doneCount}/${pagesTotal} 页完成`
                        : streamPreview.length > 0
                          ? ` · 已接收 ${streamPreview.length.toLocaleString()} 字符`
                          : thinkingPreview.length > 0
                            ? ` · 已思考 ${thinkingPreview.length.toLocaleString()} 字`
                            : ''}
                      {modelInfo && <span className="font-mono"> · {modelInfo.model}</span>}
                    </p>
                  </div>
                  {totalSlots > 0 && (
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                      {doneCount} / {totalSlots} 页
                    </span>
                  )}
                </div>

                {/* 总进度条 */}
                {totalSlots > 0 && (
                  <div className="shrink-0 w-full rounded-full bg-white/6 overflow-hidden" style={{ height: 3 }}>
                    <div
                      className="h-full rounded-full bg-purple-400/80 transition-all duration-700"
                      style={{ width: `${Math.max(pct, streamPreview.length > 0 ? 4 : 0)}%` }}
                    />
                  </div>
                )}

                {/* 主视觉：实况渲染的真实幻灯页（无脚本静态铺版，新页完成才更新，不闪烁） */}
                <div
                  className="flex-1 rounded-lg border border-white/8 overflow-hidden"
                  style={{ minHeight: 0, position: 'relative', background: 'rgba(0,0,0,.25)' }}
                >
                  {effLiveDoc ? (
                    <>
                      <iframe
                        data-testid="live-slide-preview"
                        srcDoc={effLiveDoc}
                        sandbox=""
                        title="生成实况预览"
                        className="w-full h-full border-0"
                      />
                      <div className="absolute top-2 right-2 flex items-center gap-1.5">
                        {liveSlideSel != null && (
                          <button
                            onClick={() => setLiveSlideSel(null)}
                            className="px-2 py-0.5 rounded text-[10px] bg-black/60 text-purple-200 border border-purple-400/40 hover:bg-black/75"
                          >
                            回到最新
                          </button>
                        )}
                        <span className="px-2 py-0.5 rounded text-[10px] bg-black/60 text-white/75 tabular-nums">
                          实况 · 第 {effLiveIdx + 1} 页{liveSlideSel == null ? '（跟随最新）' : ''}
                        </span>
                      </div>
                    </>
                  ) : (
                    /* 第一页出来之前：骨架幻灯 + 代码流尾巴 / Agent 环境准备 */
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-8">
                      <div className="w-full flex flex-col gap-3 animate-pulse" style={{ maxWidth: 460 }} aria-hidden>
                        <div className="h-2.5 w-20 rounded bg-white/8" />
                        <div className="h-7 w-3/4 rounded bg-white/10" />
                        <div className="h-2.5 w-full rounded bg-white/6" />
                        <div className="h-2.5 w-5/6 rounded bg-white/6" />
                        <div className="grid grid-cols-3 gap-3 mt-1.5">
                          <div className="h-14 rounded-lg bg-white/6" />
                          <div className="h-14 rounded-lg bg-white/6" />
                          <div className="h-14 rounded-lg bg-white/6" />
                        </div>
                      </div>

                      {streamPreview.length > 0 && (
                        <div
                          data-testid="stream-preview"
                          className="w-full rounded-lg bg-white/3 border border-white/8 overflow-hidden"
                          style={{ maxWidth: 460 }}
                        >
                          <div className="px-3 py-1.5 text-[9px] text-[var(--text-tertiary)] font-semibold border-b border-white/5 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
                            AI 正在逐字输出 HTML（先写整体样式，第一页马上出现）
                          </div>
                          <div
                            className="px-3 py-2 font-mono text-[10px] leading-relaxed text-[var(--text-tertiary)]"
                            style={{ maxHeight: 84, overflow: 'hidden', wordBreak: 'break-all' }}
                          >
                            <StreamingText text={streamPreview} streaming maxTailChars={320} className="whitespace-pre-wrap" />
                          </div>
                        </div>
                      )}

                    </div>
                  )}
                </div>

                {/* 底部页卡导航：完成的页可点击回看，当前绘制页呼吸闪烁 */}
                {totalSlots > 0 && (
                  <div
                    data-testid="slide-progress-cards"
                    className="shrink-0 flex gap-2 overflow-x-auto pb-1"
                    style={{ overscrollBehavior: 'contain' }}
                  >
                    {Array.from({ length: totalSlots }, (_, i) => {
                      const isDone = pagesMode ? pagesDone[i] != null : i < doneCount;
                      const isCurrent = pagesMode ? !isDone && building : i === doneCount && building;
                      const isViewing = effLiveDoc !== '' && i === effLiveIdx;
                      return (
                        <button
                          key={i}
                          disabled={!isDone}
                          onClick={() => {
                            // 点最新完成页 = 回到「跟随最新」；点其他已完成页 = 锁定查看该页
                            const latest = pagesMode ? pagesLiveIdx : doneCount - 1;
                            setLiveSlideSel(i === latest ? null : i);
                          }}
                          className={[
                            'shrink-0 rounded-md border px-2 pt-1.5 pb-1 text-left transition-colors duration-500',
                            isDone
                              ? 'bg-purple-500/12 border-purple-500/30 cursor-pointer hover:bg-purple-500/20'
                              : isCurrent
                                ? 'bg-white/6 border-purple-500/40 animate-pulse'
                                : 'bg-transparent border-dashed border-white/10',
                            isViewing ? 'ring-2 ring-purple-400/70' : '',
                          ].join(' ')}
                          style={{ width: 104, height: 56 }}
                        >
                          <div className={['text-[9px] tabular-nums', isDone ? 'text-purple-300' : 'text-[var(--text-tertiary)]'].join(' ')}>
                            第 {i + 1} 页
                          </div>
                          <div
                            className={['text-[10px] leading-tight mt-0.5', isDone ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]'].join(' ')}
                            style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                          >
                            {isDone
                              ? (pagesMode ? outlineDraft?.outline[i]?.title : slideProgress.titles[i]) || '已生成'
                              : isCurrent
                                ? '绘制中...'
                                : ''}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Done: iframe preview */}
          {(artifactPhase === 'done' || (artifactPhase === 'idle' && generatedHtml)) && generatedHtml && (
            <div className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
              {/* Toolbar */}
              <div className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-white/8 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => deckNav('prev')}
                    title="上一页"
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-[var(--text-secondary)]"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span
                    data-testid="ppt-page-indicator"
                    className="text-[10px] tabular-nums text-[var(--text-secondary)] min-w-[40px] text-center"
                  >
                    {slidePos ? `${slidePos.cur} / ${slidePos.total}` : '- / -'}
                  </span>
                  <button
                    onClick={() => deckNav('next')}
                    title="下一页"
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-[var(--text-secondary)]"
                  >
                    <ChevronRight size={14} />
                  </button>

                  {/* 模板色点：点击 = AI 参照该模板整体重绘（约 1 分钟，全程流式可见）。
                        官方 10 套 + 自定义模板（参考图提取） */}
                  <div className="flex items-center gap-1.5 ml-2 pl-2.5 border-l border-white/10" data-testid="theme-dots">
                    {THEME_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => switchTheme(opt.value)}
                        disabled={isStreaming}
                        title={'换模板（AI 整体重绘，约 1 分钟）：' + opt.label}
                        className="w-4 h-4 rounded-full transition-transform hover:scale-110 disabled:opacity-40"
                        style={{
                          background: opt.dotBg,
                          border: '2px solid ' + opt.dotRing,
                          boxShadow: templateId == null && theme === opt.value ? '0 0 0 2px rgba(168,85,247,.7)' : 'none',
                        }}
                      />
                    ))}
                    {customTemplates.length > 0 && <span className="w-px h-3.5 bg-white/10" />}
                    {customTemplates.slice(0, 6).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => selectCustomTemplate(t)}
                        disabled={isStreaming}
                        title={'换模板（AI 整体重绘，约 1 分钟）：' + t.name}
                        className="w-4 h-4 rounded-full transition-transform hover:scale-110 disabled:opacity-40"
                        style={{
                          background: t.bgColor,
                          border: '2px solid ' + t.accentColor,
                          boxShadow: templateId === t.id ? '0 0 0 2px rgba(168,85,247,.7)' : 'none',
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  {/* 模型 chip：只读展示本次生成实际使用的模型（CDS Agent 运行配置决定） */}
                  {modelInfo && (
                    <span
                      data-testid="model-chip"
                      title="本次生成使用的模型（由 CDS Agent 运行配置决定）"
                      className="px-2 py-1 rounded-md text-[10px] font-mono bg-white/4 text-[var(--text-tertiary)] border border-white/8 max-w-[200px] truncate"
                    >
                      {modelInfo.model} · {modelInfo.platform}
                    </span>
                  )}
                  <button
                    onClick={() => setFeedbackMode((v) => !v)}
                    disabled={isStreaming || editMode}
                    title="圈选反馈：拖框圈出要修改的区域，写一句要求，自动组装成精修指令"
                    className={[
                      'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border disabled:opacity-40',
                      feedbackMode
                        ? 'bg-purple-500/25 text-purple-200 border-purple-500/40 font-semibold'
                        : 'bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 border-white/10',
                    ].join(' ')}
                  >
                    <BoxSelect size={11} />
                    圈选反馈
                  </button>
                  <button
                    onClick={toggleEditMode}
                    disabled={isStreaming}
                    title={editMode ? '完成编辑并保存修改' : '直接编辑：点击幻灯片文字修改内容、调整字号'}
                    className={[
                      'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border disabled:opacity-40',
                      editMode
                        ? 'bg-purple-500/25 text-purple-200 border-purple-500/40 font-semibold'
                        : 'bg-white/5 text-[var(--text-secondary)] hover:bg-white/10 border-white/10',
                    ].join(' ')}
                  >
                    {editMode ? <Check size={11} /> : <Pencil size={11} />}
                    {editMode ? '完成编辑' : '编辑内容'}
                  </button>
                  <button
                    onClick={handleDownload}
                    title="下载独立 HTML（含当前主题样式，双击即可演示）"
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-[var(--text-secondary)]"
                  >
                    <Download size={13} />
                  </button>
                  <button
                    onClick={handleFullscreen}
                    title="全屏演示"
                    className="flex items-center justify-center w-7 h-7 rounded-md bg-white/5 hover:bg-white/10 border border-white/10 text-[var(--text-secondary)]"
                  >
                    <Maximize2 size={13} />
                  </button>
                </div>
              </div>

              {/* 编辑模式提示条 */}
              {editMode && (
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-purple-500/10 border-b border-purple-500/20 text-[11px] text-purple-300">
                  <Pencil size={11} className="shrink-0" />
                  <span>
                    编辑模式：点击幻灯片里的文字直接修改，悬浮工具条 A+/A- 调字号，Esc 取消选中；点「完成编辑」保存
                  </span>
                  {dirtyEdits && (
                    <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-500/30">
                      已记录修改
                    </span>
                  )}
                </div>
              )}

              {/* 下一步引导条：生成完成后给出动作建议（借鉴 open-design NextStepActions，seed 不自动发送） */}
              {!editMode && !feedbackMode && !isStreaming && (
                <NextStepBar
                  onPublish={() => void handlePublish()}
                  publishBusy={isPublishing}
                  published={!!publishedUrl}
                  onDownload={handleDownload}
                  onSeedPatch={(t) => {
                    setInput(t);
                    inputRef.current?.focus();
                  }}
                />
              )}

              {/* iframe —— sandbox="allow-scripts"（opaque origin，无 same-origin）
                    配合上方 prepareIframeHtml() 注入的 storage shim，
                    reveal.js init 不会因 storage 访问抛错导致整页空白。
                    生成 HTML 中的 <script> 无法访问主应用的 token/cookie/storage。
                    翻页/页码/编辑/页位恢复/圈选反查全部走 postMessage 通道（见 controlScript/editorScript）。 */}
              <div ref={previewWrapRef} className="flex-1 flex flex-col bg-black" style={{ minHeight: 0, position: 'relative' }}>
                <iframe
                  ref={iframeRef}
                  className="flex-1 w-full border-0"
                  srcDoc={prepareIframeHtml(generatedHtml, { editor: editMode })}
                  sandbox="allow-scripts"
                  title="PPT 预览"
                  style={{ minHeight: 0 }}
                />
                {/* 圈选反馈遮罩（借鉴 open-design PreviewDrawOverlay 极简版） */}
                <SelectionFeedbackOverlay
                  active={feedbackMode}
                  onCancel={() => setFeedbackMode(false)}
                  onSubmit={handleFeedbackSubmit}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* History modal：历史生成列表，点击载入继续精修/编辑/发布 */}
      {showHistory && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40" onClick={() => setShowHistory(false)}>
          <div
            data-testid="history-modal"
            className="w-[560px] rounded-xl border border-white/10 bg-[var(--bg-elevated)] shadow-xl"
            style={{ maxHeight: '72vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/8">
              <span className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <History size={13} className="text-purple-400" />
                历史生成
              </span>
              <button onClick={() => setShowHistory(false)} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                <X size={14} />
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
              {historyLoading && (
                <div className="flex justify-center py-8"><MapSpinner size={16} /></div>
              )}
              {!historyLoading && historyRuns.length === 0 && (
                <div className="py-10 text-center text-xs text-[var(--text-tertiary)]">
                  还没有历史生成。左侧发个需求，生成的每一份 PPT 都会留在这里，随时回来继续改。
                </div>
              )}
              {!historyLoading && historyRuns.map((r) => (
                <button
                  key={r.id}
                  onClick={() => void loadHistoryRun(r)}
                  disabled={!r.hasHtml || historyOpeningId != null}
                  title={r.hasHtml ? '载入这份 PPT 继续精修/编辑/发布' : '该次运行没有产物（' + r.status + '）'}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/4 border-b border-white/5 text-left disabled:opacity-45"
                >
                  {historyOpeningId === r.id ? (
                    <MapSpinner size={13} />
                  ) : (
                    <FileText size={13} className={r.hasHtml ? 'shrink-0 text-purple-400' : 'shrink-0 text-[var(--text-tertiary)]'} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-[var(--text-primary)] truncate">
                      {r.title || '未命名 PPT'}
                    </div>
                    <div className="text-[10px] text-[var(--text-tertiary)] truncate mt-0.5">
                      {r.contentPreview || '（无内容预览）'}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={[
                      'text-[9px] px-1.5 py-0.5 rounded inline-block',
                      r.status === 'done' ? 'bg-green-500/10 text-green-400'
                        : r.status === 'error' ? 'bg-red-500/10 text-red-400'
                          : 'bg-white/8 text-[var(--text-tertiary)]',
                    ].join(' ')}>
                      {r.status === 'done' ? '已完成' : r.status === 'error' ? '失败' : '生成中'}
                    </div>
                    <div className="text-[9px] text-[var(--text-tertiary)] mt-1 tabular-nums">
                      {new Date(r.createdAt).toLocaleString()}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* KB picker modal */}
      {showKbPicker && (
        <KbPicker onClose={() => setShowKbPicker(false)} onSelect={handleKbSelect} />
      )}

      {/* Plus menu backdrop */}
      {showPlusMenu && (
        <div
          className="fixed inset-0 z-[5]"
          onClick={() => setShowPlusMenu(false)}
        />
      )}
    </div>
  );
}

export default MdToPptAgentPage;
