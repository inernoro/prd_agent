/*
 * agent-key-modal.js — project-scoped Agent Key signing + management modal.
 *
 * Exposes two globals:
 *   window.cdsOpenAgentKeyModal(projectId)    — sign a new key, show once
 *   window.cdsOpenAgentKeyManager(projectId)  — list + revoke existing keys
 *
 * No framework. Pure IIFE. Appended to document.body via createPortal-style
 * append, ESC / backdrop close. See .claude/rules/frontend-modal.md for the
 * 3 hard constraints this follows.
 */
(function () {
  'use strict';

  var ZI = 10000; // z-index: above every other CDS modal

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        if (k === 'style' && typeof attrs[k] === 'object') {
          for (var sk in attrs[k]) el.style[sk] = attrs[k][sk];
        } else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        } else if (attrs[k] !== undefined && attrs[k] !== null) {
          el.setAttribute(k, attrs[k]);
        }
      }
    }
    (children || []).forEach(function (c) {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function closeModal(root) {
    if (!root) return;
    if (root._escHandler) document.removeEventListener('keydown', root._escHandler);
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  function renderShell(title, bodyEl, subtitle) {
    var backdrop = h('div', {
      style: {
        position: 'fixed', inset: '0', background: 'rgba(3,7,18,0.55)',
        backdropFilter: 'blur(4px)', zIndex: String(ZI),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      },
    }, []);
    var dialog = h('div', {
      style: {
        background: 'var(--bg-card, #14141a)',
        border: '1px solid var(--card-border, #2a2a33)',
        borderRadius: '10px',
        boxShadow: '0 24px 60px rgba(0,0,0,0.55)',
        color: 'var(--text-primary, #e8e8ec)',
        width: 'min(560px, calc(100vw - 32px))',
        maxHeight: '82vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      },
    }, [
      h('div', {
        style: {
          flexShrink: '0', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', padding: '14px 18px',
          borderBottom: '1px solid var(--card-border, #2a2a33)',
        },
      }, [
        h('div', null, [
          h('div', { style: { fontSize: '14px', fontWeight: '700' } }, [title]),
          subtitle
            ? h('div', {
                style: { fontSize: '11px', color: 'var(--text-muted, #78788a)', marginTop: '2px' },
              }, [subtitle])
            : null,
        ]),
        h('button', {
          type: 'button',
          title: '关闭',
          /* 2026-04-22 fix: 原先有明显 border 在白天模式下显得格格不入（图 1）
           * 改为无边框 + 仅 hover 时 bg 变化，和其他 icon-btn 风格统一。 */
          className: 'agent-key-modal-close',
          style: {
            width: '28px', height: '28px', borderRadius: '8px',
            border: 'none',
            background: 'transparent', color: 'var(--text-muted, #78788a)',
            cursor: 'pointer', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', fontSize: '18px',
            lineHeight: '1',
            transition: 'background 120ms ease, color 120ms ease',
          },
          onmouseover: function () {
            this.style.background = 'var(--bg-hover, rgba(63,63,70,0.4))';
            this.style.color = 'var(--text-primary)';
          },
          onmouseout: function () {
            this.style.background = 'transparent';
            this.style.color = 'var(--text-muted, #78788a)';
          },
          onclick: function () { closeModal(backdrop); },
        }, ['×']),
      ]),
      h('div', {
        style: {
          flex: '1', minHeight: '0', overflowY: 'auto',
          overscrollBehavior: 'contain', padding: '16px 18px 22px',
        },
      }, [bodyEl]),
    ]);

    backdrop.appendChild(dialog);
    dialog.addEventListener('click', function (ev) { ev.stopPropagation(); });
    backdrop.addEventListener('click', function () { closeModal(backdrop); });
    var esc = function (ev) { if (ev.key === 'Escape') closeModal(backdrop); };
    document.addEventListener('keydown', esc);
    backdrop._escHandler = esc;

    document.body.appendChild(backdrop);
    return backdrop;
  }

  function fetchProject(projectId) {
    return fetch('/api/projects/' + encodeURIComponent(projectId), {
      credentials: 'same-origin',
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function signNewKey(projectId, label) {
    return fetch('/api/projects/' + encodeURIComponent(projectId) + '/agent-keys', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || undefined }),
    }).then(function (r) {
      return r.json().then(function (data) { return { status: r.status, data: data }; });
    });
  }

  function listKeys(projectId) {
    return fetch('/api/projects/' + encodeURIComponent(projectId) + '/agent-keys', {
      credentials: 'same-origin',
    }).then(function (r) { return r.ok ? r.json() : { keys: [] }; });
  }

  function revokeKey(projectId, keyId) {
    return fetch(
      '/api/projects/' + encodeURIComponent(projectId) + '/agent-keys/' + encodeURIComponent(keyId),
      { method: 'DELETE', credentials: 'same-origin' },
    ).then(function (r) { return r.ok; });
  }

  /* ── Sign-a-new-key modal ─────────────────────────────────────────── */
  window.cdsOpenAgentKeyModal = function (projectId) {
    if (!projectId) {
      // Defensive: without a projectId we can't do anything meaningful.
      alert('无法确定当前项目，请从项目列表页发起授权。');
      return;
    }
    var body = h('div', null, [
      h('div', {
        style: { fontSize: '12px', color: 'var(--text-muted, #78788a)', marginBottom: '12px' },
      }, ['正在签发 Agent Key …']),
    ]);
    var root = renderShell('授权 Agent 访问本项目', body, '项目 ID: ' + projectId);

    Promise.all([fetchProject(projectId), signNewKey(projectId, '')]).then(function (results) {
      var project = results[0];
      var signed = results[1];
      if (signed.status >= 400) {
        body.innerHTML = '';
        body.appendChild(h('div', {
          style: { color: '#f43f5e', fontSize: '13px' },
        }, ['签发失败: ' + (signed.data && (signed.data.message || signed.data.error) || '未知错误')]));
        return;
      }
      var plaintext = signed.data.plaintext;
      var hostName = window.location.host;
      var codeLines = [
        'CDS_HOST=https://' + hostName,
        'CDS_PROJECT_ID=' + projectId,
        'CDS_PROJECT_KEY=' + plaintext,
      ];
      var codeText = codeLines.join('\n');

      body.innerHTML = '';

      var intro = h('div', {
        style: { fontSize: '12px', color: 'var(--text-secondary, #a0a0b0)', marginBottom: '10px', lineHeight: '1.55' },
      }, [
        '已为项目 ',
        h('strong', { style: { color: 'var(--text-primary, #e8e8ec)' } }, [project ? (project.aliasName || project.name) : projectId]),
        ' 签发一把 Agent Key。把下面这三行贴给 Claude / Codex / 任何 AI Agent，它们即可操作本项目（且只能操作本项目）。',
      ]);
      body.appendChild(intro);

      var pre = h('pre', {
        style: {
          /* 2026-04-22：bg 和 color 都走主题 token。白天/黑夜都自动对齐 —— 白天
           * 浅底深字、黑夜深底浅字。禁止 hardcoded #e8e8ec 这种只适配黑夜的色。 */
          background: 'var(--bg-terminal)',
          border: '1px solid var(--card-border)',
          borderRadius: '7px',
          padding: '12px 14px',
          fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
          fontSize: '12px',
          lineHeight: '1.55',
          color: 'var(--text-primary)',
          whiteSpace: 'pre',
          overflowX: 'auto',
          margin: '0 0 14px',
        },
      }, [codeText]);
      body.appendChild(pre);

      var status = h('div', {
        style: { fontSize: '11px', color: 'var(--text-muted, #78788a)', marginBottom: '14px', minHeight: '14px' },
      }, []);
      body.appendChild(status);

      var btnRow = h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, []);
      var copyCloseBtn = h('button', {
        type: 'button',
        style: {
          flex: '1', padding: '9px 12px', borderRadius: '7px',
          background: 'var(--accent, #3b82f6)', color: '#fff',
          border: 'none', cursor: 'pointer', fontWeight: '600', fontSize: '13px',
        },
        onclick: function () {
          try {
            navigator.clipboard.writeText(codeText).then(function () {
              status.textContent = '✓ 已复制,关闭中…';
              setTimeout(function () { closeModal(root); }, 450);
            }, function () {
              status.textContent = '复制失败,请手动选中上面的代码块。';
            });
          } catch (_e) {
            status.textContent = '复制失败,请手动选中上面的代码块。';
          }
        },
      }, ['📋 全部复制并关闭']);
      var copyOnlyBtn = h('button', {
        type: 'button',
        style: {
          padding: '9px 12px', borderRadius: '7px',
          background: 'transparent', color: 'var(--text-primary, #e8e8ec)',
          border: '1px solid var(--card-border, #2a2a33)',
          cursor: 'pointer', fontSize: '12px',
        },
        onclick: function () {
          try {
            navigator.clipboard.writeText(codeText).then(function () {
              status.textContent = '✓ 已复制到剪贴板(不关闭,便于多处粘贴)';
            });
          } catch (_e) { status.textContent = '复制失败。'; }
        },
      }, ['仅复制']);
      btnRow.appendChild(copyCloseBtn);
      btnRow.appendChild(copyOnlyBtn);
      body.appendChild(btnRow);

      var reminder = h('div', {
        style: {
          fontSize: '11px', color: 'var(--text-muted, #78788a)',
          /* 2026-04-22 fix: 原 1px dashed 在白天模式几乎看不见，改为 solid border + 用 border-light token 轻量
             注：不写 fallback — 按规则 cds-theme-tokens.md #1 禁止主题特定 fallback；--border-light 在两主题均定义，缺 token 时直接不显示边线即可 */
          borderTop: '1px solid var(--border-light)',
          marginTop: '4px',
          paddingTop: '12px', lineHeight: '1.6',
        },
      }, [
        '⚠ 关闭后 CDS 看不到明文了（只存 sha256），需要查看或吊销请打开 ',
      ]);
      var linkMgr = h('a', {
        href: '#',
        style: { color: 'var(--accent, #3b82f6)', textDecoration: 'underline' },
        onclick: function (ev) {
          ev.preventDefault();
          closeModal(root);
          window.cdsOpenAgentKeyManager(projectId);
        },
      }, ['「Agent Key 管理」']);
      reminder.appendChild(linkMgr);
      reminder.appendChild(document.createTextNode('。'));
      body.appendChild(reminder);
    });
  };

  /* ── Manager modal ────────────────────────────────────────────────── */
  window.cdsOpenAgentKeyManager = function (projectId) {
    if (!projectId) {
      alert('无法确定当前项目。');
      return;
    }
    var listEl = h('div', null, [
      h('div', { style: { fontSize: '12px', color: 'var(--text-muted, #78788a)' } }, ['加载中…']),
    ]);
    var header = h('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '12px',
      },
    }, [
      h('div', {
        style: { fontSize: '12px', color: 'var(--text-secondary, #a0a0b0)' },
      }, ['每把 key 自描述归属项目 (cdsp_<slug>_…),一次签发,仅 sha256 存库。']),
      h('button', {
        type: 'button',
        style: {
          padding: '7px 11px', borderRadius: '6px',
          background: 'var(--accent, #3b82f6)', color: '#fff',
          border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: '600',
        },
        onclick: function () {
          closeModal(root);
          window.cdsOpenAgentKeyModal(projectId);
        },
      }, ['🔑 签发新 Key']),
    ]);
    var body = h('div', null, [header, listEl]);
    var root = renderShell('Agent Key 管理', body, '项目 ID: ' + projectId);

    function fmtTime(s) {
      if (!s) return '—';
      try { return new Date(s).toLocaleString('zh-CN'); } catch (_e) { return s; }
    }

    function render() {
      listEl.innerHTML = '';
      listEl.appendChild(h('div', {
        style: { fontSize: '12px', color: 'var(--text-muted, #78788a)' },
      }, ['加载中…']));
      listKeys(projectId).then(function (data) {
        listEl.innerHTML = '';
        var keys = (data && data.keys) || [];
        if (!keys.length) {
          listEl.appendChild(h('div', {
            style: {
              padding: '24px 12px', textAlign: 'center',
              color: 'var(--text-muted, #78788a)', fontSize: '12px',
              border: '1px dashed var(--card-border, #2a2a33)',
              borderRadius: '8px',
            },
          }, ['还没有任何 Agent Key。点击右上角「签发新 Key」开始。']));
          return;
        }
        keys.forEach(function (k) {
          var statusColor = k.revokedAt ? '#f43f5e' : '#3fb950';
          var row = h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 12px', marginBottom: '6px',
              background: 'var(--bg-base, #0b0b10)',
              border: '1px solid var(--card-border, #2a2a33)',
              borderRadius: '7px',
            },
          }, [
            h('div', { style: { flex: '1', minWidth: '0' } }, [
              h('div', {
                style: { fontWeight: '600', fontSize: '13px', color: 'var(--text-primary, #e8e8ec)' },
              }, [k.label || '(no label)']),
              h('div', {
                style: {
                  fontSize: '11px', color: 'var(--text-muted, #78788a)', marginTop: '3px',
                  display: 'flex', gap: '10px', flexWrap: 'wrap',
                },
              }, [
                h('span', null, ['签发: ' + fmtTime(k.createdAt)]),
                h('span', null, ['最近使用: ' + (k.lastUsedAt ? fmtTime(k.lastUsedAt) : '未使用')]),
                k.createdBy ? h('span', null, ['by ' + k.createdBy]) : null,
              ]),
            ]),
            h('span', {
              style: {
                fontSize: '11px', fontWeight: '600', color: statusColor,
                padding: '3px 8px', borderRadius: '4px',
                background: 'color-mix(in srgb, ' + statusColor + ' 12%, transparent)',
                border: '1px solid ' + statusColor,
              },
            }, [k.status === 'revoked' ? '已吊销' : '有效']),
            k.revokedAt ? null : h('button', {
              type: 'button',
              style: {
                padding: '6px 10px', borderRadius: '5px',
                background: 'transparent', color: '#f43f5e',
                border: '1px solid #f43f5e', cursor: 'pointer', fontSize: '11px',
              },
              onclick: function () {
                if (!confirm('确定吊销「' + (k.label || k.id) + '」?吊销后该 key 立即失效,无法恢复。')) return;
                revokeKey(projectId, k.id).then(function (ok) {
                  if (ok) render();
                  else alert('吊销失败');
                });
              },
            }, ['吊销']),
          ]);
          listEl.appendChild(row);
        });
      });
    }
    render();
  };

  /* ── Global (bootstrap-equivalent) Agent Key modal ───────────────── */
  //
  // Global keys (cdsg_*) are NOT scoped to a project. They can do
  // everything the bootstrap AI_ACCESS_KEY can — create projects,
  // delete projects, cross-project operations. The UI therefore shows
  // a loud warning before minting one, and the manager surfaces total
  // count prominently so the user notices when they've issued many.

  function listGlobalKeys() {
    return fetch('/api/global-agent-keys', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { keys: [] }; });
  }

  function signGlobalKey(label) {
    return fetch('/api/global-agent-keys', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label || undefined }),
    }).then(function (r) {
      return r.json().then(function (data) { return { status: r.status, data: data }; });
    });
  }

  function revokeGlobalKey(keyId) {
    return fetch('/api/global-agent-keys/' + encodeURIComponent(keyId), {
      method: 'DELETE', credentials: 'same-origin',
    }).then(function (r) { return r.ok; });
  }

  // Step 1: warning dialog. The user must explicitly confirm before we
  // even hit the sign endpoint — a global key is strictly more dangerous
  // than a project key, so "two clicks to issue" is the right default.
  function openGlobalSignWarning(onConfirm) {
    var warningText = h('div', {
      style: {
        padding: '14px 16px',
        background: 'rgba(244,63,94,0.08)',
        border: '1px solid rgba(244,63,94,0.35)',
        borderRadius: '8px',
        color: '#fca5a5',
        fontSize: '12.5px',
        lineHeight: '1.65',
        marginBottom: '14px',
      },
    }, [
      h('div', { style: { fontWeight: '700', marginBottom: '6px', color: '#f87171' } }, [
        '⚠ 这把通行证权限相当于 AI_ACCESS_KEY 全局密钥',
      ]),
      h('div', null, [
        '持有者可以',
        h('strong', { style: { color: '#fecaca' } }, ['创建 / 删除任何项目']),
        '、跨项目操作所有分支、读写基础设施服务、签发更多 key。',
      ]),
      h('div', { style: { marginTop: '8px' } }, [
        '只应在为一个新 Agent 引导创建项目时临时签发，',
        h('strong', { style: { color: '#fecaca' } }, ['用完请立即吊销']),
        '。',
      ]),
    ]);

    var labelInput = h('input', {
      type: 'text',
      placeholder: '标签（可选），建议填 Agent 名字 + 用途，例如 "Claude 引导 prd-agent 项目"',
      maxlength: '100',
      style: {
        width: '100%', padding: '9px 11px', borderRadius: '6px',
        border: '1px solid var(--card-border, #2a2a33)',
        background: 'var(--bg-base, #0b0b10)',
        color: 'var(--text-primary, #e8e8ec)',
        fontSize: '12px',
        boxSizing: 'border-box',
        marginBottom: '14px',
      },
    }, []);

    var cancelBtn = h('button', {
      type: 'button',
      style: {
        padding: '9px 14px', borderRadius: '7px',
        background: 'transparent', color: 'var(--text-primary, #e8e8ec)',
        border: '1px solid var(--card-border, #2a2a33)',
        cursor: 'pointer', fontSize: '12px',
      },
      onclick: function () { closeModal(root); },
    }, ['取消']);
    var confirmBtn = h('button', {
      type: 'button',
      style: {
        flex: '1', padding: '9px 14px', borderRadius: '7px',
        background: '#dc2626', color: '#fff',
        border: 'none', cursor: 'pointer', fontWeight: '700', fontSize: '12px',
      },
      onclick: function () {
        var label = (labelInput.value || '').trim();
        closeModal(root);
        onConfirm(label);
      },
    }, ['我明白风险，签发一把 →']);

    var body = h('div', null, [
      warningText,
      labelInput,
      h('div', { style: { display: 'flex', gap: '8px' } }, [cancelBtn, confirmBtn]),
    ]);

    var root = renderShell(
      '签发全局 Agent 通行证',
      body,
      '警告：全局通行证绕过项目隔离，相当于分发管理员密钥',
    );
  }

  // Step 2: show plaintext once. Same copy UX as the project-key modal.
  function openGlobalSignResult(plaintext) {
    var hostName = window.location.host;
    var codeLines = [
      'CDS_HOST=https://' + hostName,
      'CDS_BOOTSTRAP_KEY=' + plaintext,
    ];
    var codeText = codeLines.join('\n');

    var intro = h('div', {
      style: { fontSize: '12px', color: 'var(--text-secondary, #a0a0b0)', marginBottom: '10px', lineHeight: '1.55' },
    }, [
      '已签发一把',
      h('strong', { style: { color: '#fbbf24', margin: '0 3px' } }, ['全局通行证']),
      '。把下面两行贴给需要自动创建项目的 AI Agent。使用完毕请到本对话框吊销。',
    ]);

    var pre = h('pre', {
      style: {
        background: 'var(--bg-base, #0b0b10)',
        border: '1px solid var(--card-border, #2a2a33)',
        borderRadius: '7px',
        padding: '12px 14px',
        fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        lineHeight: '1.55',
        color: 'var(--text-primary, #e8e8ec)',
        whiteSpace: 'pre',
        overflowX: 'auto',
        margin: '0 0 14px',
      },
    }, [codeText]);

    var status = h('div', {
      style: { fontSize: '11px', color: 'var(--text-muted, #78788a)', marginBottom: '14px', minHeight: '14px' },
    }, []);

    var copyCloseBtn = h('button', {
      type: 'button',
      style: {
        flex: '1', padding: '9px 12px', borderRadius: '7px',
        background: 'var(--accent, #3b82f6)', color: '#fff',
        border: 'none', cursor: 'pointer', fontWeight: '600', fontSize: '13px',
      },
      onclick: function () {
        try {
          navigator.clipboard.writeText(codeText).then(function () {
            status.textContent = '✓ 已复制，关闭后将立即打开管理列表，便于随时吊销';
            setTimeout(function () {
              closeModal(root);
              window.cdsOpenGlobalAgentKeyManager();
            }, 700);
          }, function () { status.textContent = '复制失败，请手动选中代码块。'; });
        } catch (_e) { status.textContent = '复制失败。'; }
      },
    }, ['📋 全部复制并进入管理列表']);

    var reminder = h('div', {
      style: {
        fontSize: '11px', color: 'var(--text-muted, #78788a)',
        borderTop: '1px dashed var(--card-border, #2a2a33)',
        paddingTop: '12px', marginTop: '12px', lineHeight: '1.6',
      },
    }, ['⚠ 关闭后 CDS 不再保留明文（只存 sha256）。需要吊销请打开全局通行证管理。']);

    var body = h('div', null, [intro, pre, status, copyCloseBtn, reminder]);
    var root = renderShell(
      '全局通行证已签发（仅显示一次）',
      body,
      '与 AI_ACCESS_KEY 等权，请妥善保管',
    );
  }

  window.cdsOpenGlobalAgentKeyManager = function () {
    var listEl = h('div', null, [
      h('div', { style: { fontSize: '12px', color: 'var(--text-muted, #78788a)' } }, ['加载中…']),
    ]);
    var header = h('div', {
      style: {
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '12px', gap: '10px',
      },
    }, [
      h('div', {
        style: { fontSize: '12px', color: 'var(--text-secondary, #a0a0b0)', flex: '1' },
      }, [
        '全局通行证（cdsg_…）≈ AI_ACCESS_KEY，能操作所有项目。谨慎签发。',
      ]),
      h('button', {
        type: 'button',
        style: {
          padding: '7px 11px', borderRadius: '6px',
          background: '#dc2626', color: '#fff',
          border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: '600',
          flexShrink: '0',
        },
        onclick: function () {
          closeModal(root);
          openGlobalSignWarning(function (label) {
            signGlobalKey(label).then(function (result) {
              if (result.status >= 400) {
                alert('签发失败：' + (result.data && (result.data.message || result.data.error) || '未知错误'));
                window.cdsOpenGlobalAgentKeyManager();
                return;
              }
              openGlobalSignResult(result.data.plaintext);
            });
          });
        },
      }, ['🔑 签发新通行证']),
    ]);
    var body = h('div', null, [header, listEl]);
    var root = renderShell(
      'Agent 全局通行证管理',
      body,
      'bootstrap 级密钥 · 用完请立即吊销',
    );

    function fmtTime(s) {
      if (!s) return '—';
      try { return new Date(s).toLocaleString('zh-CN'); } catch (_e) { return s; }
    }

    function render() {
      listEl.innerHTML = '';
      listEl.appendChild(h('div', {
        style: { fontSize: '12px', color: 'var(--text-muted, #78788a)' },
      }, ['加载中…']));
      listGlobalKeys().then(function (data) {
        listEl.innerHTML = '';
        var keys = (data && data.keys) || [];
        var activeCount = keys.filter(function (k) { return !k.revokedAt; }).length;
        if (activeCount > 0) {
          listEl.appendChild(h('div', {
            style: {
              marginBottom: '10px', padding: '8px 12px',
              background: 'rgba(251,191,36,0.08)',
              border: '1px solid rgba(251,191,36,0.35)',
              borderRadius: '6px', color: '#fbbf24',
              fontSize: '11.5px',
            },
          }, ['⚠ 当前有 ' + activeCount + ' 把全局通行证处于活动状态。未使用的请及时吊销。']));
        }
        if (!keys.length) {
          listEl.appendChild(h('div', {
            style: {
              padding: '24px 12px', textAlign: 'center',
              color: 'var(--text-muted, #78788a)', fontSize: '12px',
              border: '1px dashed var(--card-border, #2a2a33)',
              borderRadius: '8px',
            },
          }, ['还没有全局通行证。点击右上角「签发新通行证」开始。']));
          return;
        }
        keys.forEach(function (k) {
          var statusColor = k.revokedAt ? '#f43f5e' : '#3fb950';
          var row = h('div', {
            style: {
              display: 'flex', alignItems: 'center', gap: '10px',
              padding: '10px 12px', marginBottom: '6px',
              background: 'var(--bg-base, #0b0b10)',
              border: '1px solid var(--card-border, #2a2a33)',
              borderRadius: '7px',
            },
          }, [
            h('div', { style: { flex: '1', minWidth: '0' } }, [
              h('div', {
                style: { fontWeight: '600', fontSize: '13px', color: 'var(--text-primary, #e8e8ec)' },
              }, [k.label || '(no label)']),
              h('div', {
                style: {
                  fontSize: '11px', color: 'var(--text-muted, #78788a)', marginTop: '3px',
                  display: 'flex', gap: '10px', flexWrap: 'wrap',
                },
              }, [
                h('span', null, ['签发: ' + fmtTime(k.createdAt)]),
                h('span', null, ['最近使用: ' + (k.lastUsedAt ? fmtTime(k.lastUsedAt) : '未使用')]),
                k.createdBy ? h('span', null, ['by ' + k.createdBy]) : null,
              ]),
            ]),
            h('span', {
              style: {
                fontSize: '11px', fontWeight: '600', color: statusColor,
                padding: '3px 8px', borderRadius: '4px',
                background: 'color-mix(in srgb, ' + statusColor + ' 12%, transparent)',
                border: '1px solid ' + statusColor,
              },
            }, [k.status === 'revoked' ? '已吊销' : '有效']),
            k.revokedAt ? null : h('button', {
              type: 'button',
              style: {
                padding: '6px 10px', borderRadius: '5px',
                background: 'transparent', color: '#f43f5e',
                border: '1px solid #f43f5e', cursor: 'pointer', fontSize: '11px',
              },
              onclick: function () {
                if (!confirm('吊销「' + (k.label || k.id) + '」？吊销后该通行证立即失效，无法恢复。')) return;
                revokeGlobalKey(k.id).then(function (ok) {
                  if (ok) render();
                  else alert('吊销失败');
                });
              },
            }, ['吊销']),
          ]);
          listEl.appendChild(row);
        });
      });
    }
    render();
  };
})();
