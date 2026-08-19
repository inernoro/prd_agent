import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

/**
 * 备份归档体检（不需要 docker、不需要 mongo，只读）。
 *
 * 用途：在决定「拿哪一份备份去恢复」之前，先回答一个问题——**这份文件里到底有没有
 * 业务数据**。2026-08-19 prdagent 被删库时，盘上有 7 份自动备份，但当时没有任何办法
 * 在不动线上库的前提下判断它们是删库前还是删库后的，只能看文件大小猜。
 *
 * 判据刻意保守。`mongodump --archive` 的帧格式是 mongo-tools 的私有二进制布局，
 * 照着记忆去解析它，解错了会**自信地报出错误的文档数**——那比没有工具更危险，
 * 因为它会被当成恢复决策的依据。所以这里只用三个不依赖帧格式的事实：
 *
 *   1. gzip 能不能完整解开（解不开 = 文件损坏，直接出局）
 *   2. 解压后有多大（空库的归档只有几 KB，和有数据的差几个数量级）
 *   3. 已知集合名在解压流里出现过几次（BSON 里集合名是明文 UTF-8，命中就是硬证据）
 *
 * 它**能**证明：文件完整、含有哪些业务集合、数据量级。
 * 它**不能**证明：这份归档能被 mongorestore 成功恢复。后者要真的 restore 一遍，
 * 那是 infra-r2-recovery-drill 的职责（需要 docker）。两者互补，不互相替代。
 */

export interface ArchiveInspectResult {
  filePath: string;
  /** 压缩态字节数 */
  compressedBytes: number;
  /** 解压后字节数；gzip 损坏时为止步处的字节数 */
  uncompressedBytes: number;
  /** 压缩态文件的 sha256，用于和离机副本比对同一性 */
  sha256: string;
  /** gzip 是否完整解开 */
  gzipOk: boolean;
  /** gzip 解开失败时的原因 */
  gzipError?: string;
  /** 命中的集合名 -> 出现次数（只统计传入的候选） */
  hits: Record<string, number>;
  /** 候选里一次都没出现的 */
  missing: string[];
}

/**
 * 跨块子串计数。
 *
 * 流式扫描最容易错的地方：needle 正好横跨两个 chunk 的边界。漏掉这种情况的后果不是
 * 报错而是**少数**——一份好备份可能因此被判成「没有业务数据」，进而被跳过不用。
 * 所以每块处理完保留 (最长 needle - 1) 字节的尾巴，拼到下一块前面再扫。
 */
/**
 * 导出供测试直接驱动：跨块逻辑的正确性依赖**分块位置**，而 zlib 的实际分块
 * 由压缩率决定、不受调用方控制。只经 gunzip 间接测，边界用例会变成假绿——
 * 第一版就是这么过的：把去重条件整个删掉，测试照样全绿。
 */
export function countNeedlesAcrossChunks(
  chunks: readonly Uint8Array[],
  names: readonly string[],
): Record<string, number> {
  const counter = new CrossChunkCounter(names);
  for (const c of chunks) counter.push(c);
  return counter.counts;
}

class CrossChunkCounter {
  private readonly needles: { name: string; buf: Buffer }[];
  private readonly overlap: number;
  // 用 Uint8Array 而不是 Buffer：subarray() 返回的是 Buffer<ArrayBufferLike>，
  // 赋回 Buffer<ArrayBuffer> 过不了类型检查，而这里只需要字节视图。
  private tail: Uint8Array = new Uint8Array(0);
  readonly counts: Record<string, number> = {};

  constructor(names: readonly string[]) {
    this.needles = names.map((name) => ({ name, buf: Buffer.from(name, 'utf8') }));
    this.overlap = Math.max(0, ...this.needles.map((n) => n.buf.length)) - 1;
    for (const n of this.needles) this.counts[n.name] = 0;
  }

  push(chunk: Uint8Array): void {
    const hay: Buffer = this.tail.length > 0
      ? Buffer.concat([Buffer.from(this.tail), Buffer.from(chunk)])
      : Buffer.from(chunk);
    for (const needle of this.needles) {
      let at = hay.indexOf(needle.buf, 0);
      while (at !== -1) {
        // 只统计「起点落在本块新内容里」的命中，否则上一块尾部的命中会被重复计数。
        if (at >= this.tail.length - needle.buf.length + 1 || this.tail.length === 0) {
          this.counts[needle.name] += 1;
        }
        at = hay.indexOf(needle.buf, at + 1);
      }
    }
    this.tail = this.overlap > 0
      ? Uint8Array.prototype.slice.call(hay, Math.max(0, hay.length - this.overlap))
      : new Uint8Array(0);
  }
}

export async function inspectMongoArchive(opts: {
  filePath: string;
  /** 候选集合名。命中即证明该集合的数据在归档里。 */
  expectCollections: readonly string[];
}): Promise<ArchiveInspectResult> {
  const { filePath } = opts;
  const stat = await fs.promises.stat(filePath);
  const hash = crypto.createHash('sha256');
  const counter = new CrossChunkCounter(opts.expectCollections);
  let uncompressed = 0;
  let gzipOk = true;
  let gzipError: string | undefined;

  const source = fs.createReadStream(filePath);
  source.on('data', (chunk) => hash.update(chunk as Buffer));

  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      uncompressed += chunk.length;
      counter.push(chunk);
      cb();
    },
  });

  try {
    await pipeline(source, zlib.createGunzip(), sink);
  } catch (err) {
    // 半截文件也要给出已读到的信息：知道「解到 3 MB 才坏」比只知道「坏了」有用得多。
    gzipOk = false;
    gzipError = err instanceof Error ? err.message : String(err);
  }

  const hits: Record<string, number> = {};
  const missing: string[] = [];
  for (const [name, count] of Object.entries(counter.counts)) {
    if (count > 0) hits[name] = count;
    else missing.push(name);
  }

  return {
    filePath,
    compressedBytes: stat.size,
    uncompressedBytes: uncompressed,
    sha256: hash.digest('hex'),
    gzipOk,
    gzipError,
    hits,
    missing,
  };
}

/**
 * 把体检结果翻成一句人能直接照着做决定的判断。
 *
 * 刻意不说「可以恢复」——本模块证明不了那件事（见文件头）。只说「像不像有数据」。
 */
export function summarizeArchive(result: ArchiveInspectResult): {
  verdict: 'broken' | 'empty' | 'has-data';
  text: string;
} {
  if (!result.gzipOk) {
    return {
      verdict: 'broken',
      text: `gzip 解压失败（读到 ${fmtBytes(result.uncompressedBytes)} 处中断：${result.gzipError}）。这份归档不完整，不要用它恢复。`,
    };
  }
  const hitCount = Object.keys(result.hits).length;
  if (hitCount === 0) {
    return {
      verdict: 'empty',
      text: `完整解开 ${fmtBytes(result.uncompressedBytes)}，但 ${result.missing.length} 个已知业务集合一个都没出现。这多半是一份空库或非本项目的备份。`,
    };
  }
  return {
    verdict: 'has-data',
    text: `完整解开 ${fmtBytes(result.uncompressedBytes)}，命中 ${hitCount} / ${hitCount + result.missing.length} 个已知业务集合。含有业务数据。`
      + '（注意：这不等于「一定能恢复成功」，恢复演练才能证明那件事。）',
  };
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
