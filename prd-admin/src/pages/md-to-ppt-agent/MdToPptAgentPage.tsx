import { useCallback, useEffect, useRef, useState } from 'react';
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
  Bot,
  Zap,
  ChevronDown,
  Check,
  AlertCircle,
  RotateCcw,
  Pencil,
  Download,
  Maximize2,
  BoxSelect,
} from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  type MdToPptDiagEvent,
  type MdToPptEngine,
  type OutlineSlide,
  streamMdToPptConvert,
  streamMdToPptPatch,
  publishMdToPpt,
  getMdToPptRun,
  getMdToPptOutline,
  getMdToPptModels,
} from '@/services/real/mdToPptService';
import { apiRequest } from '@/services/real/apiClient';
import { NextStepBar } from './NextStepBar';
import { ModelChipPopover } from './ModelChipPopover';
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

interface SessionState {
  messages: ChatMessage[];
  activeRunId: string;
  theme: string;
  engine: MdToPptEngine;
  /** 直出引擎期望模型（'' = 自动调度） */
  model?: string;
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

// dotBg/dotRing 用于预览工具栏的主题快速切换色点（即时换肤，无需重新生成）
const THEME_OPTIONS = [
  { value: 'tech-dark', label: 'Tech 极黑', dotBg: '#0d1117', dotRing: '#7ee787' },
  { value: 'cobalt-grid', label: '钴蓝格纸', dotBg: '#F0EBDE', dotRing: '#1F2BE0' },
  { value: 'editorial-ink', label: '纸墨编辑', dotBg: '#f1efea', dotRing: '#0a0a0b' },
  { value: 'warm-zine', label: '复古 Zine', dotBg: '#C8B99A', dotRing: '#008F4D' },
  { value: 'swiss-minimal', label: 'Swiss 极简', dotBg: '#fafaf8', dotRing: '#002FA7' },
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

// 主题 CSS 覆盖层（open-design 风格，前端注入到 iframe）
// 策略：用 !important 直接覆盖 reveal.js 自身 CSS，确保无论 LLM 输出什么主题色都正确
const THEME_CSS_OVERRIDES: Record<string, string> = {
  // Tech 极黑：GitHub-dark 风格，绿色 mono 标题，代码感
  'tech-dark':
    ':root{--bg:#0d1117;--bg2:#161b22;--ink:#e6edf3;--muted:#8b949e;--line:rgba(139,148,158,.22);--card:#161b22;--a1:#7ee787;--a2:#79c0ff;--a3:#d2a8ff;--orb-op:.14;}' +
    'html,body,.reveal,.reveal-viewport{background:#0d1117!important;}' +
    '.reveal{color:#e6edf3!important;}' +
    '.reveal .slides section{background:transparent!important;color:#e6edf3!important;}' +
    '.reveal h1,.reveal h2,.reveal h3,.reveal h4,.reveal h5,.reveal h6{color:#7ee787!important;font-family:"JetBrains Mono","IBM Plex Mono",monospace!important;font-weight:700!important;letter-spacing:-.02em!important;}' +
    '.reveal p,.reveal li,.reveal td,.reveal th{color:#e6edf3!important;}' +
    '.reveal blockquote{color:#8b949e!important;border-left:3px solid #7ee787!important;}' +
    '.reveal a{color:#79c0ff!important;}' +
    '.reveal .progress span{background:#7ee787!important;}' +
    '.reveal .controls button{color:#7ee787!important;}' +
    '.reveal .slides section::before{content:"";position:absolute;inset:0;background:radial-gradient(600px 500px at 90% 0%,rgba(126,231,135,.1),transparent 70%),radial-gradient(500px 400px at 10% 100%,rgba(121,192,255,.08),transparent 70%);pointer-events:none;z-index:0;}',
  // 钴蓝格纸：cream paper + electric cobalt，带格纸底纹，Newsreader 斜体
  'cobalt-grid':
    ':root{--bg:#F0EBDE;--bg2:#E6E0CE;--ink:#1F2BE0;--muted:#5560E5;--line:rgba(31,43,224,.2);--card:rgba(31,43,224,.06);--a1:#1F2BE0;--a2:#5560E5;--a3:#002FA7;--orb-op:0;}' +
    'html,body,.reveal,.reveal-viewport{background-color:#F0EBDE!important;background-image:linear-gradient(rgba(31,43,224,.09) 1px,transparent 1px),linear-gradient(to right,rgba(31,43,224,.09) 1px,transparent 1px)!important;background-size:40px 40px!important;}' +
    '.reveal{color:#1F2BE0!important;}' +
    '.reveal .slides section{background:transparent!important;color:#1F2BE0!important;}' +
    '.reveal h1,.reveal h2{font-family:"Newsreader",Georgia,serif!important;font-style:italic!important;font-weight:400!important;color:#1F2BE0!important;line-height:.92!important;}' +
    '.reveal h3,.reveal h4,.reveal h5,.reveal h6{font-family:"Hanken Grotesk","Inter",sans-serif!important;font-weight:700!important;color:#1F2BE0!important;text-transform:uppercase!important;letter-spacing:.12em!important;font-style:normal!important;}' +
    '.reveal p,.reveal li,.reveal td,.reveal th{color:#1F2BE0!important;}' +
    '.reveal a{color:#002FA7!important;}' +
    '.reveal .progress span{background:#1F2BE0!important;}' +
    '.reveal .controls button{color:#1F2BE0!important;}',
  // 纸墨编辑：杂志风，Playfair Display 斜体大标，暖纸底
  'editorial-ink':
    ':root{--bg:#f1efea;--bg2:#e8e4dc;--ink:#0a0a0b;--muted:#3a382f;--line:rgba(10,10,11,.15);--card:#ffffff;--a1:#0a0a0b;--a2:#3a382f;--a3:#6b665b;--orb-op:0;}' +
    'html,body,.reveal,.reveal-viewport{background:#f1efea!important;}' +
    '.reveal{color:#0a0a0b!important;}' +
    '.reveal .slides section{background:transparent!important;color:#0a0a0b!important;}' +
    '.reveal h1,.reveal h2{font-family:"Playfair Display","Noto Serif SC",Georgia,serif!important;font-style:italic!important;font-weight:500!important;color:#0a0a0b!important;line-height:.95!important;letter-spacing:-.01em!important;}' +
    '.reveal h3,.reveal h4,.reveal h5,.reveal h6{font-family:"Inter","Noto Sans SC",sans-serif!important;font-weight:700!important;color:#0a0a0b!important;letter-spacing:.1em!important;text-transform:uppercase!important;font-style:normal!important;font-size:.75em!important;}' +
    '.reveal p,.reveal li{color:#0a0a0b!important;font-family:"Inter","Noto Sans SC",sans-serif!important;}' +
    '.reveal td,.reveal th{color:#0a0a0b!important;}' +
    '.reveal blockquote{color:#3a382f!important;border-left:3px solid #0a0a0b!important;}' +
    '.reveal a{color:#0a0a0b!important;text-decoration:underline!important;}' +
    '.reveal .progress span{background:#0a0a0b!important;}' +
    '.reveal .controls button{color:#0a0a0b!important;}',
  // 复古 Zine：暖褐色 + 墨绿，Space Grotesk，报纸/Zine 质感
  'warm-zine':
    ':root{--bg:#C8B99A;--bg2:#B8A98A;--ink:#1A1A1A;--muted:#3d3830;--line:rgba(26,26,26,.25);--card:#F4EFE6;--a1:#008F4D;--a2:#00A85D;--a3:#006B3A;--orb-op:0;}' +
    'html,body,.reveal,.reveal-viewport{background:#C8B99A!important;}' +
    '.reveal{color:#1A1A1A!important;}' +
    '.reveal .slides section{background:transparent!important;color:#1A1A1A!important;}' +
    '.reveal h1,.reveal h2{font-family:"Space Grotesk","Inter",sans-serif!important;font-weight:700!important;color:#1A1A1A!important;line-height:.92!important;letter-spacing:-.02em!important;}' +
    '.reveal h3,.reveal h4,.reveal h5,.reveal h6{font-family:"Space Grotesk","Inter",sans-serif!important;font-weight:600!important;color:#008F4D!important;text-transform:uppercase!important;letter-spacing:.16em!important;font-size:.78em!important;}' +
    '.reveal p,.reveal li{color:#1A1A1A!important;font-family:"Space Grotesk","Inter",sans-serif!important;}' +
    '.reveal td,.reveal th{color:#1A1A1A!important;}' +
    '.reveal blockquote{color:#3d3830!important;border-left:3px solid #008F4D!important;}' +
    '.reveal a{color:#008F4D!important;}' +
    '.reveal .progress span{background:#008F4D!important;}' +
    '.reveal .controls button{color:#008F4D!important;}',
  // Swiss 极简：IKB 蓝（#002FA7）+ 近白，极简排版，发卡线
  'swiss-minimal':
    ':root{--bg:#fafaf8;--bg2:#f0ede8;--ink:#0a0a0a;--muted:#555;--line:rgba(10,10,10,.12);--card:#ffffff;--a1:#002FA7;--a2:#4455cc;--a3:#001d85;--orb-op:0;}' +
    'html,body,.reveal,.reveal-viewport{background:#fafaf8!important;}' +
    '.reveal{color:#0a0a0a!important;}' +
    '.reveal .slides section{background:transparent!important;color:#0a0a0a!important;}' +
    '.reveal h1,.reveal h2{font-family:"Inter","Noto Sans SC",sans-serif!important;font-weight:900!important;color:#0a0a0a!important;line-height:.95!important;letter-spacing:-.03em!important;text-transform:uppercase!important;}' +
    '.reveal h3,.reveal h4,.reveal h5,.reveal h6{font-family:"Inter","Noto Sans SC",sans-serif!important;font-weight:600!important;color:#002FA7!important;text-transform:uppercase!important;letter-spacing:.14em!important;font-size:.72em!important;}' +
    '.reveal p,.reveal li{color:#0a0a0a!important;}' +
    '.reveal td,.reveal th{color:#0a0a0a!important;}' +
    '.reveal th{color:#002FA7!important;font-weight:700!important;letter-spacing:.08em!important;}' +
    '.reveal blockquote{color:#555!important;border-left:2px solid #002FA7!important;}' +
    '.reveal a{color:#002FA7!important;}' +
    '.reveal .progress span{background:#002FA7!important;}' +
    '.reveal .controls button{color:#002FA7!important;}' +
    '.reveal .slides section::before{content:"";position:absolute;top:24px;left:40px;right:40px;height:1px;background:rgba(0,47,167,.3);pointer-events:none;}' +
    '.reveal .slides section::after{content:"";position:absolute;bottom:24px;left:40px;right:40px;height:1px;background:rgba(0,47,167,.15);pointer-events:none;}',
};

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

function prepareIframeHtml(html: string, theme?: string, opts?: { editor?: boolean }): string {
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
      'var SEL="h1,h2,h3,h4,h5,h6,p,li,blockquote,td,th";var cur=null;var t=null;' +
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

  // 5. 主题 CSS 强制覆盖（放在 </head> 前，最高级联叠加层，确保 LLM 输出的主题始终正确）
  const themeCss = THEME_CSS_OVERRIDES[theme ?? 'tech-dark'] ?? THEME_CSS_OVERRIDES['tech-dark'];
  const themeOverride = '<style id="__map_theme_override__" data-map-inject>' + themeCss + '</style>';

  const headInject = storageshim + navguard + controlScript + editorScript + FONT_LINKS;

  let result = html;
  if (/<head[^>]*>/i.test(result)) {
    result = result.replace(/<head[^>]*>/i, (m) => m + headInject);
  } else if (/<html[^>]*>/i.test(result)) {
    result = result.replace(/<html[^>]*>/i, (m) => m + headInject);
  } else {
    result = headInject + result;
  }
  // 主题覆盖注入到 </head> 前（LLM CSS 之后，优先级最高）
  if (/<\/head>/i.test(result)) {
    result = result.replace(/<\/head>/i, themeOverride + '</head>');
  } else {
    result = result + themeOverride;
  }
  return result;
}

// 导出/发布用 HTML：只带字体 + 主题覆盖（保持当前预览观感），不带 shim/编辑器等运行时注入。
// 修复历史 bug：以前发布的是 LLM 原始 HTML，前端注入的主题 CSS 没带上，发布出去主题全丢。
function prepareExportHtml(html: string, theme?: string): string {
  if (!html) return html;
  const themeCss = THEME_CSS_OVERRIDES[theme ?? 'tech-dark'] ?? THEME_CSS_OVERRIDES['tech-dark'];
  const block = FONT_LINKS + '<style id="__map_theme_override__">' + themeCss + '</style>';
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, block + '</head>');
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + block);
  return block + html;
}

// 从生成 HTML 提取 <title>，用作下载文件名与发布标题
function extractDeckTitle(html: string): string {
  const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return m ? m[1].trim() : '';
}

// 生成阶段提示文案
function genStageMsg(sec: number, isPatch: boolean): string {
  if (isPatch)
    return sec < 8 ? '正在理解修改指令...' : sec < 25 ? '正在重排指定页面...' : '正在收尾排版...';
  if (sec < 5) return '正在分析内容结构...';
  if (sec < 18) return '正在设计版式与配色...';
  if (sec < 38) return '正在逐页生成幻灯片...';
  if (sec < 60) return '正在排版与收尾...';
  return '内容较多，正在精修中（大模型生成约需 1 分钟）...';
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

// ─── KB 选择迷你弹层 ──────────────────────────────────────────────────────────

interface KbPickerProps {
  onClose: () => void;
  onSelect: (ref: KbRef) => void;
}

function KbPicker({ onClose, onSelect }: KbPickerProps) {
  const [stores, setStores] = useState<KbStore[]>([]);
  const [selectedStore, setSelectedStore] = useState<KbStore | null>(null);
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [entryLoading, setEntryLoading] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiRequest<{ items: KbStore[] }>('/api/document-store/stores?pageSize=50')
      .then((res) => {
        if (res.success && res.data) setStores(res.data.items ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  const openStore = useCallback(async (store: KbStore) => {
    setSelectedStore(store);
    setLoading(true);
    const res = await apiRequest<{ items: KbEntry[] }>(
      `/api/document-store/stores/${encodeURIComponent(store.id)}/entries?pageSize=200&all=true`
    );
    if (res.success && res.data) setEntries(res.data.items ?? []);
    setLoading(false);
  }, []);

  const pickEntry = useCallback(
    async (entry: KbEntry) => {
      if (!selectedStore) return;
      setEntryLoading(entry.id);
      const res = await apiRequest<{ content: string | null; title: string }>(
        `/api/document-store/entries/${encodeURIComponent(entry.id)}/content`
      );
      setEntryLoading(null);
      if (res.success && res.data) {
        onSelect({
          storeName: selectedStore.name,
          entryTitle: res.data.title || entry.title,
          content: res.data.content ?? '',
        });
      }
    },
    [selectedStore, onSelect]
  );

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-80 rounded-xl border border-white/10 bg-[var(--bg-elevated)] shadow-xl"
        style={{ maxHeight: '70vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/8">
          <span className="text-sm font-semibold text-[var(--text-primary)]">
            {selectedStore ? selectedStore.name : '选择知识库'}
          </span>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
          >
            <X size={14} />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading && (
            <div className="flex justify-center py-6">
              <MapSpinner size={16} />
            </div>
          )}

          {!loading && !selectedStore &&
            stores.map((st) => (
              <button
                key={st.id}
                onClick={() => void openStore(st)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/4 border-b border-white/5 text-left"
              >
                <BookOpen size={14} className="shrink-0 text-blue-400" />
                <div>
                  <div className="text-xs font-medium text-[var(--text-primary)]">{st.name}</div>
                  <div className="text-[10px] text-[var(--text-tertiary)]">
                    {st.documentCount} 篇文档
                  </div>
                </div>
              </button>
            ))}

          {!loading &&
            selectedStore &&
            entries.map((entry) => (
              <button
                key={entry.id}
                onClick={() => void pickEntry(entry)}
                disabled={entryLoading === entry.id}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/4 border-b border-white/5 text-left disabled:opacity-50"
              >
                {entryLoading === entry.id ? (
                  <MapSpinner size={12} />
                ) : (
                  <FileText size={12} className="shrink-0 text-[var(--text-tertiary)]" />
                )}
                <div className="min-w-0">
                  <div className="text-xs text-[var(--text-primary)] truncate">{entry.title}</div>
                  {entry.summary && (
                    <div className="text-[10px] text-[var(--text-tertiary)] truncate">
                      {entry.summary}
                    </div>
                  )}
                </div>
              </button>
            ))}

          {!loading && selectedStore && entries.length === 0 && (
            <div className="py-6 text-center text-xs text-[var(--text-tertiary)]">
              该知识库暂无文档
            </div>
          )}
        </div>

        {selectedStore && (
          <div className="shrink-0 px-4 py-2 border-t border-white/8">
            <button
              onClick={() => { setSelectedStore(null); setEntries([]); }}
              className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              返回知识库列表
            </button>
          </div>
        )}
      </div>
    </div>
  );
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
  const [theme, setTheme] = useState(savedSession?.theme ?? 'tech-dark');
  const [engine, setEngine] = useState<MdToPptEngine>(savedSession?.engine ?? 'map');
  const [model, setModel] = useState(savedSession?.model ?? '');
  const [chatModels, setChatModels] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);

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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // ─── Elapsed timer for artifact progress
  useEffect(() => {
    if (artifactPhase === 'generating' || artifactPhase === 'patching') {
      setElapsedSec(0);
      const t = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
      return () => window.clearInterval(t);
    } else {
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
  // (theme/engine/messages are already restored via lazy useState above)
  useEffect(() => {
    const runId = savedSession?.activeRunId;
    if (!runId) return;

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const run = await getMdToPptRun(runId);
      if (cancelled) return;
      if (!run) return;
      if (run.status === 'done' && run.html) {
        setGeneratedHtml(run.html);
        setActiveRunId(runId);
        setArtifactPhase('done');
      } else if (run.status === 'running') {
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
    saveSession({ messages, activeRunId, theme, engine, model });
  }, [messages, activeRunId, theme, engine, model]);

  // ─── 模型列表惰性拉取（设置面板展开 / 工具栏模型 chip 打开时共用）
  const loadModels = useCallback(() => {
    if (chatModels.length > 0) return;
    void getMdToPptModels().then((r) => {
      if (r && r.items.length > 0) setChatModels(r.items.map((i) => i.model));
    });
  }, [chatModels.length]);

  useEffect(() => {
    if (showSettings) loadModels();
  }, [showSettings, loadModels]);

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

  // ─── 主题切换（编辑中先落盘编辑稿，避免 iframe 重载丢修改）
  const switchTheme = useCallback(
    (value: string) => {
      pendingRestoreRef.current = restoreSlideRef.current; // 换主题触发 iframe 重载，先快照页位
      if (editMode && editedHtmlRef.current) commitEdits();
      setTheme(value);
    },
    [editMode, commitEdits]
  );

  // ─── 全屏演示
  const handleFullscreen = useCallback(() => {
    void previewWrapRef.current?.requestFullscreen?.();
  }, []);

  // ─── 下载独立 HTML（含当前主题样式，可直接双击打开演示）
  const handleDownload = useCallback(() => {
    const base = latestHtml();
    if (!base) return;
    const out = prepareExportHtml(base, theme);
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
  }, [latestHtml, theme]);

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
    async (userText: string, attachments: Attachment[], kbRefs: KbRef[]) => {
      setIsProcessing(true);
      setArtifactPhase('outlining');
      setDiagLines([]);

      const attachmentText = attachments.map((a) => `## 附件：${a.name}\n\n${a.content}`).join('\n\n');
      const kbContext = kbRefs.map((r) => `## 知识库「${r.storeName}」>「${r.entryTitle}」\n\n${r.content}`).join('\n\n');

      // 历史摘要：只取最近 3 轮用户消息
      const historyMsgs = messages.filter((m) => m.role === 'user').slice(-3);
      const chatHistory = historyMsgs.map((m) => `用户: ${m.content}`).join('\n');

      const targetPages = estimatePages(userText + attachmentText + kbContext);

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
        setArtifactPhase('idle');
        return;
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                content: '大纲已生成，请确认后生成 PPT：',
                phase: 'outline',
                outline: result.data.outline,
                totalPages: result.data.totalPages,
                summary: result.data.summary,
              }
            : m
        )
      );

      setIsProcessing(false);
      setArtifactPhase('idle');
    },
    [messages, pushMsg]
  );

  // ─── Convert flow（确认大纲后执行）
  const startConvert = useCallback(
    (outlineMsg: ChatMessage) => {
      if (isProcessing) return;

      // 找对应的用户消息（大纲消息之前最近的 user 消息）
      const msgIdx = messages.findIndex((m) => m.id === outlineMsg.id);
      const userMsg = [...messages.slice(0, msgIdx)].reverse().find((m) => m.role === 'user');
      const userContent = userMsg?.content ?? '';
      const attachmentText = (userMsg?.attachments ?? [])
        .map((a) => `## 附件：${a.name}\n\n${a.content}`)
        .join('\n\n');
      const kbContext = (userMsg?.kbRefs ?? [])
        .map((r) => `## KB「${r.storeName}」>「${r.entryTitle}」\n\n${r.content}`)
        .join('\n\n');

      // 大纲结构注入
      const outlineText = (outlineMsg.outline ?? [])
        .map((s, i) => `${i + 1}. ${s.title}\n${s.bullets.map((b) => `   - ${b}`).join('\n')}`)
        .join('\n');

      const fullContent =
        [userContent, attachmentText, kbContext]
          .filter(Boolean)
          .join('\n\n---\n\n')
          .trim() +
        (outlineText ? `\n\n---\n\n## 大纲结构（请严格按此页数和标题生成）\n\n${outlineText}` : '');

      setIsProcessing(true);
      setArtifactPhase('generating');
      setPublishedUrl('');
      setFeedbackMode(false);
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
        slideCount: outlineMsg.totalPages,
        engine,
        model: engine === 'map' ? model : undefined,
        onRun: (runId) => {
          if (runId) setActiveRunId(runId);
          try {
            sessionStorage.setItem(SESSION_KEY + '-run', runId);
          } catch { /* ignore */ }
        },
        onModel: (info) => setModelInfo(info),
        onDiag: (d) => setDiagLines((prev) => [...prev, d]),
        onDelta: () => {},
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
    [isProcessing, messages, pushMsg, theme, engine, model]
  );

  // ─── Patch flow（对话式精修）。baseHtml 允许携带编辑模式未提交的最新稿。
  const startPatch = useCallback(
    (instruction: string, baseHtml?: string) => {
      const base = baseHtml ?? generatedHtml;
      if (!base || isProcessing) return;

      setIsProcessing(true);
      setArtifactPhase('patching');
      pendingRestoreRef.current = restoreSlideRef.current; // 精修完成重载后回到当前页

      const patchMsg = pushMsg({
        role: 'assistant',
        content: '正在修改 PPT...',
        phase: 'patching',
      });

      const cleanup = streamMdToPptPatch({
        currentHtml: base,
        slideRequest: instruction,
        engine,
        model: engine === 'map' ? model : undefined,
        onRun: (runId) => {
          if (runId) setActiveRunId(runId);
        },
        onModel: (info) => setModelInfo(info),
        onDiag: (d) => setDiagLines((prev) => [...prev, d]),
        onDelta: () => {},
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
    [generatedHtml, isProcessing, pushMsg, engine, model]
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

      void requestOutline(userContent + '\n\n调整要求：' + instruction, [], []);
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

    // 决策：如果已有 HTML → patch；否则 → 请求大纲
    if (generatedHtml) {
      // 对话精修模式。若编辑模式有未提交修改，以编辑稿为基底并先落盘。
      const base = latestHtml();
      if (editMode) {
        commitEdits();
        setEditMode(false);
      }
      startPatch(text, base);
    } else {
      // 初次生成：大纲先行
      void requestOutline(text, atts, kbs);
    }
  }, [input, isProcessing, pendingAttachments, pendingKbRefs, generatedHtml, pushMsg, startPatch, requestOutline, latestHtml, editMode, commitEdits]);

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
      htmlContent: prepareExportHtml(base, theme),
      title: extractDeckTitle(base) || 'PPT 演示',
    });
    setIsPublishing(false);
    if (result.success && result.siteUrl) {
      setPublishedUrl(result.siteUrl);
    }
  }, [latestHtml, editMode, commitEdits, theme]);

  // ─── Abort
  const handleAbort = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setIsProcessing(false);
    setArtifactPhase(generatedHtml ? 'done' : 'idle');
    updateLastAssistantMsg({ content: '已中止。', phase: 'text' });
  }, [generatedHtml, updateLastAssistantMsg]);

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
    editedHtmlRef.current = '';
    restoreSlideRef.current = 0;
    pendingRestoreRef.current = null;
    if (pendingRectRef.current) {
      window.clearTimeout(pendingRectRef.current.timer);
      pendingRectRef.current = null;
    }
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }, []);

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
          {/* 设置收起区 */}
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] px-2 py-1 rounded-md hover:bg-white/4"
          >
            设置
            <ChevronDown
              size={10}
              className={`transition-transform ${showSettings ? 'rotate-180' : ''}`}
            />
          </button>

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
            onClick={handleReset}
            title="新建对话"
            className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-white/5"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      {/* Settings panel（收起） */}
      {showSettings && (
        <div className="shrink-0 flex items-center gap-4 px-4 py-2 border-b border-white/6 bg-white/2 text-[11px]">
          {/* 引擎 */}
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-tertiary)]">引擎</span>
            <div className="flex rounded-md border border-white/10 overflow-hidden">
              <button
                onClick={() => setEngine('map')}
                className={[
                  'flex items-center gap-1 px-2 py-1',
                  engine === 'map' ? 'bg-purple-500/20 text-purple-300' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                ].join(' ')}
              >
                <Zap size={9} /> MAP
              </button>
              <button
                onClick={() => setEngine('agent')}
                className={[
                  'flex items-center gap-1 px-2 py-1 border-l border-white/10',
                  engine === 'agent' ? 'bg-blue-500/20 text-blue-300' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                ].join(' ')}
              >
                <Bot size={9} /> Agent
              </button>
            </div>
          </div>

          {/* 模型（仅直出引擎可切换；Agent 引擎模型由运行配置决定） */}
          {engine === 'map' && (
            <div className="flex items-center gap-1.5">
              <span className="text-[var(--text-tertiary)]">模型</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                data-testid="model-select"
                className="appearance-none text-[11px] py-1 pl-2 pr-5 rounded-md bg-white/5 text-[var(--text-primary)] border border-white/8 outline-none cursor-pointer max-w-[220px]"
              >
                <option value="">自动（默认池调度）</option>
                {chatModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 风格 */}
          <div className="flex items-center gap-1.5">
            <span className="text-[var(--text-tertiary)]">风格</span>
            <select
              value={theme}
              onChange={(e) => switchTheme(e.target.value)}
              className="appearance-none text-[11px] py-1 pl-2 pr-5 rounded-md bg-white/5 text-[var(--text-primary)] border border-white/8 outline-none cursor-pointer"
            >
              {THEME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

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

        {/* ─── Left: Chat panel ─────────────────────────────────────────────── */}
        <div
          className="w-[340px] shrink-0 flex flex-col border-r border-white/8"
          style={{ minHeight: 0 }}
        >
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

                  {/* Assistant: generating / patching / outlining */}
                  {msg.role === 'assistant' &&
                    (msg.phase === 'generating' || msg.phase === 'patching') && (
                      <div className="flex items-center gap-2">
                        <MapSpinner size={11} />
                        <span>{msg.content}</span>
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
              className="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-white/4 px-2.5 pt-2.5 pb-2 transition-colors focus-within:border-purple-500/45 focus-within:bg-white/6"
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
                className="w-full resize-none text-xs leading-relaxed bg-transparent text-[var(--text-primary)] placeholder-[var(--text-tertiary)] border-0 outline-none disabled:opacity-50"
                style={{ minHeight: 60, maxHeight: 180, overflowY: 'auto', overscrollBehavior: 'contain' }}
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
          {/* Idle / empty */}
          {artifactPhase === 'idle' && !generatedHtml && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--text-tertiary)]">
              <div className="w-12 h-12 rounded-2xl bg-purple-500/8 flex items-center justify-center">
                <Wand2 size={22} className="text-purple-400/60" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-[var(--text-secondary)]">
                  PPT 预览区
                </p>
                <p className="text-xs mt-1 text-[var(--text-tertiary)]">
                  在左侧对话框输入需求，AI 将生成 reveal.js 网页 PPT
                </p>
              </div>
            </div>
          )}

          {/* Outlining progress */}
          {artifactPhase === 'outlining' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <MapSpinner size={20} />
              <p className="text-sm text-[var(--text-secondary)]">正在规划大纲...</p>
              <p className="text-xs text-[var(--text-tertiary)]">分析内容结构，生成最优页面分配</p>
            </div>
          )}

          {/* Generating progress */}
          {(artifactPhase === 'generating' || artifactPhase === 'patching') && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <MapSpinner size={20} />
              <div className="text-center">
                <p className="text-sm text-[var(--text-secondary)]">
                  {genStageMsg(elapsedSec, artifactPhase === 'patching')}
                </p>
                <p className="text-xs text-[var(--text-tertiary)] mt-1 tabular-nums">
                  已等待 {elapsedSec}s
                </p>
              </div>
              {diagLines.length > 0 && (
                <div className="w-72 rounded-md bg-white/3 border border-white/6 overflow-hidden">
                  <div className="px-3 py-1 text-[9px] text-[var(--text-tertiary)] font-semibold border-b border-white/5">
                    Agent 诊断
                  </div>
                  <div style={{ maxHeight: '100px', overflowY: 'auto', overscrollBehavior: 'contain' }}>
                    {diagLines.slice(-10).map((d, i) => (
                      <div key={i} className="px-3 py-0.5 text-[9px] font-mono text-[var(--text-tertiary)]">
                        [{d.stage}]{' '}
                        {d.message ? String(d.message) : d.warning ? String(d.warning) : ''}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

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

                  {/* 主题快速切换色点（即时换肤，无需重新生成） */}
                  <div className="flex items-center gap-1.5 ml-2 pl-2.5 border-l border-white/10" data-testid="theme-dots">
                    {THEME_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => switchTheme(opt.value)}
                        title={'切换主题：' + opt.label}
                        className="w-4 h-4 rounded-full transition-transform hover:scale-110"
                        style={{
                          background: opt.dotBg,
                          border: '2px solid ' + opt.dotRing,
                          boxShadow: theme === opt.value ? '0 0 0 2px rgba(168,85,247,.7)' : 'none',
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  {/* 模型 chip：常驻可点（借鉴 open-design InlineModelSwitcher），免去翻设置面板 */}
                  <ModelChipPopover
                    modelInfo={modelInfo}
                    selectedModel={model}
                    models={chatModels}
                    onSelect={setModel}
                    onOpen={loadModels}
                    disabled={engine !== 'map'}
                  />
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
                  srcDoc={prepareIframeHtml(generatedHtml, theme, { editor: editMode })}
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
