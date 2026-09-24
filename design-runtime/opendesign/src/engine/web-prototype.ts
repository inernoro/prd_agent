// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts 里 WEB_PROTOTYPE_TEMPLATE_PATCH /
// WEB_PROTOTYPE_TEMPLATE_ASSERT 与会话创建时那段 `docker exec ... cp -a && sed && test -f` 准备步骤。
//
// 归属变了，行为没变：原来是在会话容器里用 sed / grep 改 CDS 自己那几份 web-prototype 拷贝并当场自证，
// 现在服务与引擎同处一个容器，改成直接读写本机文件。每一条替换与每一条自证判据都与原 shell 版本逐条对应
// （测试 `web-prototype.test.ts` 用真实 0.21.1 模板跑两遍、逐字节比对）。
//
// 原注释照录：
//
// CDS 自己那几份 web-prototype 拷贝要改的地方。上游模板（0.21.1）示范的是发布闸必拒的
// 两种写法，而新建页面时它还就是起始页——不改，模型每次都从一张违规的页面开始编辑。
//
// 落点用的是模板本来就带的 id（topnav / content / hero / footer），所以改完仍然自洽：
// 导航真的跳到自己的章节，CTA 是一个有去处的锚点。改的是 CDS 的拷贝，上游镜像不动。
//
// 新建页面**不种** `/workspace/index.html`（NEW_PAGE_NO_SEED_NOTE）。OpenDesign 判定「这一轮交付的是
// 哪个文件」时，第一条就是认根目录的 index.html；只要先种了一张，它就被认成交付物，模型按 slug 命名的
// 那份真成品被晾成孤儿（2026-09-20 那十六条 run 失败得一模一样的原因）。所以这里什么都不种，模板只放在
// `/workspace/.od-skills/web-prototype/assets/template.html` 供它照抄。
import fs from 'node:fs';
import path from 'node:path';

import { AgentWorkspaceRuntimeError } from '../errors.js';

export interface WebPrototypeLayout {
  /** 镜像里官方 web-prototype 技能的只读源目录。 */
  sourceDir: string;
  /** 平台侧那份拷贝的父目录（生产为 /app/design-templates）。 */
  templatesDir: string;
  /** 工作区根目录（生产为 /workspace）。 */
  workspaceDir: string;
}

/**
 * 模板里真正的 `id` 只有 `<main id="content">` 一个；hero 与 footer 挂的是 `data-od-id`，
 * 闸门收锚点只认 `id` / `name`，不认它。所以先补两个真 id，导航才有地方可去——
 * 否则「空链接」只会换成「锚点指向不存在的片段」，等于没修。
 * （第一版就这么写错过：grep `id="hero"` 命中的其实是 `data-od-id="hero"` 的子串。）
 *
 * 每一对都是原 sed 表达式的字面等价物（原表达式里的 `\[REPLACE\]`、`example\.com` 只是转义字面量），
 * 顺序与原 `-e` 顺序一致；sed 的 `g` 对应 replaceAll。
 */
const TEMPLATE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['<section class="section hero" data-od-id="hero">', '<section class="section hero" id="hero" data-od-id="hero">'],
  ['<footer class="pagefoot" data-od-id="footer">', '<footer class="pagefoot" id="footer" data-od-id="footer">'],
  ['<a href="#">[REPLACE] Link 1</a>', '<a href="#hero">[REPLACE] Link 1</a>'],
  ['<a href="#">[REPLACE] Link 2</a>', '<a href="#content">[REPLACE] Link 2</a>'],
  ['<a href="#">[REPLACE] Link 3</a>', '<a href="#footer">[REPLACE] Link 3</a>'],
  ['<button class="btn btn-primary">[REPLACE] CTA</button>', '<a class="btn btn-primary" href="#content">[REPLACE] CTA</a>'],
  ['<button class="btn btn-primary">[REPLACE] Primary CTA</button>', '<a class="btn btn-primary" href="#content">[REPLACE] Primary CTA</a>'],
  ['<button class="btn btn-secondary">[REPLACE] Secondary</button>', '<a class="btn btn-secondary" href="#footer">[REPLACE] Secondary</a>'],
  ['href="#"', 'href="#content"'],
  // 模板页脚那个 contact@example.com 会被「事实必须来自 MAP 来源」那道闸拒掉：
  // 占位邮箱不在任何知识来源里，模型又照例留着不动（实测第六条 run 就死在它上面）。
  // 占位联系方式没有任何合法取值，所以是删掉而不是换一个。
  ['[REPLACE] tagline · contact@example.com', '[REPLACE] tagline · [REPLACE] contact'],
];

const LAYOUT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['href="#"', 'href="#content"'],
];

function applyReplacements(text: string, replacements: ReadonlyArray<readonly [string, string]>): string {
  let patched = text;
  for (const [from, to] of replacements) patched = patched.replaceAll(from, to);
  return patched;
}

/** 平台自己那份模板的补丁（纯函数，供准备步骤与测试共用）。 */
export function patchWebPrototypeTemplate(text: string): string {
  return applyReplacements(text, TEMPLATE_REPLACEMENTS);
}

export function patchWebPrototypeLayouts(text: string): string {
  return applyReplacements(text, LAYOUT_REPLACEMENTS);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 改完当场自证三件事，缺一即让准备步骤失败——上游哪天换了措辞、一条替换都没命中时
 * 必须在这里炸，而不是静默发回一张仍然违规的起始页，等四轮质量修复全灭才被发现
 * （`predicate-and-wiring-discipline.md` 形状 8）。返回第一条不成立的判据；全部成立返回 undefined。
 *
 * 第三条是真正吃过亏的那条：每个 `href="#x"` 都得能在同一份文件里找到一个**真的** `id="x"`。
 * 判据必须把 `data-od-id="x"` 排除掉，否则它自己就会被那个子串骗过去——原 grep 用
 * `(^|[[:space:]])id="x"` 做到这一点，这里的 `(^|\s)` + 多行模式与它逐行等价。
 */
export function findTemplateAssertionFailure(text: string): string | undefined {
  if (/href="#"|href=""|<button/.test(text)) return 'template still contains an empty link or a bare button';
  // 邮箱与日期在模板里没有任何合法取值——它们只可能是占位，而占位一定过不了
  // 「事实必须来自 MAP 来源」那道闸。写成通用判据而不是逐个点名。
  // （URL 不在此列：模板里出现 CDN 链接是合理的，一刀切会在上游升级时误伤。）
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:19|20)[0-9]{2}[-/.][0-9]{1,2}/i.test(text)) {
    return 'template still contains a placeholder email or date';
  }
  for (const match of text.matchAll(/href="#([^"]*)"/g)) {
    const fragment = match[1];
    if (!new RegExp(`(^|\\s)id="${escapeRegExp(fragment)}"`, 'm').test(text)) {
      return `template anchor #${fragment} has no matching id`;
    }
  }
  return undefined;
}

const REQUIRED_SKILL_FILES = ['SKILL.md', 'assets/template.html', 'references/layouts.md', 'references/checklist.md'];
const REQUIRED_WORKSPACE_SKILL_FILES = ['assets/template.html', 'references/layouts.md', 'references/checklist.md'];

/**
 * 把官方 web-prototype 技能拷两份（平台模板目录 + 工作区 `.od-skills`），打补丁并自证。
 * 任何一步不成立都以 `workspace_design_template_init_failed` 失败，不静默放过。
 * `chown` 由调用方传入：服务以 root 运行、引擎以 open-design 运行时，拷贝要交还给引擎用户。
 */
export function prepareWebPrototypeResources(
  layout: WebPrototypeLayout,
  chown: (target: string) => void,
): void {
  const fail = (reason: string): never => {
    throw new AgentWorkspaceRuntimeError(
      'workspace_design_template_init_failed',
      'OpenDesign web prototype resources could not be prepared',
      false,
      { stage: 'design_template_init', reason },
    );
  };
  const platformCopy = path.join(layout.templatesDir, 'web-prototype');
  const workspaceCopy = path.join(layout.workspaceDir, '.od-skills', 'web-prototype');
  try {
    for (const target of [platformCopy, workspaceCopy]) {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(layout.sourceDir, target, { recursive: true, force: true, preserveTimestamps: true });
    }
  } catch (error) {
    return fail(`copy failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
  }
  const templateFiles = [platformCopy, workspaceCopy].map((root) => path.join(root, 'assets', 'template.html'));
  const layoutFiles = [platformCopy, workspaceCopy].map((root) => path.join(root, 'references', 'layouts.md'));
  for (const file of templateFiles) {
    if (!fs.existsSync(file)) return fail(`missing ${path.relative(layout.workspaceDir, file)}`);
    fs.writeFileSync(file, patchWebPrototypeTemplate(fs.readFileSync(file, 'utf8')));
  }
  for (const file of layoutFiles) {
    if (!fs.existsSync(file)) return fail(`missing ${path.relative(layout.workspaceDir, file)}`);
    fs.writeFileSync(file, patchWebPrototypeLayouts(fs.readFileSync(file, 'utf8')));
  }
  for (const file of templateFiles) {
    const failure = findTemplateAssertionFailure(fs.readFileSync(file, 'utf8'));
    if (failure) return fail(failure);
  }
  for (const relative of REQUIRED_SKILL_FILES) {
    if (!fs.existsSync(path.join(platformCopy, relative))) return fail(`missing web-prototype/${relative}`);
  }
  for (const relative of REQUIRED_WORKSPACE_SKILL_FILES) {
    if (!fs.existsSync(path.join(workspaceCopy, relative))) return fail(`missing .od-skills/web-prototype/${relative}`);
  }
  // 编辑路径的 index.html 由输入包带来，缺了就是传输坏了，必须当场发现；
  // 新建路径本来就没有，不在这里断言它存在。
  if (
    fs.existsSync(path.join(layout.workspaceDir, 'current', 'index.html'))
    && !fs.existsSync(path.join(layout.workspaceDir, 'index.html'))
  ) {
    return fail('editable index.html is missing although current/index.html exists');
  }
  chown(platformCopy);
  chown(path.join(layout.workspaceDir, '.od-skills'));
}

/** 能力自检用：镜像里官方技能的四个文件是否都在（原 CDS 能力探针里的 test -f 四连）。 */
export function missingWebPrototypeSourceFiles(sourceDir: string): string[] {
  return REQUIRED_SKILL_FILES.filter((relative) => !fs.existsSync(path.join(sourceDir, relative)));
}
