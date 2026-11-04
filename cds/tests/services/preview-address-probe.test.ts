import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probePreviewAddress } from "../../src/services/preview-address-settings.js";
const good = { "content-type": "text/html", "x-cds-branch": "foo-main" };
afterEach(() => vi.unstubAllGlobals());
describe("公开入口验证必须证明页面归属及资源", () => {
  it("实际读取 HTML 引用的同源 JS/CSS，不把外站统计脚本当作应用资产", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/app.js"))
        return new Response("export const value=1", {
          headers: { ...good, "content-type": "application/javascript" },
        });
      if (url.endsWith("/style.css"))
        return new Response("body{}", {
          headers: { ...good, "content-type": "text/css" },
        });
      return new Response(
        '<html><script src="/app.js"></script><link rel="stylesheet" href="/style.css"><script src="https://analytics.test/t.js"></script></html>',
        { headers: good },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await probePreviewAddress(
      "https://preview.test/",
      "foo-main",
    );
    expect(result).toMatchObject({ ok: true, assets: 2 });
    expect(fetcher.mock.calls.map((args) => args[0])).toEqual([
      "https://preview.test/",
      "https://preview.test/app.js",
      "https://preview.test/style.css",
    ]);
  });
  it("返回 200 但归属其他分支仍失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>other</html>", {
            headers: { ...good, "x-cds-branch": "bar-main" },
          }),
      ),
    );
    expect(
      (await probePreviewAddress("https://preview.test/", "foo-main")).ok,
    ).toBe(false);
  });
  it("入口 JS 返回 HTML 而非脚本时失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            url.endsWith("/app.js")
              ? "<html>fallback</html>"
              : '<html><script src="/app.js"></script></html>',
            { headers: good },
          ),
      ),
    );
    expect(
      (await probePreviewAddress("https://preview.test/", "foo-main")).ok,
    ).toBe(false);
  });
  it("外站重定向不跟随，也不发送用户 cookie", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/secrets" },
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(
      (await probePreviewAddress("https://preview.test/", "foo-main")).ok,
    ).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls as any)[0][1].headers.Cookie).toBeUndefined();
  });
  it("部署失败页不被当成有效应用页面", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>CDS Preview Failed</html>", { headers: good }),
      ),
    );
    expect(
      (await probePreviewAddress("https://preview.test/", "foo-main")).ok,
    ).toBe(false);
  });
  it("直连 HTTP 服务器跟随同源首页跳转并验证实际脚本响应", async () => {
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url!);
      res.setHeader("x-cds-branch", "foo-main");
      if (req.url === "/") {
        res.writeHead(302, { location: "/app/" });
        res.end();
        return;
      }
      if (req.url === "/app/main.js") {
        res.setHeader("content-type", "application/javascript");
        res.end("console.log('app')");
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end('<html><script src="./main.js"></script></html>');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const result = await probePreviewAddress(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
        "foo-main",
      );
      expect(result).toMatchObject({ ok: true, assets: 1 });
      expect(paths).toEqual(["/", "/app/", "/app/main.js"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
