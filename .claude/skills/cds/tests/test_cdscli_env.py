"""CDS 环境变量写入：密钥可从标准输入传递且不会进入命令行。"""

import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import cdscli  # noqa: E402


def test_env_set_reads_secret_from_stdin_without_changing_value(monkeypatch):
    captured = {}
    monkeypatch.setattr(sys, "stdin", io.StringIO("secret-with=equals\n"))
    monkeypatch.setattr(cdscli, "_call", lambda method, path, body=None: captured.update({
        "method": method,
        "path": path,
        "body": body,
    }) or {"ok": True})
    monkeypatch.setattr(cdscli, "ok", lambda *_args, **_kwargs: None)

    args = type("Args", (), {
        "key": "R2_SECRET_ACCESS_KEY",
        "value_stdin": True,
        "value": None,
        "kv": None,
        "scope": "_global",
    })()
    cdscli.cmd_env_set(args)

    assert captured == {
        "method": "PUT",
        "path": "/api/env/R2_SECRET_ACCESS_KEY?scope=_global",
        "body": {"value": "secret-with=equals"},
    }


def test_env_set_only_removes_one_terminal_newline(monkeypatch):
    captured = {}
    monkeypatch.setattr(sys, "stdin", io.StringIO("line-one\nline-two\n"))
    monkeypatch.setattr(cdscli, "_call", lambda _method, _path, body=None: captured.update(body or {}) or {})
    monkeypatch.setattr(cdscli, "ok", lambda *_args, **_kwargs: None)

    args = type("Args", (), {
        "key": "MULTILINE_SECRET",
        "value_stdin": True,
        "value": None,
        "kv": None,
        "scope": None,
    })()
    cdscli.cmd_env_set(args)

    assert captured["value"] == "line-one\nline-two"
