"""已批准的单键正式配置维护：克隆正在运行的 API，绝不拉取或升级镜像。"""
import argparse
import copy
import fcntl
import http.client
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time

KEY = "StableSmokeAuthentication__NotificationTargetUsername"
DOTENV_KEY = "STABLE_SMOKE_NOTIFICATION_TARGET_USERNAME"
TARGET = "inernoro"


def patch_dotenv(text):
    lines = text.splitlines(keepends=True)
    matched = [i for i, line in enumerate(lines) if re.match(rf"^(?:export\s+)?{DOTENV_KEY}=", line)]
    if len(matched) > 1:
        raise ValueError("固定通知配置存在重复声明，停止维护")
    if matched:
        lines[matched[0]] = f"{DOTENV_KEY}={TARGET}\n"
        return "".join(lines)
    return text + ("" if not text or text.endswith("\n") else "\n") + f"{DOTENV_KEY}={TARGET}\n"


def clone_api_config(inspect, expected_commit):
    if inspect.get("Name") != "/prdagent-api" or inspect.get("State", {}).get("Running") is not True:
        raise ValueError("正式 API 身份或运行状态不符")
    config = copy.deepcopy(inspect["Config"])
    if config.get("Labels", {}).get("org.opencontainers.image.revision") != expected_commit:
        raise ValueError("正式业务版本已变化，停止维护")
    env = config.get("Env", [])
    matches = [i for i, value in enumerate(env) if value.startswith(KEY + "=")]
    if len(matches) != 1:
        raise ValueError("API 固定通知配置缺失或重复，停止维护")
    config["Env"][matches[0]] = KEY + "=" + TARGET
    # 使用当前已运行的 image ID，不使用 latest、可漂移tag或远端拉取。
    config["Image"] = inspect["Image"]
    endpoints = {}
    for name, endpoint in inspect.get("NetworkSettings", {}).get("Networks", {}).items():
        aliases = [alias for alias in endpoint.get("Aliases", []) or [] if alias != inspect.get("Id") and not re.fullmatch(r"[0-9a-f]{12,64}", alias)]
        endpoints[name] = {"Aliases": aliases}
    if not endpoints:
        raise ValueError("API 网络归属不可确认，停止维护")
    return {**config, "HostConfig": copy.deepcopy(inspect["HostConfig"]), "NetworkingConfig": {"EndpointsConfig": endpoints}}


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect("/var/run/docker.sock")


def docker(method, path, body=None):
    connection = DockerConnection("localhost", timeout=60)
    connection.request(method, path, body=json.dumps(body) if body is not None else None,
                       headers={"Content-Type": "application/json"})
    response = connection.getresponse()
    raw = response.read()
    status = response.status
    connection.close()
    if status not in [200, 201, 204, 304]:
        # 不回显 Docker 正文，避免异常内嵌配置或凭据。
        raise RuntimeError(f"Docker 维护阶段失败，状态 {status}")
    return json.loads(raw) if raw else {}


def atomic_config(path, content, stat):
    temporary = path.with_name(path.name + ".stsmk-next")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temporary, stat.st_mode & 0o777)
    os.chown(temporary, stat.st_uid, stat.st_gid)
    os.replace(temporary, path)


def reload_proxy():
    subprocess.run(["docker", "exec", "prdagent-gateway", "nginx", "-t"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["docker", "exec", "prdagent-gateway", "nginx", "-s", "reload"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def maintain(expected_commit, run_id, execute=False):
    if not re.fullmatch(r"[0-9a-f]{40}", expected_commit) or not re.fullmatch(r"stsmk-[a-z0-9-]+", run_id):
        raise ValueError("维护身份或业务版本无效")
    root = Path.cwd().resolve()
    git_root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()).resolve()
    if root != git_root:
        raise ValueError("维护目录不是受管项目根目录")
    git_dir = Path(subprocess.check_output(["git", "rev-parse", "--absolute-git-dir"], text=True).strip()).resolve()
    # 凭据备份放 Git 元数据，不可能被 git add 当作业务文件提交。
    lock = (git_dir / "stable-smoke-notify-config.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    env_file = root / ".env"
    stat = env_file.stat()
    if stat.st_mode & 0o077:
        raise ValueError("正式配置权限不安全，停止维护")
    original = env_file.read_text()
    patched = patch_dotenv(original)
    old = docker("GET", "/containers/prdagent-api/json")
    payload = clone_api_config(old, expected_commit)
    print(json.dumps({"phase": "plan", "key": KEY, "target": TARGET, "commit": expected_commit, "upgrade": False}), flush=True)
    if not execute:
        return
    backup_name = run_id + "-api-before-config"
    backup_file = git_dir / (run_id + "-notification.env.backup")
    with os.fdopen(os.open(backup_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(original)
    os.chmod(backup_file, 0o600)
    before_id = old["Id"]
    if docker("GET", "/containers/prdagent-api/json")["Id"] != before_id or env_file.read_text() != original:
        raise ValueError("维护前版本或配置已变化，停止维护")
    new_id = ""
    renamed = False
    try:
        atomic_config(env_file, patched, stat)
        docker("POST", f"/containers/{before_id}/stop?t=30")
        docker("POST", f"/containers/{before_id}/rename?name={backup_name}")
        renamed = True
        new_id = docker("POST", "/containers/create?name=prdagent-api", payload)["Id"]
        docker("POST", f"/containers/{new_id}/start")
        reload_proxy()
        for _ in range(60):
            current = docker("GET", f"/containers/{new_id}/json")
            if current.get("State", {}).get("Health", {}).get("Status") == "healthy":
                if current["Image"] != old["Image"] or KEY + "=" + TARGET not in current["Config"]["Env"]:
                    raise RuntimeError("配置或业务镜像回读不一致")
                print(json.dumps({"phase": "completed", "commit": expected_commit, "sameImage": True, "target": TARGET, "rollbackContainer": backup_name, "originalConfigRetained": True}), flush=True)
                return
            time.sleep(2)
        raise RuntimeError("维护后 API 健康未恢复")
    except Exception:
        if new_id:
            docker("POST", f"/containers/{new_id}/stop?t=30")
            docker("POST", f"/containers/{new_id}/rename?name={run_id}-api-failed-config")
        if renamed:
            docker("POST", f"/containers/{before_id}/rename?name=prdagent-api")
        atomic_config(env_file, original, stat)
        docker("POST", f"/containers/{before_id}/start")
        reload_proxy()
        print(json.dumps({"phase": "restored", "sameImage": True}), flush=True)
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        maintain(args.expected_commit, args.run_id, args.execute)
    except Exception as error:
        print(json.dumps({"phase": "blocked", "reason": str(error) if isinstance(error, (ValueError, RuntimeError)) else "维护执行失败；请核对受管运行记录"}), flush=True)
        raise SystemExit(2)
