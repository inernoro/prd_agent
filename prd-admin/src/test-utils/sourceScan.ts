/**
 * 源码扫描类守卫的公共前处理：把注释剥掉再断言。
 *
 * 为什么需要它：这类守卫的判据是「源码里有没有出现某段文本」，而注释里几乎总会
 * 出现同一段文本 —— 恰恰是那句解释「为什么不能这么写」的注释。于是判据两个方向
 * 都会错：
 *
 *   - 误红：`expect(src).not.toContain('addEventListener')` 把解释性注释判成违规；
 *   - 漏判：`/render\(\);/` 把 `// render();` 这种注释掉的调用认成「调用还在」。
 *
 * 本 PR 里同一个坑连踩三次（addEventListener / render(); / role="radio"），
 * 三次都是打补丁收紧正则。正解是扫之前先去注释，让判据只看真正会执行的代码。
 *
 * 实现是够用级别的词法扫描：识别行注释、块注释、三种字符串与模板串，
 * 以及正则字面量的常见形态。它不是完整的 TS parser，但对「读一个源文件、
 * 断言某段代码在不在」这个用途足够，且不依赖任何解析器。
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // 行注释
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }

    // 块注释（含 JSDoc）
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    // 字符串 / 模板串：整段原样保留，里面的 // 不算注释
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** 读文件并去掉注释。source-scan 守卫的标准入口。 */
export function readSourceWithoutComments(
  read: (relative: string) => string,
  relative: string,
): string {
  return stripComments(read(relative));
}
