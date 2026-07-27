#!/usr/bin/env python3

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class LiveAsrWebSocketProxyTests(unittest.TestCase):
    def test_production_nginx_routes_forward_websocket_upgrade(self) -> None:
        for relative in (
            "deploy/nginx/nginx.conf",
            "deploy/nginx/conf.d/branches/_standalone.conf",
        ):
            source = (ROOT / relative).read_text(encoding="utf-8")
            api_block = source.split("location ^~ /api/ {", maxsplit=1)[1].split("}", maxsplit=1)[0]
            gateway_block = source.split("location ^~ /gw/v1/ {", maxsplit=1)[1].split("}", maxsplit=1)[0]
            for block in (api_block, gateway_block):
                self.assertIn("proxy_http_version 1.1;", block)
                self.assertIn("proxy_set_header Upgrade $http_upgrade;", block)
                self.assertIn("proxy_set_header Connection $map_connection_upgrade;", block)

    def test_cds_dispatcher_keeps_websocket_upgrade(self) -> None:
        source = (ROOT / "cds/src/scheduler/nginx-template.ts").read_text(encoding="utf-8")
        self.assertIn("proxy_http_version 1.1;", source)
        self.assertIn("proxy_set_header Upgrade $http_upgrade;", source)
        self.assertIn("proxy_set_header Connection $cds_connection_upgrade;", source)


if __name__ == "__main__":
    unittest.main()
