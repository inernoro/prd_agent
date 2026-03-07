#!/usr/bin/env python3
"""
NuGet Proxy Relay for Claude Code Web Sandbox.

Workaround for dotnet/runtime#114066: .NET HttpClient on Linux fails to send
Proxy-Authorization header when credentials are embedded in the proxy URL.

This script starts a local HTTP proxy that:
1. Reads the upstream proxy URL from HTTPS_PROXY env var
2. Extracts the JWT credentials
3. Forwards CONNECT requests with proper Proxy-Authorization header
4. Allows dotnet restore to work through the sandbox proxy

Usage:
    python3 scripts/nuget-proxy-relay.py &
    RELAY_PID=$!
    env HTTPS_PROXY=http://127.0.0.1:18080 HTTP_PROXY=http://127.0.0.1:18080 dotnet restore
    kill $RELAY_PID
"""

import base64
import os
import re
import select
import socket
import sys
import threading
from urllib.parse import urlparse

LOCAL_PORT = int(os.environ.get("NUGET_RELAY_PORT", "18080"))
UPSTREAM_PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or ""

def parse_proxy_url(proxy_url: str):
    """Extract host, port, user, password from proxy URL."""
    parsed = urlparse(proxy_url)
    return {
        "host": parsed.hostname or "",
        "port": parsed.port or 15004,
        "user": parsed.username or "",
        "pass": parsed.password or "",
    }

def make_auth_header(user: str, password: str) -> str:
    """Create Proxy-Authorization Basic header value."""
    creds = f"{user}:{password}"
    b64 = base64.b64encode(creds.encode()).decode()
    return f"Basic {b64}"

def relay_data(src: socket.socket, dst: socket.socket):
    """Relay data between two sockets."""
    try:
        while True:
            ready, _, _ = select.select([src], [], [], 30)
            if not ready:
                break
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except (OSError, ConnectionError):
        pass

def handle_client(client_sock: socket.socket, proxy_info: dict, auth_header: str):
    """Handle a single client connection."""
    try:
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = client_sock.recv(4096)
            if not chunk:
                return
            request += chunk

        header_end = request.index(b"\r\n\r\n")
        header_block = request[:header_end].decode("utf-8", errors="replace")
        body_rest = request[header_end + 4:]

        lines = header_block.split("\r\n")
        first_line = lines[0]

        # Inject Proxy-Authorization header
        new_lines = [first_line]
        auth_exists = False
        for line in lines[1:]:
            if line.lower().startswith("proxy-authorization:"):
                auth_exists = True
                new_lines.append(f"Proxy-Authorization: {auth_header}")
            else:
                new_lines.append(line)
        if not auth_exists:
            new_lines.insert(1, f"Proxy-Authorization: {auth_header}")

        new_request = ("\r\n".join(new_lines) + "\r\n\r\n").encode() + body_rest

        # Connect to upstream proxy
        upstream = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        upstream.settimeout(30)
        upstream.connect((proxy_info["host"], proxy_info["port"]))
        upstream.sendall(new_request)

        if first_line.upper().startswith("CONNECT"):
            # HTTPS tunnel: read proxy response, forward to client, then relay
            response = b""
            while b"\r\n\r\n" not in response:
                chunk = upstream.recv(4096)
                if not chunk:
                    break
                response += chunk
            client_sock.sendall(response)

            if b"200" in response.split(b"\r\n")[0]:
                t1 = threading.Thread(target=relay_data, args=(client_sock, upstream), daemon=True)
                t2 = threading.Thread(target=relay_data, args=(upstream, client_sock), daemon=True)
                t1.start()
                t2.start()
                t1.join(timeout=120)
                t2.join(timeout=120)
        else:
            # HTTP: relay response back
            while True:
                ready, _, _ = select.select([upstream], [], [], 30)
                if not ready:
                    break
                data = upstream.recv(65536)
                if not data:
                    break
                client_sock.sendall(data)

        upstream.close()
    except Exception as e:
        err_msg = f"HTTP/1.1 502 Proxy Relay Error\r\nContent-Length: {len(str(e))}\r\n\r\n{e}"
        try:
            client_sock.sendall(err_msg.encode())
        except OSError:
            pass
    finally:
        try:
            client_sock.close()
        except OSError:
            pass

def main():
    if not UPSTREAM_PROXY:
        print("[nuget-relay] No HTTPS_PROXY set, not in Web sandbox. Exiting.")
        sys.exit(0)

    proxy_info = parse_proxy_url(UPSTREAM_PROXY)
    if not proxy_info["user"]:
        print("[nuget-relay] No proxy credentials found. Exiting.")
        sys.exit(0)

    auth_header = make_auth_header(proxy_info["user"], proxy_info["pass"])

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", LOCAL_PORT))
    server.listen(32)

    # Mask credentials in log output
    masked_proxy = re.sub(r'://[^@]+@', '://***@', UPSTREAM_PROXY)
    print(f"[nuget-relay] Listening on 127.0.0.1:{LOCAL_PORT}")
    print(f"[nuget-relay] Upstream proxy: {masked_proxy}")
    print(f"[nuget-relay] Ready. Use: HTTPS_PROXY=http://127.0.0.1:{LOCAL_PORT} dotnet restore")
    sys.stdout.flush()

    try:
        while True:
            client_sock, addr = server.accept()
            t = threading.Thread(target=handle_client, args=(client_sock, proxy_info, auth_header), daemon=True)
            t.start()
    except KeyboardInterrupt:
        print("\n[nuget-relay] Shutting down.")
    finally:
        server.close()

if __name__ == "__main__":
    main()
