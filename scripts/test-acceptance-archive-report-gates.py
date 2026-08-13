#!/usr/bin/env python3
"""Focused regression tests for acceptance archive gates."""

from __future__ import annotations

import importlib.util
from datetime import datetime
import tempfile
from pathlib import Path
from types import SimpleNamespace


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

    naming_now = datetime(2026, 7, 23, 10, 0)
    naming_cfg = {"project": "prd-agent"}

    daily_args = SimpleNamespace(
        report_kind="每日验收",
        title_focus="全量变更",
        report_date="2026-07-22",
        target="昨日全量变更 · 每日巡检 · 验收报告",
        module="每日验收",
        feature="",
        type="",
        pr=None,
        commit="e581ce4548",
    )
    daily_title, daily_kind, daily_date = archive.build_report_title(
        daily_args, naming_cfg, naming_now, "# 每日验收报告"
    )
    if (daily_title, daily_kind, daily_date) != (
        "每日验收 · 全量变更 · 2026-07-22",
        "每日验收",
        "2026-07-22",
    ):
        raise AssertionError(f"unexpected daily acceptance title: {daily_title}")
    if "prd-agent" in daily_title or "验收报告" in daily_title:
        raise AssertionError("project and redundant report suffix must not occupy the acceptance title")

    function_args = SimpleNamespace(
        report_kind="",
        title_focus="",
        report_date="",
        target="授权表主题样式",
        module="开放平台",
        feature="授权表主题",
        type="修复",
        pr=None,
        commit="710ce135d0",
    )
    function_title, function_kind, function_date = archive.build_report_title(
        function_args, naming_cfg, naming_now, "# 功能验收"
    )
    if (function_title, function_kind, function_date) != (
        "功能验收 · 开放平台 / 授权表主题 · 2026-07-23",
        "功能验收",
        "2026-07-23",
    ):
        raise AssertionError(f"unexpected function acceptance title: {function_title}")

    pr_args = SimpleNamespace(
        report_kind="",
        title_focus="授权表主题",
        report_date="2026-07-23",
        target="PR #1227 验收",
        module="开放平台",
        feature="",
        type="修复",
        pr=1227,
        commit="710ce135d0",
    )
    pr_title, pr_kind, _ = archive.build_report_title(pr_args, naming_cfg, naming_now, "# PR 验收")
    if pr_kind != "PR验收" or pr_title != "PR验收 · #1227 / 开放平台 / 授权表主题 · 2026-07-23":
        raise AssertionError(f"unexpected PR acceptance title: {pr_title}")

    defect_args = SimpleNamespace(
        report_kind="",
        title_focus="开放平台授权表",
        report_date="2026-07-23",
        target="缺陷复测",
        module="",
        feature="",
        type="修复",
        pr=None,
        commit="710ce135d0",
    )
    defect_title, defect_kind, _ = archive.build_report_title(
        defect_args, naming_cfg, naming_now, "# 缺陷复测"
    )
    if defect_kind != "缺陷复测" or defect_title != "缺陷复测 · 开放平台授权表 · 2026-07-23":
        raise AssertionError(f"unexpected defect retest title: {defect_title}")
    try:
        archive._validate_report_date("2026-7-3")
    except archive.argparse.ArgumentTypeError:
        pass
    else:
        raise AssertionError("report date must require zero-padded YYYY-MM-DD")
    try:
        archive._validate_report_date("2026-02-30")
    except archive.argparse.ArgumentTypeError:
        pass
    else:
        raise AssertionError("report date must reject impossible calendar dates")

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

    business_report = """
## 老板一页结论

| 指标 | 数量 | 给业务读者的解释 |
|---|---:|---|
| 计划测试 | 191 | 本轮合同项 |
| 已完成 | 79 | 已有明确结果 |
| 通过 | 48 | 业务断言成立 |
| 失败 | 31 | 需要处理和复测 |
| 功能未执行 | 112 | 不能按通过计算 |

## 双环境覆盖差异

| 环境 | 计划 | 已完成 | 通过 | 失败 | 未执行 | 业务结论 |
|---|---:|---:|---:|---:|---:|---|
| CDS | 103 | 78 | 47 | 31 | 25 | 已执行完整矩阵，仍有失败 |
| 正式环境 | 88 | 1 | 1 | 0 | 87 | 安全门槛下仅执行只读检查 |

## 截图证据怎么读

| 视觉指标 | 数量 | 代表什么 |
|---|---:|---|
| 计划截图槽位 | 148 | 合同要求 |
| 已采集且可审核 | 148 | 字段齐全，不等于通过 |
| 能直接证明通过 | 36 | 目标状态成立 |
| 明确不通过 | 0 | 图片直接呈现失败 |
| 不能证明业务结果 | 112 | 仍需运行态证据 |

## 不通过问题与复现

| 根因 | 影响项数 | 影响模块 | 验收项编号 | 实际结果 | 期望结果 | 复现方式 | 本次直接证据 | 复测方法 | 当前责任角色 | 完成时限 | 恢复动作 |
|---|---:|---|---|---|---|---|---|---|---|---|---|
| ASR 默认池没有健康成员 | 6 | 录音转笔记 | REC-003 | 无法转录 | 返回转录笔记 | 首页 → 知识库 → 上传音频 → 等待转录 | [失败记录](#老板一页结论) | [方法](#老板一页结论) | 录音负责人 | 下一轮复测前 | 恢复模型池后复测 |
"""
    business_html = archive.build_interactive_html(
        "稳定冒烟",
        "fail",
        compiled_markdown(archive, business_report, annotated_manifest),
        annotated_manifest,
    )
    for needle in (
        '<span>计划测试</span><strong>191</strong>',
        '<span>已完成</span><strong>79</strong>',
        '<span>通过</span><strong>48</strong>',
        '<span>失败</span><strong>31</strong>',
        '<span>功能未执行</span><strong>112</strong>',
        '计划 191 项，完成 79 项',
        '已采集”只代表图、路径、时间和方法齐全，不代表业务已经通过',
        'CDS：完成 78/103',
        '正式环境：完成 1/88',
        '数字相同纯属巧合，不能一一对应',
        'ASR默认池没有健康成员',
        '<b>复现：</b>首页→知识库→上传音频→等待转录',
        '<b>恢复：</b>恢复模型池后复测',
        '<b>编号：</b>REC-003',
        '<b>责任：</b>录音负责人；<b>时限：</b>下一轮复测前',
    ):
        if needle not in business_html:
            raise AssertionError(f"business decision page is missing: {needle}")
    if "未抽取到结构化重点项" in business_html:
        raise AssertionError("business decision reports must not show the generic extraction fallback")

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
    # 没有「给你的一页结论」的报告保持完整版，行为与本次改动前一致。
    if '<body data-view="full">' not in daily_html or 'data-view-mode="brief"' in daily_html:
        raise AssertionError("reports without the plain summary must stay in full view")

    # 有「给你的一页结论」的报告默认落简版，并带简版/完整版切换。
    plain_report = daily_report.replace(
        "## 验收时间",
        f"## {archive.PLAIN_SUMMARY_SECTION}\n\n"
        "| 你要知道的 | 答案 |\n"
        "|---|---|\n"
        "| 产品能不能用 | 这次没测出来，不能保证 |\n"
        "| 验收测完了吗 | 没测完，缺 4 项 |\n"
        "| 昨天上了什么 | 录音页面新增自动续录；周报页面加了导出按钮 |\n"
        f"| 需要你决定什么 | {archive.PLAIN_NO_DECISION} |\n"
        "| 下面的内容 | 都是给工程师看的技术细节，你可以不看 |\n\n"
        "## 验收时间",
        1,
    )
    plain_html = archive.build_interactive_html(
        "日报",
        "conditional",
        compiled_markdown(archive, plain_report, annotated_manifest),
        annotated_manifest,
        flavor="daily",
    )
    if '<body data-view="brief">' not in plain_html:
        raise AssertionError("plain-summary reports must open in the brief view")
    for needle in (
        'data-view-mode="brief"',
        'data-view-mode="full"',
        'body[data-view="brief"] .rb-hidden',
        archive.PLAIN_SUMMARY_SECTION,
    ):
        if needle not in plain_html:
            raise AssertionError(f"brief view is missing its wiring: {needle}")
    # 正文只是「提到」这五个字、并没有那一节时，不得切简版：
    # 子串判据会让这类报告开在简版而没有任何章节留得住，读者看到一页空白。
    mention_only = daily_report.replace(
        "## 覆盖缺口",
        f"## 目标与价值\n\n验证「{archive.PLAIN_SUMMARY_SECTION}」首屏在存量报告上不误伤。\n\n## 覆盖缺口",
        1,
    )
    mention_html = archive.build_interactive_html(
        "日报",
        "conditional",
        compiled_markdown(archive, mention_only, annotated_manifest),
        annotated_manifest,
        flavor="daily",
    )
    if '<body data-view="full">' not in mention_html or 'data-view-mode="brief"' in mention_html:
        raise AssertionError("merely mentioning the plain summary must not switch to brief view")

    # 模板契约结构（CDS reports.ts 与本 gate 双重校验）不得被简版改动破坏。
    for marker in (
        'data-template="map-acceptance-interactive-html-v2"',
        'class="layout"',
        'class="hero"',
        'class="evidence-nav"',
        'id="reportBody"',
    ):
        if marker not in plain_html:
            raise AssertionError(f"brief view broke the template contract: {marker}")

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
    if relationship_html.count("data-mobile-nav-toggle>") != 1:
        raise AssertionError("mobile report navigation must provide exactly one drawer toggle")
    if 'id="mobile-nav-drawer"' not in relationship_html:
        raise AssertionError("mobile report navigation must provide a controlled drawer")
    if "aside.mobile-nav-open .side-drawer{display:block}" not in relationship_html:
        raise AssertionError("mobile report navigation must stay collapsed until explicitly opened")
    if ".evidence-nav,.section-nav{display:flex;flex-direction:column" not in relationship_html:
        raise AssertionError("mobile evidence and contents navigation must be vertical, not horizontal carousels")
    if "html,body{overflow-x:clip}" not in relationship_html:
        raise AssertionError("mobile page-level horizontal scrolling must be disabled while tables keep local scrolling")
    if "if(isMobileNavigation()) setMobileNavOpen(true)" not in relationship_html:
        raise AssertionError("selecting a mobile navigation tab must open its drawer")
    if "requestAnimationFrame(function(){requestAnimationFrame(scroll);})" not in relationship_html:
        raise AssertionError("mobile anchor jumps must wait for drawer collapse before measuring the target")
    if ".figure-anchor,#evidence-gallery,h1,h2,h3{scroll-margin-top:118px}" not in relationship_html:
        raise AssertionError("mobile targets must reserve the compact sticky navigation height")
    if "document.getElementById(id)" not in relationship_html or "decodeURIComponent(id)" not in relationship_html:
        raise AssertionError("encoded Chinese section hashes must resolve through decoded element IDs")
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
