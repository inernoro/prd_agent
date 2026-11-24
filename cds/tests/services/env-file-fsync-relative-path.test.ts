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
 * 同一段 python 在这个脚本里出现多次（写 env、多键写 env、init 收尾）。只修被点名的那一处，
 * 其余就会原样留着——所以判据扫全文，不扫某一行。
 *
 * 判据刻意**不写死处数**：原先断言「恰好两处」，2026-09-16 合法新增第三处（多键一次提交）
 * 时它当场变红，而那处本来就带着兜底。写死数字就是下一次漂移的温床——
 * 真正的不变量是「每一处目录 fsync 都带兜底」，不是「一共有几处」。
 */
describe('env 文件落盘的目录 fsync', () => {
  it('每一处目录 fsync 都在目录路径为空时退回当前目录', () => {
    const sites = script.split('os.fsync(dd)').length - 1;
    // companion：确实还在 fsync 目录（否则下面的断言没有意义）。
    expect(sites, '脚本里必须仍然存在目录 fsync').toBeGreaterThanOrEqual(2);

    const bare = script.split('os.open(os.path.dirname(sys.argv[1])').length - 1;
    expect(bare, '相对文件名会让 os.path.dirname 返回空串，os.open 当场抛').toBe(0);

    const guarded = script.split('os.open((os.path.dirname(sys.argv[1]) or ".")').length - 1;
    expect(guarded, '每一处目录 fsync 都要带兜底，漏一处等于没修').toBe(sites);
  });
});
