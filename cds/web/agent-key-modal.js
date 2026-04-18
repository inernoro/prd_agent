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
          style: {
            width: '26px', height: '26px', borderRadius: '6px',
            border: '1px solid var(--card-border, #2a2a33)',
            background: 'transparent', color: 'var(--text-muted, #78788a)',
            cursor: 'pointer', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', fontSize: '14px',
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
        h('strong', { style: { color: 'var(--text-primary, #e8e8ec)' } }, [project ? project.name : projectId]),
        ' 签发一把 Agent Key。把下面这三行贴给 Claude / Codex / 任何 AI Agent，它们即可操作本项目（且只能操作本项目）。',
      ]);
      body.appendChild(intro);

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
          borderTop: '1px dashed var(--card-border, #2a2a33)',
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
})();
