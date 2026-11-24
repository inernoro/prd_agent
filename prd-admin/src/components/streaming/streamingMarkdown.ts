// 流式期间把「写到一半的 markdown」补成合法 markdown 再渲染。
//
// 为什么需要它：模型逐字吐出 `**加粗**` 时，中途一定会经过 `**加粗` 这个状态——
// markdown 见到落单的 `**` 就当普通字符渲染，用户眼睁睁看着两颗星号冒出来又消失。
// 代码围栏更严重：一条没闭合的 ``` 会把它后面的所有内容一起吞进代码块。
// 产物在生长，不该让语法碎片露脸（artifact-is-experience.md）。
//
// 只在流式期间用。完成态的文本是模型的完整输出，一个字都不动。
//
// 这段逻辑原本长在知识库的划词改写里（自己拼 markdown 那一版），2026-08-25 随
// 「流式渲染统一走 StreamingText」搬到共享组件——它服务的是「逐 token 渲染 markdown」
// 这件事本身，属于所有流式调用方，不该由某一个页面各存一份
//（predicate-and-wiring-discipline.md 形状 3）。

/** ``` 或 ~~~ 围栏行（允许最多 3 个前导空格，与 CommonMark 一致） */
const FENCE_RE = /^ {0,3}(?:```|~~~)/;

/** 把一段文本补齐所需的收尾标记拼出来；已经闭合则返回空串。 */
function missingMarks(text: string): string {
  let out = '';
  const backticksOdd = ((text.match(/`/g) ?? []).length) % 2 === 1;
  if (backticksOdd) out += '`';
  // 反引号里的星号是代码，不参与配对；落单的那个反引号后面全算代码，一并排除
  const noCode = (backticksOdd ? `${text}\`` : text).replace(/`[^`]*`/g, '');
  if (((noCode.match(/~~/g) ?? []).length) % 2 === 1) out += '~~';
  const noStrike = noCode.replace(/~~/g, '');
  if (((noStrike.match(/\*\*/g) ?? []).length) % 2 === 1) out += '**';
  else if (((noStrike.replace(/\*\*/g, '').match(/\*/g) ?? []).length) % 2 === 1) out += '*';
  return out;
}

/** 行内标记（加粗 / 斜体 / 行内代码 / 删除线）补齐 */
function closeInlineMarks(text: string): string {
  if (!text) return text;
  // 代码围栏内的星号反引号都是代码，不参与闭合判断
  const lines = text.split('\n');
  let inFence = false;
  const scanned: string[] = [];
  for (const line of lines) {
    if (FENCE_RE.test(line)) { inFence = !inFence; continue; }
    if (!inFence) scanned.push(line);
  }
  // 正好停在围栏里 / 停在围栏行上：末尾那几个反引号是围栏本身，一个都不能动
  if (inFence || FENCE_RE.test(lines[lines.length - 1] ?? '')) return text;
  const body = scanned.join('\n');

  // 顺序很关键（2026-08-21 code review 抓到）：先判「本来就是闭合的吗」。
  // 上一版无条件把末尾的 `*` / `` ` `` / `~` 摘掉再补，于是刚刚吐完的 `*斜体*`
  // 被摘成 `*斜体` —— 而单个星号又不在补齐清单里，星号就这么露了出来，
  // 正是这个函数存在的意义被它自己破坏掉。
  if (!missingMarks(body)) return text;
  // 末尾是刚敲出来的半截标记（`这是 **`）：摘掉即闭合，不能补，补了会变成 `****`
  const stripped = text.replace(/[*`~]+$/, '');
  const strippedBody = body.replace(/[*`~]+$/, '');
  if (!missingMarks(strippedBody)) return stripped;
  // 前文确有没闭合的标记：补在末尾
  return stripped + missingMarks(strippedBody);
}

/**
 * 把流式中途的 markdown 补成合法 markdown。
 *
 * 两件事，缺一不可：
 * 1. 没闭合的代码围栏补一条收尾 ``` —— 不补的话它后面的一切都会被吞进代码块；
 * 2. 没闭合的行内标记补齐或摘掉 —— 不处理的话星号反引号会当成正文露出来。
 */
export function closeOpenMarkdown(text: string): string {
  if (!text) return text;
  const withInline = closeInlineMarks(text);
  let inFence = false;
  for (const line of withInline.split('\n')) {
    if (FENCE_RE.test(line)) inFence = !inFence;
  }
  return inFence ? `${withInline}\n\`\`\`` : withInline;
}

/**
 * markdown 流式档的光标。
 *
 * 这里用的是字符而不是 MAP 品牌的那枚 M，是被 markdown 逼的：
 * - 伪元素做不到——`::after` 只能挂在容器上（落到最后一段的下一行）或挂在
 *   `:last-child` 上（每个父元素各冒一个光标，跨段落时同时出现好几个）；
 * - 品牌 M 需要 `<span>` 承载样式，但各调用方的 markdown 渲染器未必开了 raw HTML，
 *   开了的（如 MarkdownViewer）又会被 sanitize 剥掉 class，于是有的页面会把
 *   `<span ...>M</span>` 原样当文字显示出来。
 * 一个字符在所有渲染器里都成立，且天然落在最后一段的行尾——这是目前唯一无副作用的写法。
 * 纯文本档仍然是品牌 M（renderCursor），两档的差异是已知的，不是漏改。
 */
export const MARKDOWN_STREAM_CARET = '▌';
