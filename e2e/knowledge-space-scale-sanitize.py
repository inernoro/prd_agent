"""Redact authentication from local Playwright evidence before sharing it."""
import argparse
import json
import re
import zipfile
from pathlib import Path, PurePosixPath


SECRET_FIELDS = {
    "authorization", "cookie", "set-cookie", "x-session-key", "x-api-key",
    "x-ai-access-key", "x-ai-impersonate", "password", "accesstoken",
    "refreshtoken", "sessionkey", "access_token", "refresh_token", "apikey",
}


def redact(value):
    if isinstance(value, list):
        return [redact(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {}
    header_secret = str(value.get("name", "")).lower() in SECRET_FIELDS
    for key, item in value.items():
        if key.lower() in SECRET_FIELDS or (key == "value" and header_secret):
            result[key] = "[REDACTED]"
        elif key == "cookies":
            result[key] = []
        elif key == "postData" and isinstance(item, dict):
            post = redact(item)
            try:
                post["text"] = json.dumps(redact(json.loads(item["text"])), ensure_ascii=False)
            except (KeyError, TypeError, ValueError):
                pass
            result[key] = post
        else:
            result[key] = redact(item)
    return result


def sanitize(source: Path, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as output:
        for entry in original.infolist():
            if PurePosixPath(entry.filename).is_absolute() or ".." in PurePosixPath(entry.filename).parts:
                raise ValueError("Unsafe archive path")
            data = original.read(entry.filename)
            if entry.filename.endswith((".trace", ".network")):
                data = ("\n".join(json.dumps(redact(json.loads(line)), ensure_ascii=False)
                                  for line in data.decode().splitlines() if line) + "\n").encode()
            elif entry.filename.endswith(".json"):
                data = json.dumps(redact(json.loads(data)), ensure_ascii=False).encode()
            if re.search(rb"Bearer\s+eyJ[A-Za-z0-9_-]{10,}", data):
                raise ValueError("Authentication remained in trace")
            output.writestr(entry.filename, data)
    temporary.replace(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    sanitize(args.source, args.destination)
