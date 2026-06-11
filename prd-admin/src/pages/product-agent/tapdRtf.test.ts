import { describe, expect, it } from 'vitest';
import { parseTapdRequirementRtfBytes, replaceTapdImageMarkers } from './tapdRtf';

function rtf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parseTapdRequirementRtfBytes', () => {
  it('parses TAPD rows, unicode fields and imported comments', () => {
    const input = String.raw`{\rtf\ansi
      \trowd\cellx1000\cellx2000
      \intbl ID\cell 1007157\cell\row
      \trowd\cellx2000
      \intbl \u27979?\u35797?\u38656?\u27714?\cell\row
      \trowd\cellx1000\cellx2000\cellx3000\cellx4000
      \intbl \u29366?\u24577?\cell \u24453?\u35268?\u21010?\cell \u20248?\u20808?\u32423?\cell Middle\cell\row
      \trowd\cellx2000
      \intbl 1\u12289?\u38382?\u39064?\line \u20869?\u23481?\cell\row
      \trowd\cellx2000
      \intbl \u12304?\u35780?\u35770?:\u24352?\u19977? \u28155?\u21152? (2026-06-10 17:00:13)\u12305?\line \u24050?\u30830?\u35748?\cell\row
    }`;
    const parsed = parseTapdRequirementRtfBytes(rtf(input), 'sample.rtf');

    expect(parsed.externalId).toBe('1007157');
    expect(parsed.title).toBe('测试需求');
    expect(parsed.sourceStatus).toBe('待规划');
    expect(parsed.sourcePriority).toBe('Middle');
    expect(parsed.grade).toBe('p2');
    expect(parsed.description).toContain('<h3>1、问题</h3>');
    expect(parsed.comments).toEqual([
      {
        author: '张三',
        title: '添加',
        createdAt: '2026-06-10 17:00:13',
        content: '已确认',
      },
    ]);
  });

  it('replaces extracted image markers with uploaded URLs', () => {
    expect(replaceTapdImageMarkers(
      '<p>正文</p><p data-tapd-image="0"></p>',
      [{ index: 0, url: '/assets/a.png', fileName: 'a.png' }],
    )).toContain('<img src="/assets/a.png" alt="a.png"');
  });

  it('extracts an embedded PNG from the description cell', () => {
    const png = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082';
    const input = String.raw`{\rtf\ansi
      \trowd\cellx1000\cellx2000\intbl ID\cell 7\cell\row
      \trowd\cellx2000\intbl title\cell\row
      \trowd\cellx2000\intbl body\line{\pict\pngblip ${png}}\cell\row
    }`;
    const parsed = parseTapdRequirementRtfBytes(rtf(input), 'image.rtf');

    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0].mimeType).toBe('image/png');
    expect(parsed.description).toContain('data-tapd-image="0"');
  });

  it('rejects non-RTF files', () => {
    expect(() => parseTapdRequirementRtfBytes(rtf('plain text'), 'bad.rtf')).toThrow('不是有效的 RTF 文件');
  });
});
