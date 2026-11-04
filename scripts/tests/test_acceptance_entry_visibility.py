"""报告默认简版必须给读者进入被测页面的办法。"""
import importlib.util
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "archive", ROOT / ".claude/skills/create-visual-test-to-kb/scripts/archive_report.py"
)
ARCHIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVE)


class EntryVisibilityTest(unittest.TestCase):
    def test_default_brief_keeps_navigation_and_uncovered_actions(self):
        content = """## 给你的一页结论
核心用例已执行。

## 操作入口
项目列表 → 项目 → 数据库 → 操作面板

## 执行覆盖账本
跨引擎转换未支持。
"""
        html = ARCHIVE.build_interactive_html("数据库连接验收", "conditional", content, [])
        keep = re.search(r"var briefSections=(\[.*?\]);", html)
        # 与线上视图切换实际消费同一份配置，而不是只检查标题存在。
        self.assertIsNotNone(keep)
        sections = json.loads(keep.group(1))
        self.assertIn("操作入口", sections)
        self.assertIn("执行覆盖账本", sections)
        self.assertIn("项目列表 → 项目 → 数据库 → 操作面板", html)


if __name__ == "__main__":
    unittest.main()
