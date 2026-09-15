import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(path.join(process.cwd(), 'exec_cds.sh'), 'utf8');

/**
 * 写 .cds.env 之后要 fsync 目录才算真落盘，而目录是从文件路径推出来的。
 * CDS_ENV_FILE 允许是个相对文件名（custom.env），此时 os.path.dirname 返回空串，
 * os.open('') 直接抛——而它排在 mv 之后：文件已经换好了，却报失败。
 * strict 模式下 init 会在第一次写变量后就中止，留下半套配置（Codex P2，2026-09-15）。
 *
 * 同一段 python 在这个脚本里出现两次（写 env、init 收尾）。第一次只修被点名的那一处，
 * 另一处就会原样留着——所以判据扫全文，不扫某一行。
 */
describe('env 文件落盘的目录 fsync', () => {
  it('目录路径为空时退回当前目录，两处写法一致', () => {
    // companion：确实还在 fsync 目录（否则下面的断言没有意义）。
    expect(script).toContain('os.fsync(dd)');

    const bare = script.split('os.open(os.path.dirname(sys.argv[1])').length - 1;
    expect(bare, '相对文件名会让 os.path.dirname 返回空串，os.open 当场抛').toBe(0);

    const guarded = script.split('os.open((os.path.dirname(sys.argv[1]) or ".")').length - 1;
    expect(guarded, '两处目录 fsync 都要带兜底，只修一处等于没修').toBe(2);
  });
});
