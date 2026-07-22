#!/usr/bin/env python3
"""Focused regression tests for acceptance archive gates."""

from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / ".claude" / "skills" / "create-visual-test-to-kb" / "scripts" / "archive_report.py"


def load_archive_module():
    spec = importlib.util.spec_from_file_location("archive_report", ARCHIVE)
    if not spec or not spec.loader:
        raise RuntimeError(f"cannot load {ARCHIVE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_has_error(errors, needle):
    if not any(needle in e for e in errors):
        raise AssertionError(f"expected error containing {needle!r}, got: {errors}")


def assert_no_errors(errors):
    if errors:
        raise AssertionError(f"expected no errors, got: {errors}")


def main() -> None:
    archive = load_archive_module()

    annotated_manifest = [{"name": "01-report-page", "caption": "图 01 框出遮挡区域", "annotated": True}]
    overview_manifest = [{"name": "01-report-page", "caption": "图 01 总览", "annotated": False, "overview": True}]

    plain = """
## 缺陷清单

P1: 报告页右侧为空且遮挡正文，没有截图锚点。
"""
    assert_has_error(archive._problem_localization_errors(plain, annotated_manifest), "没有链接到截图锚点")

    bullet_with_api = """
## 缺陷清单

- P1: 报告页空白，API 500，用户看到右侧为空，没有截图锚点。
"""
    assert_has_error(archive._problem_localization_errors(bullet_with_api, annotated_manifest), "没有链接到截图锚点")

    table_overview = """
## 缺陷清单

| 严重级 | 现象 | 证据 |
|---|---|---|
| P2 | 页面错位，按钮被遮挡 | [图01](#fig-01-report-page) |
"""
    assert_has_error(archive._problem_localization_errors(table_overview, overview_manifest), "未记录为已标注")

    table_annotated = """
## 缺陷清单

| 严重级 | 现象 | 证据 |
|---|---|---|
| P2 | 页面错位，按钮被遮挡 | [图01](#fig-01-report-page) |
"""
    assert_no_errors(archive._problem_localization_errors(table_annotated, annotated_manifest))

    api_only = """
## 缺陷清单

- P1: API 500 导致接口失败，已补服务端日志证据。
"""
    assert_no_errors(archive._problem_localization_errors(api_only, annotated_manifest))

    coverage_gap = """
## 缺陷清单

| 严重级 | 现象 | 证据 |
|---|---|---|
| P2 | 未覆盖删除流程，测试覆盖不足 | 需要补用例 |
"""
    assert_no_errors(archive._problem_localization_errors(coverage_gap, annotated_manifest))

    visual_overlay = """
## 缺陷清单

| 严重级 | 现象 | 证据 |
|---|---|---|
| P2 | 按钮被弹窗覆盖，用户看不到主操作 | 无截图锚点 |
"""
    assert_has_error(archive._problem_localization_errors(visual_overlay, annotated_manifest), "没有链接到截图锚点")

    mobile_body = """
## 移动端验收

视口 390×844，使用真实触控完成首页导航入口路径；结果状态正常。
页面滚动归属正确，无横向溢出，顶部和底部无遮挡或裁切。
"""
    desktop_narrow = [{
        "name": "01-desktop-narrow",
        "viewport": {"width": 390, "height": 844},
        "touchPoints": 0,
        "isMobile": False,
    }]
    assert_has_error(
        archive._mobile_acceptance_errors("L1", mobile_body, desktop_narrow),
        "真实触控移动端证据",
    )

    mobile_entry = {
        "name": "02-mobile-entry",
        "viewport": {"width": 390, "height": 844},
        "touchPoints": 1,
        "isMobile": True,
        "mobilePathId": "mobile-primary",
        "mobileStage": "entry",
    }
    assert_no_errors(archive._mobile_acceptance_errors("L1", mobile_body, [mobile_entry]))
    assert_has_error(
        archive._mobile_acceptance_errors("L2", mobile_body, [mobile_entry]),
        "L2 需要 >= 2 张",
    )

    mobile_result = {
        "name": "03-mobile-result",
        "viewport": {"width": 390, "height": 844},
        "touchPoints": 1,
        "isMobile": True,
        "mobilePathId": "mobile-primary",
        "mobileStage": "result",
    }
    assert_no_errors(archive._mobile_acceptance_errors("L2", mobile_body, [mobile_entry, mobile_result]))

    duplicate_stage = dict(mobile_result, mobileStage="entry")
    assert_has_error(
        archive._mobile_acceptance_errors("L2", mobile_body, [mobile_entry, duplicate_stage]),
        "入口/操作阶段与结果/状态阶段",
    )

    thin_mobile_body = """
## 移动端验收

视口 390×844，触控进入导航路径，结果状态正常。
"""
    assert_has_error(
        archive._mobile_acceptance_errors("L1", thin_mobile_body, [mobile_entry]),
        "滚动结论",
    )

    # 规则 §11.2 豁免：桌面原生/内部非页面报告声明「移动端不适用」+ 产品边界，豁免移动端硬门禁。
    na_body = """
## 移动端验收

本次为内部非页面变更（CDS 后端证据），无移动 Web 面，移动端不适用。
"""
    assert_no_errors(archive._mobile_acceptance_errors("L1", na_body, []))
    assert_no_errors(archive._mobile_acceptance_errors("L2", na_body, []))
    # 只写「移动端不适用」但缺产品边界理由，不予豁免（防止用一句话绕过硬门禁）。
    bare_na_body = "## 移动端验收\n\n移动端不适用。\n"
    assert_has_error(
        archive._mobile_acceptance_errors("L1", bare_na_body, []),
        "真实触控移动端证据",
    )

    html = archive.build_interactive_html("日报", "fail", "# 日报\n\n正文", annotated_manifest)
    if "map-acceptance-template" not in html or 'data-template="map-acceptance-interactive-html-v2"' not in html:
        raise AssertionError("standard interactive HTML is missing the acceptance template marker")

    daily_report = """
# 每日验收报告

## 验收时间

2026-07-22 07:15:30 CST+0800

## 覆盖缺口

| 缺口编号 | 未覆盖内容 | 原因 |
|---|---|---|
| G1 | 设置页在线终态 | 目标版未上线 |
| G2 | 发布向导完整流程 | 不执行生产发布 |
| G3 | 付费生成 | 不产生外部成本 |
| G4 | 完整转录终态 | 外部服务未调用 |

## 总缺口账本

| 编号 | 缺口 | 后续条件 |
|---|---|---|
| G1 | 设置页在线终态 | 目标版上线后复测 |
| G2 | 发布向导完整流程 | 在非生产目标复测 |
| G3 | 付费生成 | 提供测试额度 |
| G4 | 完整转录终态 | 提供可用外部服务 |
"""
    daily_html = archive.build_interactive_html(
        "日报", "conditional", daily_report, annotated_manifest, flavor="daily"
    )
    if '<span>缺口</span><strong>4</strong>' not in daily_html:
        raise AssertionError("header gap metric must use the four unique ledger rows")
    if "报告时间 · 2026-07-22 07:15:30 CST+0800" not in daily_html:
        raise AssertionError("report time must be visible in the top-right masthead")

    print("acceptance archive report gates passed")


if __name__ == "__main__":
    main()
