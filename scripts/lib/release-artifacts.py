#!/usr/bin/env python3
"""Commit-addressed web bundles. Published bundles are reused, never replaced.

GitHub Releases own retention; Pages is only a replaceable presentation layer.
Downloads are public and never carry the workflow token across redirects.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile


class ArtifactError(Exception):
    pass


def checked_ref(ref):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", ref) or ref == "latest":
        raise ArtifactError("A fixed SHA or release tag is required; latest remains a compatibility channel")
    if ref.startswith("sha-") and not re.fullmatch(r"sha-[0-9a-f]{40}", ref):
        raise ArtifactError("Commit reference must contain the full lowercase SHA")
    return ref


def names(ref):
    checked_ref(ref)
    return [f"prd-admin-dist-{ref}.zip", f"prd-admin-dist-{ref}.zip.sha256", f"release-manifest-{ref}.json"]


def urls(repo, ref, base=None):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ArtifactError("Invalid repository identity")
    base = base or f"https://github.com/{repo}/releases/download/web-{checked_ref(ref)}"
    return [base.rstrip("/") + "/" + name for name in names(ref)]


def read_url(url, limit=100 * 1024 * 1024):
    if not url.startswith("https://"):
        raise ArtifactError("Artifact sources must use HTTPS")
    request = urllib.request.Request(url, headers={"User-Agent": "MAP-Release-Artifact/1.0", "Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            data = response.read(limit + 1)
    except (urllib.error.URLError, TimeoutError) as error:
        status = getattr(error, "code", "unavailable")
        raise ArtifactError(f"Artifact source unavailable ({status}); no Pages fallback") from None
    if len(data) > limit:
        raise ArtifactError("Artifact exceeds the supported size")
    return data


def validate(directory, ref, commit=None):
    files = [Path(directory) / name for name in names(ref)]
    if not all(p.is_file() and p.stat().st_size > 0 for p in files):
        raise ArtifactError("The ZIP, checksum and manifest must all exist and be nonempty")
    try:
        manifest = json.loads(files[2].read_text())
        declared = manifest["webSha256"]
        actual_commit = manifest["commit"]
        checksum = files[1].read_text().split()[0]
    except (ValueError, KeyError, IndexError, UnicodeError, TypeError):
        raise ArtifactError("Malformed release manifest or checksum") from None
    if not re.fullmatch(r"[0-9a-f]{40}", str(actual_commit)):
        raise ArtifactError("Manifest must declare a full immutable commit")
    expected_commit = commit or (ref[4:] if ref.startswith("sha-") else actual_commit)
    if actual_commit != expected_commit or manifest.get("ref") != ref or manifest.get("webDist") != files[0].name:
        raise ArtifactError("Manifest commit/ref/ZIP does not match the requested release")
    actual = hashlib.sha256(files[0].read_bytes()).hexdigest()
    if not re.fullmatch(r"[0-9a-f]{64}", str(declared)) or declared != checksum or actual != declared:
        raise ArtifactError("ZIP, manifest and checksum SHA256 disagree")
    try:
        with zipfile.ZipFile(files[0]) as archive:
            if archive.testzip() is not None:
                raise ArtifactError("Corrupt ZIP")
            html = archive.read("index.html").decode()
            # Bind the actual entry resource to the declared commit, not just metadata.
            entries = re.findall(r'(?:src|href)=["\']/?(assets/[^"\']+\.(?:js|css))["\']', html)
            if not entries or not any(p.endswith(f"-{actual_commit}.js") for p in entries):
                raise ArtifactError("ZIP entry resources are not bound to the manifest commit")
            for entry in entries:
                if f"-{actual_commit}." not in entry or not archive.getinfo(entry).file_size:
                    raise ArtifactError("ZIP entry resource is absent, empty or belongs to another commit")
            if any(p.startswith("/") or ".." in Path(p).parts for p in archive.namelist()):
                raise ArtifactError("Unsafe ZIP member")
    except (zipfile.BadZipFile, KeyError, UnicodeError):
        raise ArtifactError("Invalid ZIP or missing entry resource") from None
    return {"commit": actual_commit, "ref": ref, "zipSha256": actual, "zipBytes": files[0].stat().st_size,
            "files": [{"name": p.name, "sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size} for p in files]}


def fetch(repo, ref, output, base=None, commit=None):
    # Never expose an unvalidated partial set to callers.
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    sources = urls(repo, ref, base)
    with tempfile.TemporaryDirectory(dir=output) as temporary:
        for name, url in zip(names(ref), sources):
            (Path(temporary) / name).write_bytes(read_url(url))
        result = validate(temporary, ref, commit)
        for name in names(ref):
            os.replace(Path(temporary) / name, output / name)
    result["urls"] = sources
    return result


def gh(*args, missing_ok=False):
    result = subprocess.run(["gh", *args], capture_output=True)
    if result.returncode:
        if missing_ok and b"HTTP 404" in result.stderr:
            return None
        # CLI errors can include signed redirect URLs; do not forward their text.
        raise ArtifactError("GitHub release operation failed; no overwrite or fallback attempted")
    return result.stdout


def release(repo, ref):
    data = gh("api", f"repos/{repo}/releases/tags/web-{checked_ref(ref)}", missing_ok=True)
    if data is not None:
        return json.loads(data)
    # A new draft does not create its Git tag until publication. Discover it
    # by ID rather than incorrectly treating a tag-endpoint 404 as absence.
    matches = []
    for number in range(1, 1001):
        page = json.loads(gh("api", f"repos/{repo}/releases?per_page=100&page={number}"))
        matches.extend(item for item in page if item["tag_name"] == "web-" + ref)
        if len(page) < 100:
            break
    else:
        raise ArtifactError("Release listing exceeded the supported safety bound")
    if len(matches) > 1:
        raise ArtifactError("Multiple drafts claim this ref; manual original-bundle recovery required")
    return matches[0] if matches else None


def restore(repo, ref, output, commit=None):
    existing = release(repo, ref)
    if existing is None:
        return {"exists": False}
    if existing.get("draft"):
        raise ArtifactError("An unpublished draft exists; recover its original workflow bundle before retrying")
    if not set(names(ref)).issubset({asset["name"] for asset in existing["assets"]}):
        raise ArtifactError("Published release is incomplete; refusing to rebuild or replace it")
    return {"exists": True, **fetch(repo, ref, output, commit=commit)}


def bundle(dist, output, repo, commit, ref):
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ArtifactError("Full commit required")
    files = [Path(output) / name for name in names(ref)]
    Path(output).mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(files[0], "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(Path(dist).rglob("*")):
            if path.is_symlink():
                raise ArtifactError("Symlinks are not accepted in release bundles")
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(dist).as_posix(), date_time=(2000, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
    digest = hashlib.sha256(files[0].read_bytes()).hexdigest()
    files[1].write_text(f"{digest}  {files[0].name}\n")
    manifest = {"commit": commit, "ref": ref, "webDist": files[0].name, "webSha256": digest}
    for key, image in [("apiImage", "prdagent-server"), ("llmgwImage", "prdagent-llmgw"),
                       ("llmgwServeImage", "prdagent-llmgw-serve"), ("llmgwWebImage", "prdagent-llmgw-web")]:
        manifest[key] = f"ghcr.io/{repo}/{image}:{ref}"
    files[2].write_text(json.dumps(manifest, indent=2) + "\n")
    return validate(output, ref, commit)


def alias(directory, source_ref, ref):
    original = validate(directory, source_ref)
    source = [Path(directory) / n for n in names(source_ref)]
    target = [Path(directory) / n for n in names(ref)]
    if ref == source_ref:
        return original
    shutil.copyfile(source[0], target[0])
    target[1].write_text(f"{original['zipSha256']}  {target[0].name}\n")
    manifest = json.loads(source[2].read_text())
    manifest.update(ref=ref, webDist=target[0].name)
    for key in ("apiImage", "llmgwImage", "llmgwServeImage", "llmgwWebImage"):
        if key in manifest:
            manifest[key] = manifest[key].rsplit(":", 1)[0] + ":" + ref
    target[2].write_text(json.dumps(manifest, indent=2) + "\n")
    return validate(directory, ref, original["commit"])


def pages(directory, ref, output, repo):
    result = validate(directory, ref)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(Path(directory) / names(ref)[0]) as archive:
        archive.extractall(output)
        archive.extractall(output / "admin")
    for name in names(ref):
        shutil.copyfile(Path(directory) / name, output / name)
    for root in (output, output / "admin"):
        (root / "commit.txt").write_text(result["commit"] + "\n")
    latest_names = ["prd-admin-dist-latest.zip", "prd-admin-dist-latest.zip.sha256", "release-manifest-latest.json"]
    if os.environ.get("PUBLISH_LATEST") == "true":
        shutil.copyfile(Path(directory) / names(ref)[0], output / latest_names[0])
        (output / latest_names[1]).write_text(f"{result['zipSha256']}  {latest_names[0]}\n")
        manifest = json.loads((Path(directory) / names(ref)[2]).read_text())
        manifest.update(ref="latest", webDist=latest_names[0])
        for key in ("apiImage", "llmgwImage", "llmgwServeImage", "llmgwWebImage"):
            if key in manifest:
                manifest[key] = manifest[key].rsplit(":", 1)[0] + ":latest"
        (output / latest_names[2]).write_text(json.dumps(manifest, indent=2) + "\n")
    else:
        owner, name = repo.split("/")
        base = os.environ.get("PAGES_PRESERVE_BASE_URL", f"https://{owner}.github.io/{name}")
        old = []
        for name in latest_names:
            try:
                old.append(read_url(base.rstrip("/") + "/" + name))
            except ArtifactError as error:
                if "(404)" not in str(error):
                    raise
                old.append(None)
        if any(item is not None for item in old):
            if not all(item is not None for item in old):
                raise ArtifactError("Mutable latest is incomplete; Pages was not published")
            try:
                expected = old[1].decode().split()[0]
                manifest = json.loads(old[2])
                if hashlib.sha256(old[0]).hexdigest() != expected or manifest["webSha256"] != expected or manifest["ref"] != "latest":
                    raise ArtifactError("Mutable latest checksum mismatch; Pages was not published")
            except (ValueError, KeyError, TypeError, IndexError, UnicodeError):
                raise ArtifactError("Mutable latest is malformed; Pages was not published") from None
            for name, data in zip(latest_names, old):
                (output / name).write_bytes(data)
    return result


def legacy_bridge_prefix(contract_commit, contract_sha256, repo):
    """Prefix the existing, unchanged rollback body; do not rewrite old snapshots."""
    if not re.fullmatch(r"[0-9a-f]{40}", contract_commit) or not re.fullmatch(r"[0-9a-f]{64}", contract_sha256):
        raise ArtifactError("Bridge contract must be pinned to Git commit and body SHA256")
    urls(repo, "sha-" + contract_commit)  # validate repository before shell interpolation
    return f'''set -eu
umask 077
: "${{CDS_COMMIT_SHA:?missing immutable historical commit}}"
printf '%s' "$CDS_COMMIT_SHA" | grep -Eq '^[0-9a-f]{{40}}$'
bridge_repo="$(git rev-parse --show-toplevel)"
[ "$(pwd -P)" = "$bridge_repo" ]
git cat-file -e '{contract_commit}^{{commit}}' || git -c gc.auto=0 -c maintenance.auto=false fetch --no-tags origin '{contract_commit}'
bridge_dir="$(mktemp -d)"
trap 'rm -rf "$bridge_dir"' EXIT
git show '{contract_commit}:scripts/lib/release-artifacts.py' > "$bridge_dir/release-artifacts.py"
[ "$(sha256sum "$bridge_dir/release-artifacts.py" | awk '{{print $1}}')" = '{contract_sha256}' ]
python3 "$bridge_dir/release-artifacts.py" fetch --repo {shlex.quote(repo)} --ref "sha-$CDS_COMMIT_SHA" --commit "$CDS_COMMIT_SHA" \\
  --base-url "https://get.miduo.org/https://github.com/{repo}/releases/download/web-sha-$CDS_COMMIT_SHA" \\
  --directory "$bridge_dir/bundle" --env-file "$bridge_dir/inputs.env" > "$bridge_dir/evidence.json"
printf 'Retained artifact bridge: contract={contract_commit} body={contract_sha256}\\n'
cat "$bridge_dir/evidence.json"
. "$bridge_dir/inputs.env"
'''


def publish(repo, ref, directory, resume_id=None, original_sha256=None):
    # Per-ref workflow concurrency serializes writers. Also handle a create race
    # without clobber: a winner must already be complete and validate publicly.
    local = validate(directory, ref)
    if (resume_id is None) != (original_sha256 is None):
        raise ArtifactError("Draft recovery requires both the exact release ID and original workflow ZIP hash")
    if original_sha256 and original_sha256 != local["zipSha256"]:
        raise ArtifactError("Recovery ZIP is not the audited original workflow bundle")
    existing = release(repo, ref)
    if resume_id is not None and (existing is None or not existing.get("draft")):
        raise ArtifactError("Recovery requires the matching existing unpublished draft; no new release was created")
    if existing and not existing.get("draft"):
        with tempfile.TemporaryDirectory() as temporary:
            return {"reused": True, **restore(repo, ref, temporary, local["commit"])}
    if existing:
        # A draft might still belong to another writer. Never take it over.
        if resume_id != existing["id"] or not original_sha256 or original_sha256 != local["zipSha256"]:
            raise ArtifactError("Unpublished draft exists; explicit ID and original workflow ZIP hash required to recover")
        if existing.get("target_commitish") != local["commit"]:
            raise ArtifactError("Draft target commit does not match the original workflow bundle")
    else:
        manifest = json.loads((Path(directory) / names(ref)[2]).read_text())
        try:
            existing = json.loads(gh("api", f"repos/{repo}/releases", "-f", f"tag_name=web-{ref}", "-f", f"target_commitish={manifest['commit']}",
               "-f", f"name=Web bundle {ref}", "-F", "draft=true", "-f", "make_latest=false"))
        except ArtifactError:
            winner = release(repo, ref)
            if winner and not winner.get("draft"):
                with tempfile.TemporaryDirectory() as temporary:
                    return {"reused": True, **restore(repo, ref, temporary, local["commit"])}
            raise
    release_id = existing["id"]
    # Use IDs throughout the draft phase: there may not yet be a Git tag.
    with tempfile.TemporaryDirectory() as temporary:
        assets = {asset["name"]: asset for asset in existing.get("assets", [])}
        if set(assets) - set(names(ref)):
            raise ArtifactError("Draft has unrelated assets; refusing to change it")
        # First verify every existing byte before uploading anything missing.
        for name, asset in assets.items():
            data = gh("api", f"repos/{repo}/releases/assets/{asset['id']}", "-H", "Accept: application/octet-stream")
            if data != (Path(directory) / name).read_bytes():
                raise ArtifactError("Draft assets differ from the original bundle; refusing to overwrite")
            (Path(temporary) / name).write_bytes(data)
        for name in names(ref):
            if name not in assets:
                asset = json.loads(gh("api", f"https://uploads.github.com/repos/{repo}/releases/{release_id}/assets?name={name}",
                                      "--method", "POST", "-H", "Content-Type: application/octet-stream", "--input", str(Path(directory) / name)))
                data = gh("api", f"repos/{repo}/releases/assets/{asset['id']}", "-H", "Accept: application/octet-stream")
                (Path(temporary) / name).write_bytes(data)
        remote = validate(temporary, ref)
        local = validate(directory, ref)
        if remote["files"] != local["files"]:
            raise ArtifactError("Remote draft bytes differ from the original bundle")
    gh("api", f"repos/{repo}/releases/{release_id}", "--method", "PATCH", "-F", "draft=false", "-f", "make_latest=false")
    with tempfile.TemporaryDirectory() as temporary:
        return {"reused": False, **fetch(repo, ref, temporary)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["bundle", "alias", "pages", "validate", "fetch", "restore", "publish"])
    parser.add_argument("--repo", default="inernoro/prd_agent")
    parser.add_argument("--ref", required=True)
    parser.add_argument("--commit")
    parser.add_argument("--directory", required=True)
    parser.add_argument("--dist")
    parser.add_argument("--source-ref")
    parser.add_argument("--base-url")
    parser.add_argument("--github-output")
    parser.add_argument("--env-file", help="For the audited legacy consumer bridge; written only after full validation")
    parser.add_argument("--resume-draft-id", type=int, help="Explicit recovery only, with the original workflow bundle hash")
    parser.add_argument("--original-sha256")
    args = parser.parse_args()
    try:
        if args.env_file and args.command != "fetch":
            raise ArtifactError("Only a validated fetch can export legacy consumer inputs")
        if (args.resume_draft_id or args.original_sha256) and args.command != "publish":
            raise ArtifactError("Draft recovery is only supported by publish")
        if args.command == "bundle":
            result = bundle(args.dist, args.directory, args.repo, args.commit, args.ref)
        elif args.command == "alias":
            result = alias(args.directory, args.source_ref, args.ref)
        elif args.command == "pages":
            result = pages(args.directory, args.ref, args.dist, args.repo)
        elif args.command == "validate":
            result = validate(args.directory, args.ref, args.commit)
        elif args.command == "fetch":
            result = fetch(args.repo, args.ref, args.directory, args.base_url, args.commit)
        elif args.command == "restore":
            result = restore(args.repo, args.ref, args.directory, args.commit)
        else:
            result = publish(args.repo, args.ref, args.directory, args.resume_draft_id, args.original_sha256)
        if args.github_output:
            with open(args.github_output, "a") as output:
                output.write("exists=" + str(result.get("exists", False)).lower() + "\n")
        if args.env_file:
            values = dict(DIST_URL=result["urls"][0], DIST_SHA256_URL=result["urls"][1],
                          DIST_MANIFEST_URL=result["urls"][2], DIST_SHA256=result["zipSha256"])
            Path(args.env_file).write_text("\n".join("export " + key + "=" + shlex.quote(value) for key, value in values.items()) + "\n")
        print(json.dumps(result))
    except ArtifactError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
