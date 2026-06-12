import { describe, expect, it } from 'vitest';
import { parseRequirementRtfBytes, replaceImportImageMarkers } from './requirementRtfImport';

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

    expect(parsed.externalId).toBe('1164054517001006299');
    expect(parsed.title).toBe('需求标题示例');
    expect(parsed.sourceStatus).toBe('待评审');
    expect(parsed.handlerNames).toEqual(['张三']);
    expect(parsed.developerNames).toEqual(['李四']);
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].author).toBe('王五');
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
});
