#!/usr/bin/env python3
"""Focused regression tests for acceptance archive gates."""

from __future__ import annotations

import importlib.util
import tempfile
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


def compiled_markdown(archive, body, manifest):
    img_md = {
        shot["name"]: f'![{shot["caption"]}](https://assets.example.test/{shot["name"]}.png)'
        for shot in manifest
    }
    return archive.assemble(
        "日报",
        body,
        "",
        "",
        img_md=img_md,
        manifest_names=[shot["name"] for shot in manifest],
    )


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

    report_md = compiled_markdown(archive, "## 概览\n\n正文", annotated_manifest)
    html = archive.build_interactive_html("日报", "fail", report_md, annotated_manifest)
    if "map-acceptance-template" not in html or 'data-template="map-acceptance-interactive-html-v2"' not in html:
        raise AssertionError("standard interactive HTML is missing the acceptance template marker")
    if html.count('class="edition-version">v0.9</small>') != 2:
        raise AssertionError("report version must be visible in the sidebar and masthead")

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
        "日报",
        "conditional",
        compiled_markdown(archive, daily_report, annotated_manifest),
        annotated_manifest,
        flavor="daily",
    )
    if '<span>缺口</span><strong>4</strong>' not in daily_html:
        raise AssertionError("header gap metric must use the four unique ledger rows")
    if "报告时间 · 2026-07-22 07:15:30 CST+0800" not in daily_html:
        raise AssertionError("report time must be visible in the top-right masthead")
    if "先看这里：风险证据和未覆盖项" not in daily_html:
        raise AssertionError("conditional reports must expose a risk-and-gap focus block")
    if "G1 · 设置页在线终态" not in daily_html or "查看完整缺口账本" not in daily_html:
        raise AssertionError("conditional focus must expose structured gap items")

    relationship_manifest = [
        {"name": "01-entry", "caption": "图 01 验证首页入口可以访问", "annotated": True},
        {"name": "02-action", "caption": "图 02 验证主操作可以执行", "annotated": True},
        {"name": "03-result", "caption": "图 03 验证结果状态已经更新", "annotated": True},
    ]
    partial_body = """
## 步骤 1

点击首页入口。{{IMG:01-entry}}

## 需求一一对应表

| 需求 | 证据 |
|---|---|
| 完整流程 | 图01-03 |
"""
    relationship_md = compiled_markdown(archive, partial_body, relationship_manifest)
    if "## 补充证据（归档程序自动填充）" not in relationship_md:
        raise AssertionError("manifest images omitted by the writer must be auto-filled")
    for shot in relationship_manifest:
        anchor = archive._figure_anchor(archive._figure_key(shot["name"]))
        if relationship_md.count(f'id="{anchor}"') != 1:
            raise AssertionError(f"{anchor} must be emitted exactly once")
    for num in ("01", "02", "03"):
        if f"[图{num}](#fig-{num}-" not in relationship_md:
            raise AssertionError("figure ranges must expand into individually linked figures")

    mixed_md = compiled_markdown(
        archive,
        "## 步骤 1\n\n{{IMG:01-entry}}\n\n## 证据板\n\n{{EVIDENCE}}",
        relationship_manifest,
    )
    for shot in relationship_manifest:
        anchor = archive._figure_anchor(archive._figure_key(shot["name"]))
        if mixed_md.count(f'id="{anchor}"') != 1:
            raise AssertionError("mixed inline and evidence-board mode must not duplicate anchors")

    relationship_html = archive.build_interactive_html(
        "日报",
        "pass",
        relationship_md,
        relationship_manifest,
    )
    if relationship_html.count('class="evidence-card"') != 3:
        raise AssertionError("every manifest item must have one evidence card")
    if relationship_html.count('class="figure-back-link"') != 3:
        raise AssertionError("every body figure must provide a return-to-evidence-list control")
    if relationship_html.count('data-side-tab=') != 2:
        raise AssertionError("sidebar must provide evidence and contents tabs")
    if 'data-side-tab="evidence"' not in relationship_html or 'data-side-tab="contents"' not in relationship_html:
        raise AssertionError("sidebar tabs must be evidence and contents")
    if "aside{position:sticky;top:0;z-index:20" not in relationship_html:
        raise AssertionError("sidebar tabs must remain visible in the embedded narrow report viewport")
    if '<div class="thumb-placeholder"' in relationship_html or ">无缩略图<" in relationship_html:
        raise AssertionError("interactive reports must never contain thumbnail placeholders")
    assert_no_errors(archive._interactive_evidence_errors(relationship_html, relationship_manifest))
    if "(h||t).scrollIntoView" in relationship_html or "t.scrollIntoView({block:'start'})" not in relationship_html:
        raise AssertionError("card clicks must scroll to the exact figure, not its section heading")

    conditional_body = """
## 缺陷清单

| ID | 严重级 | 页面/路径 | 现象 | 影响 | 定位证据 | 建议 |
|---|---|---|---|---|---|---|
| D1 | P2 | 更新中心 | 浅色文字对比偏低 | 阅读重点不清晰 | [图02](#fig-02-action) | 提高对比度 |

## 总缺口账本

| ID | 未覆盖项 | 解除条件 |
|---|---|---|
| G1 | 管理员真实撤销动作 | 提供隔离测试账号 |

## 步骤 1 定位风险

{{IMG:02-action}}
"""
    conditional_html = archive.build_interactive_html(
        "条件验收",
        "conditional",
        compiled_markdown(archive, conditional_body, relationship_manifest),
        relationship_manifest,
    )
    if '<span>P1-P2 风险</span><strong>1</strong>' not in conditional_html:
        raise AssertionError("conditional risk metric must parse severity columns that are not first")
    if "D1 · 浅色文字对比偏低" not in conditional_html:
        raise AssertionError("conditional focus must show the structured defect")
    if 'class="figure-problem-banner is-risk"' not in conditional_html:
        raise AssertionError("P1/P2 evidence figures must receive an amber risk marker")
    if 'data-label="有条件风险 · P2"' not in conditional_html:
        raise AssertionError("conditional figure marker must state the risk severity")
    if "section-nav-item is-risk" not in conditional_html or "section-nav-item is-gap" not in conditional_html:
        raise AssertionError("directory must mark risk and gap sections")
    if conditional_html.index('href="#缺陷清单"') > conditional_html.index('href="#总缺口账本"'):
        raise AssertionError("directory must place risk sections before gap sections")

    missing_source_md = relationship_md.replace(
        "https://assets.example.test/03-result.png",
        "",
    )
    try:
        archive.build_interactive_html("日报", "pass", missing_source_md, relationship_manifest)
    except RuntimeError as exc:
        if "缺少最终图片地址" not in str(exc):
            raise
    else:
        raise AssertionError("a missing thumbnail source must fail report compilation")

    broken_html = relationship_html.replace(
        'href="#fig-03-result"',
        'href="#fig-99-missing"',
        1,
    )
    assert_has_error(
        archive._interactive_evidence_errors(broken_html, relationship_manifest),
        "无法唯一解析",
    )

    with tempfile.TemporaryDirectory() as tmp:
        first = Path(tmp) / "first.png"
        second = Path(tmp) / "second.png"
        first.write_bytes(b"same-image-bytes")
        second.write_bytes(b"same-image-bytes")
        duplicate_manifest = [
            {"name": "01-first", "path": str(first)},
            {"name": "02-second", "path": str(second)},
        ]
        assert_has_error(
            archive._duplicate_evidence_errors(duplicate_manifest),
            "文件完全相同",
        )
        duplicate_manifest[1]["duplicateOf"] = "01-first"
        assert_no_errors(archive._duplicate_evidence_errors(duplicate_manifest))
        second.write_bytes(b"different-image-bytes")
        assert_has_error(
            archive._duplicate_evidence_errors(duplicate_manifest),
            "文件内容不同",
        )

    print("acceptance archive report gates passed")


if __name__ == "__main__":
    main()
