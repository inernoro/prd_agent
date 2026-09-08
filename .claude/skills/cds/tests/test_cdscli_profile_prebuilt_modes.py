"""profile list 的极速版判据：prebuiltModes 只认 deployModes.<mode>.prebuilt 为 true。

接入口令要求 Agent 分支一律走极速版（CI 预构建），并且「模式名不是判据」——
所以 profile 摘要必须把 prebuilt 模式单独列出来，Agent 才有得认。
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI_DIR = ROOT / "cli"
sys.path.insert(0, str(CLI_DIR))

import cdscli  # noqa: E402


def _profile(**overrides):
    base = {
        "id": "api",
        "name": "api",
        "projectId": "proj-a",
        "activeDeployMode": "",
        "deployModes": {
            "dev": {"label": "开发模式"},
            "static": {"label": "静态部署", "prebuilt": False},
            "express": {"label": "极速版", "prebuilt": True, "image": "ghcr.io/x/api:sha-${CDS_COMMIT_SHA}"},
        },
        "readinessProbe": {"timeoutSeconds": 300},
    }
    base.update(overrides)
    return base


def test_profile_summary_lists_prebuilt_modes_by_flag_not_name():
    summary = cdscli._profile_summary(_profile())
    assert summary["deployModes"] == ["dev", "static", "express"]
    assert summary["prebuiltModes"] == ["express"]
    assert summary["prebuiltImage"] is False


def test_profile_summary_accepts_string_true_and_ignores_mode_name():
    # 模式名叫 express 但 prebuilt 没开：不算极速版；名字随意但 prebuilt='true'：算。
    summary = cdscli._profile_summary(_profile(deployModes={
        "express": {"label": "假极速"},
        "ci-image": {"label": "CI 镜像", "prebuilt": "true"},
    }))
    assert summary["prebuiltModes"] == ["ci-image"]


def test_profile_summary_without_prebuilt_modes_is_empty_list():
    # 空列表是「项目还没接 CI 预构建」的信号，Agent 据此停下报告缺口，而不是猜一个名字。
    summary = cdscli._profile_summary(_profile(deployModes={"dev": {"label": "开发模式"}}))
    assert summary["prebuiltModes"] == []


def test_profile_summary_marks_prebuilt_image_site():
    summary = cdscli._profile_summary(_profile(deployModes={}, prebuiltImage=True))
    assert summary["prebuiltModes"] == []
    assert summary["prebuiltImage"] is True


def test_prebuilt_modes_inherit_profile_prebuilt_image_when_mode_omits_flag():
    # 与服务端同口径：mode.prebuilt ?? profile.prebuiltImage。镜像站点上未声明的模式可切，显式 False 的不可切。
    summary = cdscli._profile_summary(_profile(prebuiltImage=True, deployModes={
        "source": {"label": "源码", "prebuilt": False},
        "plain": {"label": "沿用"},
    }))
    assert summary["prebuiltModes"] == ["plain"]
    assert summary["prebuiltImage"] is True


def test_managed_build_profile_has_no_prebuilt_signals():
    # 与服务端同口径：managedBuild 是宿主源码构建，prebuiltModes 为空、prebuiltImage 也不报可用。
    summary = cdscli._profile_summary(_profile(
        prebuiltImage=True,
        managedBuild={"install": "pnpm i", "build": "pnpm build"},
        deployModes={"express": {"label": "极速版", "prebuilt": True}},
    ))
    assert summary["prebuiltModes"] == []
    assert summary["prebuiltImage"] is False
