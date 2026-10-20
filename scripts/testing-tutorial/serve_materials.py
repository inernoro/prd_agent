#!/usr/bin/env python3
"""Serve this materials directory on localhost with MP4 byte-range support.

The Agent starts this helper; viewers use the printed review/textbook links.
The server never binds a public interface or serves files outside this directory.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent


class MaterialsHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if getattr(self, '_range_capable', False):
            self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def send_head(self):
        self._remaining = None
        self._range_capable = False
        candidate = Path(self.translate_path(self.path)).resolve()
        if not candidate.is_relative_to(ROOT):
            self.send_error(403, 'Outside materials directory')
            return None
        # SimpleHTTPRequestHandler may select an index file for a directory.
        # Validate that destination too, including a symlinked index file.
        if candidate.is_dir():
            for name in ('index.html', 'index.htm'):
                index = candidate / name
                if index.is_file() and not index.resolve().is_relative_to(ROOT):
                    self.send_error(403, 'Outside materials directory')
                    return None
            return super().send_head()
        if not candidate.is_file():
            return super().send_head()
        self._range_capable = True
        value = self.headers.get('Range')
        if not value:
            return super().send_head()
        stat = candidate.stat()
        # We emit Last-Modified, not ETag. A different If-Range validator asks
        # for a full response, as required when a cached representation differs.
        if_range = self.headers.get('If-Range')
        if if_range and if_range != self.date_time_string(stat.st_mtime):
            return super().send_head()
        size = stat.st_size
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', value.strip())
        try:
            if match is None or not any(match.groups()):
                raise ValueError('Unsupported range')
            first, last = match.groups()
            if not first:
                suffix = int(last)
                if suffix <= 0:
                    raise ValueError('Empty suffix')
                start, end = max(0, size - suffix), size - 1
            else:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            if not size or start >= size or end < start:
                raise ValueError('Range outside file')
        except ValueError:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        try:
            stream = candidate.open('rb')
        except OSError:
            self.send_error(404, 'File not found')
            return None
        stream.seek(start)
        self._remaining = end - start + 1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(str(candidate)))
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(self._remaining))
        self.send_header('Last-Modified', self.date_time_string(stat.st_mtime))
        self.end_headers()
        return stream

    def copyfile(self, source, outputfile):
        try:
            if self._remaining is None:
                return super().copyfile(source, outputfile)
            while self._remaining:
                data = source.read(min(65536, self._remaining))
                if not data:
                    break
                outputfile.write(data)
                self._remaining -= len(data)
        except (BrokenPipeError, ConnectionResetError):
            # Switching segments normally cancels a previous media request.
            return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8769)
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('port must be between 0 and 65535')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(MaterialsHandler, directory=str(ROOT)))
    origin = f'http://127.0.0.1:{server.server_port}'
    print(f'审阅入口：{origin}/review/index.html\n配套教材：{origin}/textbook/index.html', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
