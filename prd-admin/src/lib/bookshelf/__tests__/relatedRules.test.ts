import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_BOOKS } from '../catalog';

/**
 * 守卫：书目上 `relatedRules` 填的每一条，`.claude/rules/` 下都真的有那个文件。
 *
 * 这条是被现场教出来的：给第一本书填映射时我一连填错两次（`skill-validation`、
 * `phase0-guard`），两个都是**技能**不是规则 —— 名字听着像、凭印象就填了。
 * 没有守卫的话，这种错会一路走到精读稿里：模型拿不到那条规则的内容，
 * 要么把这一段略过，要么顺着名字编一条我们根本没有的规则出来。
 *
 * 编出来的那种最糟：读者照着去翻，发现仓库里没有，于是整篇稿子的可信度都没了。
 */

const RULES_DIR = path.resolve(__dirname, '../../../../../.claude/rules');

describe('书目关联的规则', () => {
  it('规则目录能找到（找不到说明相对路径错了，不是「没有规则」）', () => {
    expect(fs.existsSync(RULES_DIR), `没找到规则目录：${RULES_DIR}`).toBe(true);
  });

  it('填的每条 relatedRules 都对应一个真实存在的规则文件', () => {
    const known = new Set(
      fs.readdirSync(RULES_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
    );
    const bad: string[] = [];
    ALL_BOOKS.forEach((b) => {
      (b.relatedRules ?? []).forEach((r) => {
        if (!known.has(r)) bad.push(`${b.id} -> ${r}`);
      });
    });
    expect(
      bad,
      '这些规则名在 .claude/rules/ 下不存在（最常见的错是把「技能」当成了「规则」）：' + bad.join('、'),
    ).toEqual([]);
  });

  it('同一本书不重复填同一条规则', () => {
    const dup = ALL_BOOKS
      .filter((b) => (b.relatedRules?.length ?? 0) !== new Set(b.relatedRules ?? []).size)
      .map((b) => b.id);
    expect(dup, `这些书的 relatedRules 里有重复项：${dup.join('、')}`).toEqual([]);
  });
});
