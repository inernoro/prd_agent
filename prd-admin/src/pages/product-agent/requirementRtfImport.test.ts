import { describe, expect, it } from 'vitest';
import {
  normalizeRtfImage,
  parseRequirementRtfBytes,
  replaceImportImageMarkers,
  sniffImageFormat,
  stripFailedImageMarkers,
} from './requirementRtfImport';

function rtf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('parseRequirementRtfBytes', () => {
  it('parses requirement rows, unicode fields and imported comments', () => {
    const input = String.raw`{\rtf1\ansi
      \cell\row
      \intbl ID\cell 1164054517001006299\cell\row
      \intbl \u29366?\u24577?\cell \u24453?\u35780?\u23457?\cell \u20248?\u20808?\u32423?\cell Middle\cell\row
      \intbl \u22788?\u29702?\u20154?\cell \u24352?\u19977?\cell \u24320?\u21457?\u20154?\u21592?\cell \u26446?\u22235?\cell\row
      \intbl \u38656?\u27714?\u26631?\u39064?\u31034?\u20363?\cell\row
      \intbl \u36825?\u26159?\u27491?\u25991?\u25551?\u36848?\cell\row
      \intbl \u12304?\u35780?\u35770?:\u29579?\u20116? \u29366?\u24577?\u21464?\u26356? (2026-06-01 10:00)\u12305?\cell\row
      \intbl \u35780?\u35770?\u27491?\u25991?\cell\row
    }`;
    const parsed = parseRequirementRtfBytes(rtf(input), 'sample.rtf');

    expect(parsed).toHaveLength(1);
    expect(parsed[0].externalId).toBe('1164054517001006299');
    expect(parsed[0].title).toBe('需求标题示例');
    expect(parsed[0].sourceStatus).toBe('待评审');
    expect(parsed[0].handlerNames).toEqual(['张三']);
    expect(parsed[0].developerNames).toEqual(['李四']);
    expect(parsed[0].comments).toHaveLength(1);
    expect(parsed[0].comments[0].author).toBe('王五');
  });

  it('splits multi-requirement TAPD export RTF by ID rows', () => {
    const input = String.raw`{\rtf1\ansi
      \intbl ID\cell 1001\cell\row
      \intbl \u38656?\u27714?A\cell\row
      \intbl \u29366?\u24577?\cell \u24453?\u35780?\u23457?\cell \u20248?\u20808?\u32423?\cell Middle\cell\row
      \intbl \u27491?\u25991?A\cell\row
      \intbl ID\cell 1002\cell\row
      \intbl \u38656?\u27714?B\cell\row
      \intbl \u29366?\u24577?\cell \u24050?\u19978?\u32447?\cell \u20248?\u20808?\u32423?\cell High\cell\row
      \intbl \u27491?\u25991?B\cell\row
    }`;
    const parsed = parseRequirementRtfBytes(rtf(input), 'batch.rtf');
    expect(parsed).toHaveLength(2);
    expect(parsed[0].externalId).toBe('1001');
    expect(parsed[0].title).toBe('需求A');
    expect(parsed[1].externalId).toBe('1002');
    expect(parsed[1].title).toBe('需求B');
    expect(parsed[1].sourceStatus).toBe('已上线');
  });

  it('replaces import image markers in html', () => {
    expect(replaceImportImageMarkers(
      '<p>正文</p><p data-import-image="0"></p>',
      [{ index: 0, url: 'https://example.com/a.png', fileName: 'a.png' }],
    )).toContain('https://example.com/a.png');
  });

  it('rejects non-rtf files', () => {
    expect(() => parseRequirementRtfBytes(new TextEncoder().encode('plain text'), 'bad.rtf')).toThrow('不是有效的 RTF 文件');
  });

  it('sniffs jpeg even when declared as png', () => {
    const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    expect(sniffImageFormat(jpegHeader)?.mimeType).toBe('image/jpeg');
    const normalized = normalizeRtfImage({
      fileName: 'import-1.png',
      mimeType: 'image/png',
      bytes: jpegHeader,
      refIndex: 0,
    });
    expect(normalized).toBeNull();
  });

  it('strips failed image markers from html', () => {
    const html = '<p>正文</p><p data-import-image="3"></p><p data-import-image="4"></p>';
    expect(stripFailedImageMarkers(html, [3])).toBe('<p>正文</p><p data-import-image="4"></p>');
  });
});
