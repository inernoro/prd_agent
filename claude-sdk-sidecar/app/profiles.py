"""
命名 profile 解析（cc-switch 风格）。

启动时读取 PROFILES_PATH（默认 /app/profiles.yaml）—— 文件不存在或无 yaml 依赖则视为
"无 profile 模式"，所有命名 profile 解析失败。env 变量直连 / per-request 覆盖路径仍可用。

profile yaml 格式（示例见 profiles.example.yaml）：

    profiles:
      anthropic:
        base_url: null
        api_key: ${ANTHROPIC_API_KEY}
      deepseek:
        base_url: https://api.deepseek.com/anthropic
        api_key: ${DEEPSEEK_API_KEY}
      cc-switch:
        base_url: http://host.docker.internal:8888
        api_key: dummy
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from typing import Optional


logger = logging.getLogger("sidecar.profiles")

_VAR_RE = re.compile(r"\$\{([A-Z0-9_]+)\}")


@dataclass(frozen=True)
class Profile:
    name: str
    base_url: Optional[str]
    api_key: Optional[str]


_REGISTRY: dict[str, Profile] = {}
_LOADED = False


def _expand_env(value):
    if not isinstance(value, str):
        return value

    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        return os.environ.get(key, "")

    return _VAR_RE.sub(repl, value)


def _load() -> None:
    """启动时调用一次。文件 / 解析 / yaml 缺失都是软错误：登记为空，写日志，继续。"""
    global _LOADED
    if _LOADED:
        return
    _LOADED = True

    path = os.environ.get("PROFILES_PATH", "/app/profiles.yaml")
    if not os.path.exists(path):
        logger.info("profiles.yaml not found at %s; only env / per-request override available", path)
        return

    try:
        import yaml  # type: ignore
    except ImportError:
        logger.warning("PyYAML not installed; profiles.yaml at %s ignored", path)
        return

    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f) or {}
    except Exception as ex:  # pylint: disable=broad-except
        logger.warning("failed to load %s: %s", path, ex)
        return

    raw = (doc.get("profiles") or {}) if isinstance(doc, dict) else {}
    if not isinstance(raw, dict):
        logger.warning("profiles section in %s is not a mapping; ignored", path)
        return

    for name, body in raw.items():
        if not isinstance(body, dict):
            continue
        base_url = _expand_env(body.get("base_url"))
        api_key = _expand_env(body.get("api_key"))
        if isinstance(base_url, str) and not base_url.strip():
            base_url = None
        if isinstance(api_key, str) and not api_key.strip():
            api_key = None
        _REGISTRY[str(name)] = Profile(name=str(name), base_url=base_url, api_key=api_key)

    logger.info("loaded %d profile(s) from %s: %s", len(_REGISTRY), path, list(_REGISTRY.keys()))


def resolve_profile(name: str) -> Optional[Profile]:
    """返回 None 表示找不到。调用方负责报错。"""
    _load()
    return _REGISTRY.get(name)


def list_profiles() -> list[str]:
    _load()
    return list(_REGISTRY.keys())
