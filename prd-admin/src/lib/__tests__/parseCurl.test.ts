import { describe, it, expect } from 'vitest';
import { parseCurl, toCurl, headersToJson, prettyBody } from '../../pages/workflow-agent/parseCurl';

// ═══════════════════════════════════════════════════════════════
// 真实 TAPD cURL 样本 — Chrome "Copy as cURL (bash)"
// ═══════════════════════════════════════════════════════════════

const TAPD_BASH_CURL = `curl 'https://www.tapd.cn/api/new_filter/new_filter/get_options_batch?needRepeatInterceptors=false' \\
  -H 'Accept: application/json, text/plain, */*' \\
  -H 'Accept-Language: zh-CN,zh;q=0.9' \\
  -H 'Connection: keep-alive' \\
  -H 'Content-Type: application/json' \\
  -b 'tapdsession=1771001501938cdb045aef7b1bae5f40ce819a4a2760c3ed8383563d5276a454a663118f19; app_locale_name=zh_CN; __root_domain_v=.tapd.cn; _qddaz=QD.967571001502426; _qddab=3-d7u8hj.mll4kgyw; t_u=db4298681f9162150277db6b08c425b93716bb92f648526042cd63750c1903ebd4f89ca04433b44964cf823f78c189fd0f4455af659cb4e71998645417b8c2e1339902f609573c8e%7C1; t_cloud_login=13681555395; locale=zh_CN; _t_uid=1608404181; _t_crop=20364341; new_worktable=my_dashboard%7C%7C%7C; dsc-token=SY6W5KYnDT0jpuNH; tapd_div=101_9; cloud_current_workspaceId=66590626; _wt=eyJ1aWQiOiIxNjA4NDA0MTgxIiwiY29tcGFueV9pZCI6IjIwMzY0MzQxIiwiZXhwIjoxNzcxMDA0MTEzfQ%3D%3D.cf8e9c0a9ae6b2fc8e01bb81c2a3d20cff3c449deedc78bb4204033704c9a5b5; t_i_token=MTYwODQwNDE4MSwxNzcxMTMzNDEz.4f04774c91bd129fe730077fada696994709cd45ceaa9894f5e3da6ce71bc399' \\
  -H 'DNT: 1' \\
  -H 'Origin: https://www.tapd.cn' \\
  -H 'Referer: https://www.tapd.cn/tapd_fe/66590626/bug/list?confId=1166590626001043504' \\
  -H 'Sec-Fetch-Dest: empty' \\
  -H 'Sec-Fetch-Mode: cors' \\
  -H 'Sec-Fetch-Site: same-origin' \\
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' \\
  -H 'sec-ch-ua: "Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: "Windows"' \\
  --data-raw '{"workspace_ids":["66590626"],"fields":[{"field":"status","entity_type":"bug","is_system":"1","html_type":"select","menu_workitem_type_id":""},{"field":"priority","entity_type":"bug","is_system":"1","html_type":"select","menu_workitem_type_id":""}],"use_scene":"bug_list","app_id":"1","filter_status":"","include_in_process":false,"dsc_token":"SY6W5KYnDT0jpuNH"}'`;

// ═══════════════════════════════════════════════════════════════
// 真实 TAPD cURL 样本 — Chrome "Copy as cURL (cmd)"
// ═══════════════════════════════════════════════════════════════

const TAPD_CMD_CURL = `curl ^"https://www.tapd.cn/api/basic/onboarding/can_show_recommend_template_user_task_guide?workspace_id=66590626^" ^
  -H ^"Accept: application/json, text/plain, */*^" ^
  -H ^"Accept-Language: zh-CN,zh;q=0.9^" ^
  -H ^"Connection: keep-alive^" ^
  -b ^"tapdsession=1771001501938cdb045aef7b1bae5f40ce819a4a2760c3ed8383563d5276a454a663118f19; app_locale_name=zh_CN; __root_domain_v=.tapd.cn; _qddaz=QD.967571001502426; _qddab=3-d7u8hj.mll4kgyw; t_u=db4298681f9162150277db6b08c425b93716bb92f648526042cd63750c1903ebd4f89ca04433b44964cf823f78c189fd0f4455af659cb4e71998645417b8c2e1339902f609573c8e^%^7C1; t_cloud_login=13681555395; locale=zh_CN; _t_uid=1608404181; _t_crop=20364341; new_worktable=my_dashboard^%^7C^%^7C^%^7C; dsc-token=SY6W5KYnDT0jpuNH; tapd_div=101_9; cloud_current_workspaceId=66590626; t_i_token=MTYwODQwNDE4MSwxNzcxMTMxNzIy.04c1e84ab2a5afe4c09a7d7bc413b412713736eb80c7baf33008ac27b8f70a88^" ^
  -H ^"DNT: 1^" ^
  -H ^"Referer: https://www.tapd.cn/tapd_fe/66590626/bug/list?confId=1166590626001043504^" ^
  -H ^"Sec-Fetch-Dest: empty^" ^
  -H ^"Sec-Fetch-Mode: cors^" ^
  -H ^"Sec-Fetch-Site: same-origin^" ^
  -H ^"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36^" ^
  -H ^"sec-ch-ua: ^\\^"Not(A:Brand^\\^";v=^\\^"8^\\^", ^\\^"Chromium^\\^";v=^\\^"144^\\^", ^\\^"Google Chrome^\\^";v=^\\^"144^\\^"^" ^
  -H ^"sec-ch-ua-mobile: ?0^" ^
  -H ^"sec-ch-ua-platform: ^\\^"Windows^\\^"^"`;

// ═══════════════════════════════════════════════════════════════
// 测试：Chrome bash 格式
// ═══════════════════════════════════════════════════════════════

describe('parseCurl — Chrome bash 格式 (TAPD)', () => {
  const result = parseCurl(TAPD_BASH_CURL);

  it('应成功解析', () => {
    expect(result).not.toBeNull();
  });

  it('URL 正确', () => {
    expect(result!.url).toBe(
      'https://www.tapd.cn/api/new_filter/new_filter/get_options_batch?needRepeatInterceptors=false'
    );
  });

  it('Method 为 POST（因为有 --data-raw）', () => {
    expect(result!.method).toBe('POST');
  });

  it('解析全部 header（不过滤浏览器 header）', () => {
    expect(result!.headers['Accept']).toBe('application/json, text/plain, */*');
    expect(result!.headers['Accept-Language']).toBe('zh-CN,zh;q=0.9');
    expect(result!.headers['Connection']).toBe('keep-alive');
    expect(result!.headers['Content-Type']).toBe('application/json');
    expect(result!.headers['DNT']).toBe('1');
    expect(result!.headers['Origin']).toBe('https://www.tapd.cn');
    expect(result!.headers['Referer']).toBe(
      'https://www.tapd.cn/tapd_fe/66590626/bug/list?confId=1166590626001043504'
    );
    expect(result!.headers['Sec-Fetch-Dest']).toBe('empty');
    expect(result!.headers['Sec-Fetch-Mode']).toBe('cors');
    expect(result!.headers['Sec-Fetch-Site']).toBe('same-origin');
    expect(result!.headers['User-Agent']).toContain('Chrome/144');
    expect(result!.headers['sec-ch-ua']).toContain('Chromium');
    expect(result!.headers['sec-ch-ua-mobile']).toBe('?0');
    expect(result!.headers['sec-ch-ua-platform']).toBe('"Windows"');
  });

  it('-b Cookie 作为 Cookie header 保留', () => {
    expect(result!.headers['Cookie']).toBeDefined();
    expect(result!.headers['Cookie']).toContain('tapdsession=');
    expect(result!.headers['Cookie']).toContain('cloud_current_workspaceId=66590626');
    expect(result!.headers['Cookie']).toContain('%7C'); // URL-encoded |
  });

  it('body 为完整 JSON', () => {
    const body = JSON.parse(result!.body);
    expect(body.workspace_ids).toEqual(['66590626']);
    expect(body.fields).toHaveLength(2);
    expect(body.fields[0].field).toBe('status');
    expect(body.use_scene).toBe('bug_list');
    expect(body.app_id).toBe('1');
    expect(body.dsc_token).toBe('SY6W5KYnDT0jpuNH');
  });

  it('header 总数正确（14 个 -H + 1 个 -b Cookie = 15）', () => {
    // 14 个 -H header + 1 个 -b → Cookie = 15
    expect(Object.keys(result!.headers).length).toBe(15);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：Chrome CMD 格式 (Windows)
// ═══════════════════════════════════════════════════════════════

describe('parseCurl — Chrome CMD 格式 (TAPD Windows)', () => {
  const result = parseCurl(TAPD_CMD_CURL);

  it('应成功解析', () => {
    expect(result).not.toBeNull();
  });

  it('URL 正确（^" 被还原为 "，然后分词去引号）', () => {
    expect(result!.url).toBe(
      'https://www.tapd.cn/api/basic/onboarding/can_show_recommend_template_user_task_guide?workspace_id=66590626'
    );
  });

  it('Method 为 GET（无 body）', () => {
    expect(result!.method).toBe('GET');
  });

  it('解析全部 header', () => {
    expect(result!.headers['Accept']).toBe('application/json, text/plain, */*');
    expect(result!.headers['Accept-Language']).toBe('zh-CN,zh;q=0.9');
    expect(result!.headers['Connection']).toBe('keep-alive');
    expect(result!.headers['DNT']).toBe('1');
    expect(result!.headers['Referer']).toContain('tapd_fe/66590626/bug/list');
    expect(result!.headers['Sec-Fetch-Dest']).toBe('empty');
    expect(result!.headers['User-Agent']).toContain('Chrome/144');
    expect(result!.headers['sec-ch-ua-mobile']).toBe('?0');
  });

  it('-b Cookie 从 ^"...^" 正确解析，^%^7C 还原为 %7C', () => {
    expect(result!.headers['Cookie']).toBeDefined();
    expect(result!.headers['Cookie']).toContain('tapdsession=');
    expect(result!.headers['Cookie']).toContain('%7C'); // ^%^7C → %7C
    expect(result!.headers['Cookie']).not.toContain('^'); // 不应有残留 ^
  });

  it('sec-ch-ua 中的转义引号 ^\\^" 正确还原', () => {
    // ^\\^" → \" → 分词后还原为 "
    expect(result!.headers['sec-ch-ua']).toContain('Not(A:Brand');
    expect(result!.headers['sec-ch-ua']).toContain('Chromium');
    expect(result!.headers['sec-ch-ua']).toContain('Google Chrome');
  });

  it('sec-ch-ua-platform 中的转义引号正确', () => {
    expect(result!.headers['sec-ch-ua-platform']).toContain('Windows');
  });

  it('body 为空', () => {
    expect(result!.body).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// 用户反馈的 GET cURL（无 body，纯 header + cookie）
// ═══════════════════════════════════════════════════════════════

const USER_GET_CURL = `curl 'https://www.tapd.cn/api/basic/onboarding/can_show_recommend_template_user_task_guide?workspace_id=66590626' \\
  -H 'Accept: application/json, text/plain, */*' \\
  -H 'Accept-Language: zh-CN,zh;q=0.9' \\
  -H 'Connection: keep-alive' \\
  -b 'tapdsession=abc123; app_locale_name=zh_CN; __root_domain_v=.tapd.cn' \\
  -H 'DNT: 1' \\
  -H 'Referer: https://www.tapd.cn/tapd_fe/66590626/bug/list?confId=1166590626001043504' \\
  -H 'Sec-Fetch-Dest: empty' \\
  -H 'Sec-Fetch-Mode: cors' \\
  -H 'Sec-Fetch-Site: same-origin' \\
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' \\
  -H 'sec-ch-ua: "Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: "Windows"'`;

describe('parseCurl — 用户 GET cURL（header+cookie，无 body）', () => {
  const result = parseCurl(USER_GET_CURL);

  it('解析不为 null', () => {
    expect(result).not.toBeNull();
  });

  it('URL 正确', () => {
    expect(result!.url).toBe('https://www.tapd.cn/api/basic/onboarding/can_show_recommend_template_user_task_guide?workspace_id=66590626');
  });

  it('方法为 GET', () => {
    expect(result!.method).toBe('GET');
  });

  it('Cookie 被识别', () => {
    expect(result!.headers['Cookie']).toContain('tapdsession=abc123');
    expect(result!.headers['Cookie']).toContain('app_locale_name=zh_CN');
  });

  it('共 13 个 header（12 -H + 1 -b Cookie）', () => {
    expect(Object.keys(result!.headers).length).toBe(13);
  });

  it('body 为空', () => {
    expect(result!.body).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：简单格式
// ═══════════════════════════════════════════════════════════════

describe('parseCurl — 基础格式', () => {
  it('最简 GET', () => {
    const r = parseCurl("curl 'https://api.example.com/data'");
    expect(r).not.toBeNull();
    expect(r!.url).toBe('https://api.example.com/data');
    expect(r!.method).toBe('GET');
  });

  it('无引号 URL', () => {
    const r = parseCurl('curl https://api.example.com/data');
    expect(r).not.toBeNull();
    expect(r!.url).toBe('https://api.example.com/data');
  });

  it('双引号 URL', () => {
    const r = parseCurl('curl "https://api.example.com/data"');
    expect(r).not.toBeNull();
    expect(r!.url).toBe('https://api.example.com/data');
  });

  it('bash 续行反斜杠后有尾随空格', () => {
    // 有些编辑器/粘贴板会在 \ 后面添加空格
    const r = parseCurl("curl 'https://api.example.com/data' \\   \n  -H 'Accept: text/html' \\  \n  -H 'X-Token: abc'");
    expect(r).not.toBeNull();
    expect(r!.url).toBe('https://api.example.com/data');
    expect(r!.headers['Accept']).toBe('text/html');
    expect(r!.headers['X-Token']).toBe('abc');
  });

  it('显式 -X POST', () => {
    const r = parseCurl("curl -X POST 'https://api.example.com/data'");
    expect(r!.method).toBe('POST');
    expect(r!.url).toBe('https://api.example.com/data');
  });

  it('--request PUT', () => {
    const r = parseCurl("curl --request PUT 'https://api.example.com/data'");
    expect(r!.method).toBe('PUT');
  });

  it('-d 隐式 POST', () => {
    const r = parseCurl("curl 'https://api.example.com' -d '{\"key\":\"val\"}'");
    expect(r!.method).toBe('POST');
    expect(r!.body).toBe('{"key":"val"}');
  });

  it('多个 -H header', () => {
    const r = parseCurl(`curl 'https://x.com' -H 'A: 1' -H 'B: 2' -H 'C: 3'`);
    expect(r!.headers['A']).toBe('1');
    expect(r!.headers['B']).toBe('2');
    expect(r!.headers['C']).toBe('3');
  });

  it('-u Basic Auth', () => {
    const r = parseCurl("curl -u 'user:pass' 'https://api.example.com'");
    expect(r!.headers['Authorization']).toBe(`Basic ${btoa('user:pass')}`);
  });

  it('--url 显式指定', () => {
    const r = parseCurl("curl --url 'https://api.example.com/data' -H 'X: 1'");
    expect(r!.url).toBe('https://api.example.com/data');
  });

  it('空字符串返回 null', () => {
    expect(parseCurl('')).toBeNull();
    expect(parseCurl('  ')).toBeNull();
  });

  it('非 curl 命令返回 null', () => {
    expect(parseCurl('wget https://example.com')).toBeNull();
  });

  it('curl.exe (Windows) 识别', () => {
    const r = parseCurl('curl.exe "https://api.example.com/data"');
    expect(r).not.toBeNull();
    expect(r!.url).toBe('https://api.example.com/data');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：flag 值不误认为 URL
// ═══════════════════════════════════════════════════════════════

describe('parseCurl — flag 值不误认为 URL', () => {
  it('-b cookie 值不当 URL', () => {
    const r = parseCurl("curl -b 'session=abc' 'https://api.example.com'");
    expect(r!.url).toBe('https://api.example.com');
    expect(r!.headers['Cookie']).toBe('session=abc');
  });

  it('-A user-agent 值不当 URL', () => {
    const r = parseCurl("curl -A 'Mozilla/5.0' 'https://api.example.com'");
    expect(r!.url).toBe('https://api.example.com');
  });

  it('-o output 值不当 URL', () => {
    const r = parseCurl("curl -o output.json 'https://api.example.com'");
    expect(r!.url).toBe('https://api.example.com');
  });

  it('--cookie-jar 值不当 URL', () => {
    const r = parseCurl("curl --cookie-jar cookies.txt 'https://api.example.com'");
    expect(r!.url).toBe('https://api.example.com');
  });

  it('多个 flag 后仍能找到 URL', () => {
    const r = parseCurl(
      "curl --compressed -b 'sid=x' -A 'Bot' -e 'https://ref.com' 'https://api.example.com/data'"
    );
    expect(r!.url).toBe('https://api.example.com/data');
    expect(r!.headers['Cookie']).toBe('sid=x');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：$'...' ANSI-C 引号
// ═══════════════════════════════════════════════════════════════

describe('parseCurl — ANSI-C 引号', () => {
  it("$'...' 中的 \\n 转义", () => {
    const r = parseCurl("curl 'https://x.com' -d $'line1\\nline2'");
    expect(r!.body).toBe('line1\nline2');
  });

  it("$'...' 中的 \\t 转义", () => {
    const r = parseCurl("curl 'https://x.com' -d $'col1\\tcol2'");
    expect(r!.body).toBe('col1\tcol2');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：toCurl 导出
// ═══════════════════════════════════════════════════════════════

describe('toCurl — 导出 cURL', () => {
  it('简单 GET', () => {
    const cmd = toCurl({ url: 'https://api.example.com/data' });
    expect(cmd).toContain("curl");
    expect(cmd).toContain('https://api.example.com/data');
    expect(cmd).not.toContain('-X');
  });

  it('POST 带 body 不显式写 -X POST', () => {
    const cmd = toCurl({
      url: 'https://api.example.com',
      method: 'POST',
      body: '{"key":"val"}',
    });
    expect(cmd).not.toContain('-X');
    expect(cmd).toContain('--data-raw');
    expect(cmd).toContain('{"key":"val"}');
  });

  it('PUT 显式写 -X PUT', () => {
    const cmd = toCurl({
      url: 'https://api.example.com',
      method: 'PUT',
      body: '{}',
    });
    expect(cmd).toContain('-X PUT');
  });

  it('headers 作为 -H 输出', () => {
    const cmd = toCurl({
      url: 'https://api.example.com',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer tok' },
    });
    expect(cmd).toContain("-H 'Content-Type: application/json'");
    expect(cmd).toContain("-H 'Authorization: Bearer tok'");
  });

  it('headers 接受 JSON 字符串', () => {
    const cmd = toCurl({
      url: 'https://x.com',
      headers: '{"X-Custom": "val"}',
    });
    expect(cmd).toContain("-H 'X-Custom: val'");
  });

  it('单引号 URL 中不含单引号时用单引号包裹', () => {
    const cmd = toCurl({ url: 'https://api.example.com/data?a=1&b=2' });
    expect(cmd).toContain("'https://api.example.com/data?a=1&b=2'");
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：解析 → 导出 → 重新解析 往返一致性
// ═══════════════════════════════════════════════════════════════

describe('parseCurl ↔ toCurl 往返一致', () => {
  it('bash 格式解析后导出再解析，URL/method/body 一致', () => {
    const parsed1 = parseCurl(TAPD_BASH_CURL)!;
    const exported = toCurl({
      url: parsed1.url,
      method: parsed1.method,
      headers: parsed1.headers,
      body: parsed1.body,
    });
    const parsed2 = parseCurl(exported)!;
    expect(parsed2.url).toBe(parsed1.url);
    expect(parsed2.method).toBe(parsed1.method);
    expect(parsed2.body).toBe(parsed1.body);
    // header 数量一致
    expect(Object.keys(parsed2.headers).length).toBe(Object.keys(parsed1.headers).length);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：headersToJson / prettyBody
// ═══════════════════════════════════════════════════════════════

describe('headersToJson', () => {
  it('空 headers → 空字符串', () => {
    expect(headersToJson({})).toBe('');
  });

  it('全量保留（不过滤浏览器 header）', () => {
    const json = headersToJson({
      'Accept': 'text/html',
      'User-Agent': 'Mozilla/5.0',
      'sec-ch-ua': '"Chrome"',
    });
    const parsed = JSON.parse(json);
    expect(parsed['Accept']).toBe('text/html');
    expect(parsed['User-Agent']).toBe('Mozilla/5.0');
    expect(parsed['sec-ch-ua']).toBe('"Chrome"');
  });
});

describe('prettyBody', () => {
  it('合法 JSON 美化', () => {
    const pretty = prettyBody('{"a":1,"b":"c"}');
    expect(pretty).toContain('"a": 1');
    expect(pretty).toContain('"b": "c"');
  });

  it('非 JSON 原样返回', () => {
    expect(prettyBody('hello world')).toBe('hello world');
  });

  it('空字符串返回空', () => {
    expect(prettyBody('')).toBe('');
  });
});
