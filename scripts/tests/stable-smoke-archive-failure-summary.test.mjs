import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const python = String.raw`
import importlib.util, json, sys
from pathlib import Path
root = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("archive_failure_contract", root / ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.load(sys.stdin)
if payload["mode"] == "summary":
    failed = payload["failed"]
    passed = 20 - failed
    body = "\n".join([
        "# 核心功能续测", "## 结论与处理顺序", "",
        "| 指标 | 数量 |", "|---|---:|",
        "| 计划测试 | 45 |", "| 已完成 | 20 |",
        f"| 通过 | {passed} |", f"| 失败 | {failed} |", "| 未执行 | 25 |",
    ])
    rendered = module.build_interactive_html("核心功能续测", "fail" if failed else "conditional", body, [])
    print(json.dumps({
        "clear": "本轮没有业务失败项。" in rendered,
        "failedCountRetained": f"本轮记录 {failed} 项失败" in rendered,
        "classificationMissing": "失败分类信息不足" in rendered,
        "cannotClaimNoFailure": "不能据此判定没有业务失败" in rendered,
    }, ensure_ascii=False))
else:
    shot = payload["shot"]
    print(json.dumps({
        "caption": module._evidence_caption(shot),
        "action": module._evidence_action(shot),
        "qualified": module._is_qualified_visual_evidence(shot),
        "status": shot["status"],
    }, ensure_ascii=False))
`;

function render(payload) {
  const result = spawnSync('python3', ['-B', '-c', python, repoRoot], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('REG-stsmk-report-risk-001 DEF-STSMK-REPORT-FACTS-001 零失败且无问题分类表才允许无失败摘要', () => {
  const result = render({ mode: 'summary', failed: 0 });
  assert.equal(result.clear, true);
  assert.equal(result.classificationMissing, false);
});

test('REG-stsmk-report-risk-001 DEF-STSMK-REPORT-FACTS-001 原12失败缺问题分类表不得渲染假零', () => {
  const result = render({ mode: 'summary', failed: 12 });
  assert.equal(result.clear, false);
  assert.equal(result.failedCountRetained, true);
  assert.equal(result.classificationMissing, true);
  assert.equal(result.cannotClaimNoFailure, true);
});

test('REG-stsmk-report-risk-001 显式业务结果概览保留白桃产物与文学失败事实但不核销视觉状态', () => {
  for (const caption of [
    '真实白桃产物已下载解码1254方图，不能证明严格1024或完整布局。',
    '文学配图终态Failed且没有图片；同requestId为MODEL_NOT_FOUND。',
  ]) {
    const result = render({ mode: 'evidence', shot: {
      name: '01-native-context', status: '未执行', caption,
      module: '单图视觉创作', primaryState: '结果',
      evidencePurpose: 'business-result-context',
    } });
    assert.equal(result.caption, caption);
    assert.equal(result.action, null);
    assert.equal(result.status, '未执行');
    assert.equal(result.qualified, false);
  }
});

test('REG-stsmk-report-risk-001 未声明或未知用途仍保留原保守补证行为', () => {
  for (const evidencePurpose of [undefined, 'unknown-purpose']) {
    const result = render({ mode: 'evidence', shot: {
      name: '01-native-context', status: '未执行', caption: '普通页面概览。',
      module: '单图视觉创作', primaryState: '结果',
      ...(evidencePurpose ? { evidencePurpose } : {}),
    } });
    assert.notEqual(result.caption, '普通页面概览。');
    assert.match(result.action.current, /本图只证明页面已到达/);
    assert.equal(result.status, '未执行');
    assert.equal(result.qualified, false);
  }
});

