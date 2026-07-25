import { describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { buildZip } from '../../src/utils/zip.js';

function readLocalEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    offset = dataStart + compressedSize;
  }
  return entries;
}

describe('buildZip', () => {
  it('creates a readable UTF-8 ZIP with stored and deflated entries', () => {
    const zip = buildZip([
      { name: 'report.html', data: '<h1>验收报告</h1>'.repeat(20), modifiedAt: new Date('2026-07-22T00:00:00Z') },
      { name: 'assets/image.png', data: Buffer.from([1, 2, 3, 4]), modifiedAt: new Date('2026-07-22T00:00:00Z') },
    ]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    const entries = readLocalEntries(zip);
    expect(entries.get('report.html')?.toString('utf8')).toContain('验收报告');
    expect(entries.get('assets/image.png')).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('rejects parent traversal entry names', () => {
    expect(() => buildZip([{ name: '../secret', data: 'x' }])).toThrow('unsafe');
  });
});
