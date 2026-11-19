#!/usr/bin/env python3
"""Capture and restore a local Compose release without pulling images or replacing data volumes."""

import argparse
import json
import os
from pathlib import Path
import subprocess


def docker(*args):
    result = subprocess.run(["docker", *args], capture_output=True, text=True)
    if result.returncode:
        # Docker can put expanded Compose values in diagnostics.
        raise RuntimeError(f"Docker {args[0]} failed (exit {result.returncode})")
    return result.stdout


def inventory(project):
    ids = docker("ps", "-aq", "--filter", f"label=com.docker.compose.project={project}").split()
    containers = json.loads(docker("inspect", *ids)) if ids else []
    return {
        row["Config"]["Labels"]["com.docker.compose.service"]: row
        for row in containers
        if row["Config"]["Labels"].get("com.docker.compose.oneoff", "").lower() != "true"
    }


def compose_prefix(project, row):
    labels = row["Config"]["Labels"]
    directory = labels.get("org.map.release.source-directory") or labels["com.docker.compose.project.working_dir"]
    files = (labels.get("org.map.release.source-files") or labels["com.docker.compose.project.config_files"]).split(",")
    return ["compose", "-p", project, "--project-directory", directory] + [
        part for file in files for part in ("-f", file)
    ]


def escape_interpolation(value):
    if isinstance(value, str):
        return value.replace("$", "$$")
    if isinstance(value, list):
        return [escape_interpolation(item) for item in value]
    if isinstance(value, dict):
        return {key: escape_interpolation(item) for key, item in value.items()}
    return value


def capture(project, gateway, directory):
    containers = inventory(project)
    groups = {}
    for name, row in containers.items():
        groups.setdefault(tuple(compose_prefix(project, row)), []).append(name)
    snapshot = {}
    for index, (prefix, names) in enumerate(groups.items()):
        model = json.loads(docker(*prefix, "config", "--format", "json"))
        model["services"] = {name: model["services"][name] for name in names}
        filename = f"compose-{index}.json"
        for name in names:
            row = containers[name]
            service = model["services"][name]
            docker("image", "inspect", row["Image"], "--format", "{{.Id}}")
            service["image"] = row["Image"]
            service.pop("build", None)
            service.pop("depends_on", None)
            service["environment"] = dict(value.split("=", 1) for value in row["Config"]["Env"] or [])
            labels = service.setdefault("labels", {})
            labels["org.map.release.source-directory"] = prefix[4]
            labels["org.map.release.source-files"] = ",".join(prefix[6::2])
            snapshot[name] = {"image": row["Image"], "running": row["State"]["Running"],
                              "id": row["Id"], "compose": filename}
        (directory / filename).write_text(json.dumps(escape_interpolation(model)))
    (directory / "containers.json").write_text(json.dumps(snapshot))


def restore(project, gateway, directory):
    snapshot = json.loads((directory / "containers.json").read_text())
    current = inventory(project)
    for name in sorted(current.keys() - snapshot.keys()):
        # Removing containers keeps named and anonymous data volumes.
        docker("rm", "-f", current[name]["Id"])
    changed = {}
    for name in sorted(snapshot, key=lambda item: item == gateway):
        expected = snapshot[name]
        if name not in current or current[name]["Id"] != expected["id"] or current[name]["State"]["Running"] != expected["running"]:
            changed.setdefault((name == gateway, expected["compose"]), []).append(name)
    for (_, filename), names in changed.items():
        prefix = ["compose", "-p", project, "-f", str(directory / filename)]
        docker(*prefix, "up", "-d", "--force-recreate", "--no-deps", "--pull", "never", *names)
        stopped = [name for name in names if not snapshot[name]["running"]]
        if stopped:
            docker(*prefix, "stop", *stopped)
    actual = inventory(project)
    for name, expected in snapshot.items():
        row = actual.get(name)
        if not row or row["Image"] != expected["image"] or row["State"]["Running"] != expected["running"]:
            raise RuntimeError(f"回滚核对未通过，服务 {name} 的镜像或运行状态与发布前不符")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("capture", "restore"))
    parser.add_argument("project")
    parser.add_argument("gateway")
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        handler = capture if args.action == "capture" else restore
        handler(args.project, args.gateway, args.directory)
    except (KeyError, OSError, RuntimeError, ValueError) as error:
        # KeyError/ValueError can include raw Compose input. Report the type only.
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        parser.exit(1, f"ERROR: 生产运行版本{('备份' if args.action == 'capture' else '恢复')}失败：{detail}\n")


if __name__ == "__main__":
    main()
