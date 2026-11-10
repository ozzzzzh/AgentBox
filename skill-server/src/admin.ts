function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function adminHtml(devToken?: string): string {
  const devTokenAttribute =
    devToken === undefined ? '' : ` data-dev-token="${escapeAttribute(devToken)}"`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Skill Registry Server</title>
<style>
:root{
  color-scheme:light dark;
  --bg:#ffffff;--text:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;
  --hover:#f5f5f7;--accent:#0071e3;--danger:#c62828;--ok:#1a7f37;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#000000;--text:#f5f5f7;--muted:#a1a1a6;--line:#333336;
    --hover:#1c1c1e;--accent:#2997ff;--danger:#ff6961;--ok:#30d158}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}
button,input,textarea{font:inherit}
button{cursor:pointer}
.top{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;
  gap:16px;height:48px;padding:0 16px;background:color-mix(in srgb,var(--bg) 88%,transparent);
  border-bottom:1px solid var(--line);backdrop-filter:saturate(180%) blur(16px)}
.brand{font-size:15px;font-weight:600;letter-spacing:-.01em}
.auth{display:flex;align-items:center;gap:14px;color:var(--muted);font-size:12px}
.auth strong{color:var(--text);font-weight:500}
.link{border:0;background:none;color:var(--muted);padding:0;font-size:12px}
.link:hover{color:var(--text)}
main{padding:12px 16px}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;
  border-bottom:1px solid var(--line)}
.tabs{display:flex;gap:22px;overflow:auto}
.tab{border:0;background:none;color:var(--muted);padding:0 0 11px;font-size:13px;white-space:nowrap;
  border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--text)}
.tab.active{color:var(--text);border-bottom-color:var(--text);font-weight:500}
.tools{display:flex;align-items:center;gap:8px;padding-bottom:9px}
input[type=search],input[type=password],input[type=text],textarea{
  border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--text);
  padding:6px 9px;outline:none}
input:focus,textarea:focus{border-color:var(--accent)}
input[type=search]{width:210px;font-size:12px}
.btn{border:1px solid var(--line);background:var(--bg);color:var(--text);border-radius:4px;
  padding:4px 10px;font-size:12px;white-space:nowrap}
.btn:hover{border-color:var(--text)}
.btn.primary{background:var(--text);border-color:var(--text);color:var(--bg)}
.btn.danger{color:var(--danger)}
.btn.muted{border-color:transparent;background:none;color:var(--muted)}
.btn.muted:hover{color:var(--text)}
table{width:100%;border-collapse:collapse}
th{font-size:11px;font-weight:500;color:var(--muted);text-align:left;letter-spacing:.03em;
  padding:10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:11px 8px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
tbody tr:hover{background:var(--hover)}
.skill{font-weight:500;word-break:break-all}
.sub{color:var(--muted);font-size:12px;margin-top:2px}
.status{display:inline-flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap}
.dot{width:6px;height:6px;border-radius:50%;background:var(--muted)}
.dot.pending{background:#b26a00}.dot.approved{background:var(--ok)}
.dot.rejected,.dot.revoked{background:var(--danger)}
.required{color:var(--muted);font-size:12px;margin-left:8px}
.actions{text-align:right;white-space:nowrap}
.actions .btn{margin-left:4px}
.empty{padding:48px 10px;text-align:center;color:var(--muted);font-size:13px}
.login{min-height:100vh;display:grid;place-items:center;padding:24px}
.login form{width:min(340px,100%)}
.login h1{font-size:21px;font-weight:600;letter-spacing:-.02em;margin:0 0 24px}
.field{margin-bottom:12px}
.field label{display:block;font-size:12px;color:var(--muted);margin-bottom:5px}
.field input{width:100%;padding:8px 10px}
.login .btn{width:100%;padding:8px;margin-top:4px}
.error{color:var(--danger);font-size:12px;min-height:17px;margin-top:8px}
.modal{position:fixed;inset:0;z-index:10;display:grid;place-items:center;padding:24px;
  background:rgba(0,0,0,.4)}
.sheet{width:min(820px,100%);max-height:86vh;overflow:auto;background:var(--bg);
  border:1px solid var(--line);border-radius:6px;padding:24px}
.sheet-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;
  padding-bottom:16px;border-bottom:1px solid var(--line)}
.sheet h2{font-size:16px;font-weight:600;margin:0;word-break:break-all}
.meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;padding:16px 0;
  border-bottom:1px solid var(--line);font-size:12px}
.meta label{display:block;color:var(--muted);font-size:11px;margin-bottom:3px}
pre{white-space:pre-wrap;overflow:auto;background:var(--hover);border-radius:4px;padding:12px;
  font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;max-height:42vh}
.file-title{font-size:12px;font-weight:500;color:var(--muted);margin:16px 0 6px}
.section-title{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:24px 0 6px}
.review{display:flex;gap:8px;align-items:flex-start;padding-top:18px}
.review textarea{flex:1;min-height:64px;resize:vertical;padding:8px 10px;font-size:12px}
.checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;max-height:220px;
  overflow:auto;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px 0;margin:4px 0 14px}
.check{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text)}
.check input{accent-color:var(--accent)}
.toast{position:fixed;right:24px;bottom:24px;z-index:20;background:var(--text);color:var(--bg);
  padding:9px 13px;border-radius:4px;font-size:12px;max-width:420px}
.hidden{display:none!important}
@media (max-width:760px){
  .top{padding:0 16px}main{padding:16px}
  .toolbar{align-items:flex-start;flex-direction:column;gap:8px}
  .tools{width:100%;padding-bottom:10px}
  input[type=search]{flex:1;width:auto;min-width:0}
  th:nth-child(3),td:nth-child(3),th:nth-child(4),td:nth-child(4){display:none}
  .meta{grid-template-columns:repeat(2,minmax(0,1fr))}
}
</style>
</head>
<body${devTokenAttribute}>
<header class="top">
  <div class="brand">Skill Registry Server</div>
  <div id="auth" class="auth hidden">
    <span><strong id="actor"></strong></span>
    <span id="role"></span>
    <button id="logout" class="link">退出</button>
  </div>
</header>

<main id="app" class="hidden">
  <div class="toolbar">
    <nav class="tabs" id="tabs">
      <button class="tab active" data-tab="pending">待审批</button>
      <button class="tab" data-tab="approved">已批准</button>
      <button class="tab" data-tab="required">必选</button>
      <button class="tab" data-tab="all">全部</button>
      <button class="tab" data-tab="groups">分组</button>
      <button class="tab hidden" data-tab="audit">审计</button>
    </nav>
    <div class="tools">
      <input id="search" type="search" placeholder="搜索" autocomplete="off">
      <button id="newGroup" class="btn hidden">新建分组</button>
      <button id="refresh" class="btn">刷新</button>
    </div>
  </div>
  <div id="content"></div>
  <div id="audit" class="hidden"></div>
</main>

<section id="loginView" class="login">
  <form id="loginForm">
    <h1>Skill Registry Server</h1>
    <div class="field"><label>Token</label><input id="token" type="password" autocomplete="off" autofocus></div>
    <div class="field"><label>操作人（可选）</label><input id="user" type="text" autocomplete="off"></div>
    <div id="loginError" class="error"></div>
    <button class="btn primary" type="submit">登录</button>
  </form>
</section>

<div id="modal" class="modal hidden">
  <div class="sheet">
    <div class="sheet-head">
      <div><h2 id="modalTitle"></h2><div id="modalSub" class="sub"></div></div>
      <button id="modalClose" class="btn muted">关闭</button>
    </div>
    <div id="modalMeta" class="meta"></div>
    <div id="modalFiles"></div>
    <div id="modalReview" class="review hidden">
      <textarea id="comment" placeholder="审批备注（可选）"></textarea>
      <button id="approve" class="btn primary">通过</button>
      <button id="reject" class="btn danger">拒绝</button>
    </div>
    <div id="groupForm" class="hidden">
      <div class="field"><label>ID</label><input id="group-id" type="text" placeholder="例如 backend"></div>
      <div class="field"><label>名称</label><input id="group-name" type="text" placeholder="后端规范"></div>
      <div class="field"><label>描述</label><input id="group-desc" type="text" placeholder="可选"></div>
      <div class="file-title">包含的 Skill</div>
      <div id="group-skills" class="checks"></div>
      <div class="review"><button id="groupSave" class="btn primary">保存</button><button id="groupCancel" class="btn">取消</button></div>
    </div>
  </div>
</div>
<div id="toast" class="toast hidden"></div>

<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var RANK = { reader: 1, author: 2, reviewer: 3, admin: 4 };
  var devToken = document.body.getAttribute('data-dev-token') || '';
  var state = {
    token: devToken || sessionStorage.getItem('agentbox.skill.token') || '',
    user: sessionStorage.getItem('agentbox.skill.user') || '',
    actor: '',
    role: '',
    tab: 'pending',
    skills: [],
    groups: [],
    requests: [],
    modal: null
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function can(role) { return (RANK[state.role] || 0) >= (RANK[role] || 99); }
  function time(value) {
    if (!value) return '';
    var d = new Date(value);
    return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.classList.add('hidden'); }, 2800);
  }
  function showLogin(message) {
    $('loginView').classList.remove('hidden');
    $('app').classList.add('hidden');
    $('auth').classList.add('hidden');
    $('loginError').textContent = message || '';
  }
  function showApp() {
    $('loginView').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('auth').classList.remove('hidden');
    $('actor').textContent = state.actor;
    $('role').textContent = state.role;
    var auditTab = document.querySelector('[data-tab="audit"]');
    if (auditTab) auditTab.classList.toggle('hidden', !can('admin'));
    $('newGroup').classList.toggle('hidden', !can('admin'));
  }

  async function api(path, options) {
    options = options || {};
    var headers = { accept: 'application/json' };
    if (state.token) headers.authorization = 'Bearer ' + state.token;
    if (state.user) headers['x-agentbox-user'] = state.user;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    var response = await fetch(path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    var text = await response.text();
    var value;
    try { value = text ? JSON.parse(text) : undefined; } catch (e) { value = text; }
    if (response.status === 401) {
      state.token = '';
      sessionStorage.removeItem('agentbox.skill.token');
      showLogin('Token 无效。');
      throw new Error('unauthorized');
    }
    if (!response.ok) throw new Error((value && value.error && value.error.message) || ('HTTP ' + response.status));
    return value;
  }

  async function login() {
    state.token = $('token').value.trim();
    state.user = $('user').value.trim();
    if (!state.token) { $('loginError').textContent = '请输入 token。'; return; }
    try {
      var me = await api('/v1/me');
      state.actor = me.actor;
      state.role = me.role;
      sessionStorage.setItem('agentbox.skill.token', state.token);
      sessionStorage.setItem('agentbox.skill.user', state.user);
      showApp();
      await load();
    } catch (error) {
      if (error.message !== 'unauthorized') $('loginError').textContent = error.message;
    }
  }

  function logout() {
    state.token = '';
    state.user = '';
    state.actor = '';
    state.role = '';
    sessionStorage.removeItem('agentbox.skill.token');
    sessionStorage.removeItem('agentbox.skill.user');
    showLogin('');
  }

  async function load() {
    try {
      var result = can('reviewer')
        ? await api('/v1/skills?status=all')
        : await api('/v1/skills?status=approved');
      state.skills = result.skills || [];
      try {
        state.groups = (await api('/v1/groups')).groups || [];
      } catch (e) {
        state.groups = [];
      }
      if (can('admin')) {
        try {
          state.requests = (await api('/v1/group-requests?status=pending')).requests || [];
        } catch (e) {
          state.requests = [];
        }
      } else {
        state.requests = [];
      }
      renderTabs();
      if (state.tab === 'audit') await loadAudit(); else render();
    } catch (error) {
      if (error.message !== 'unauthorized') toast(error.message);
    }
  }

  function count(status) {
    return state.skills.filter(function (item) { return item.status === status; }).length;
  }
  function renderTabs() {
    var pending = document.querySelector('[data-tab="pending"]');
    var approved = document.querySelector('[data-tab="approved"]');
    var required = document.querySelector('[data-tab="required"]');
    if (pending) pending.textContent = '待审批 ' + count('pending');
    if (approved) approved.textContent = '已批准 ' + count('approved');
    if (required) required.textContent = '必选 ' + state.skills.filter(function (item) { return item.required; }).length;
    var groups = document.querySelector('[data-tab="groups"]');
    if (groups) groups.textContent = '分组 ' + state.groups.length +
      (state.requests.length ? ' · 申请 ' + state.requests.length : '');
  }

  function rows() {
    var query = $('search').value.trim().toLowerCase();
    return state.skills.filter(function (item) {
      if (state.tab === 'pending' && item.status !== 'pending') return false;
      if (state.tab === 'approved' && item.status !== 'approved') return false;
      if (state.tab === 'required' && !item.required) return false;
      if (!query) return true;
      return [item.id, item.name, item.owner, item.description].join(' ').toLowerCase().indexOf(query) >= 0;
    });
  }

  function statusText(item) {
    if (item.status === 'pending') return '<span class="status"><i class="dot pending"></i>待审批</span>';
    if (item.status === 'approved') return '<span class="status"><i class="dot approved"></i>已批准</span>';
    if (item.status === 'rejected') return '<span class="status"><i class="dot rejected"></i>已拒绝</span>';
    if (item.status === 'revoked') return '<span class="status"><i class="dot revoked"></i>已撤销</span>';
    return '<span class="status"><i class="dot"></i>' + esc(item.status) + '</span>';
  }

  function render() {
    var content = $('content');
    $('audit').classList.add('hidden');
    content.classList.remove('hidden');
    if (state.tab === 'audit') {
      content.classList.add('hidden');
      $('audit').classList.remove('hidden');
      return;
    }
    if (state.tab === 'groups') {
      renderGroups();
      return;
    }
    var list = rows();
    if (!list.length) {
      content.innerHTML = '<div class="empty">暂无记录</div>';
      return;
    }
    var html = '<table><thead><tr><th>Skill</th><th>状态</th><th>Owner</th><th>更新</th><th></th></tr></thead><tbody>';
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var updated = item.reviewedAt || item.submittedAt;
      html += '<tr>';
      html += '<td><div class="skill">' + esc(item.id) + ' <span class="sub">v' + esc(item.version) + '</span>' + (item.required ? '<span class="required">必选</span>' : '') + (item.status === 'approved' && item.enabled === false ? '<span class="required">未推送</span>' : '') + '</div><div class="sub">' + esc(item.name || item.description || '') + '</div></td>';
      html += '<td>' + statusText(item) + '</td>';
      html += '<td>' + esc(item.owner || '') + '</td>';
      html += '<td><div>' + time(updated) + '</div><div class="sub">' + esc(item.reviewedBy || item.submittedBy || '') + '</div></td>';
      html += '<td class="actions">';
      if (item.status === 'pending' && can('reviewer')) {
        html += '<button class="btn primary" data-action="review" data-id="' + esc(item.id) + '" data-version="' + esc(item.version) + '">审核</button>';
      }
      if (item.status === 'approved' && can('admin')) {
        html += '<button class="btn" data-action="' + (item.required ? 'unrequire' : 'require') + '" data-id="' + esc(item.id) + '" data-version="' + esc(item.version) + '">' + (item.required ? '取消必选' : '设为必选') + '</button>';
        html += '<button class="btn" data-action="' + (item.enabled === false ? 'enable' : 'disable') + '" data-id="' + esc(item.id) + '" data-version="' + esc(item.version) + '">' + (item.enabled === false ? '推送给 Agent' : '停止推送') + '</button>';
        html += '<button class="btn danger" data-action="revoke" data-id="' + esc(item.id) + '" data-version="' + esc(item.version) + '">撤销</button>';
      }
      html += '<button class="btn muted" data-action="view" data-id="' + esc(item.id) + '" data-version="' + esc(item.version) + '">查看</button>';
      html += '</td></tr>';
    }
    html += '</tbody></table>';
    content.innerHTML = html;
    var buttons = document.querySelectorAll('[data-action]');
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].addEventListener('click', function () { act(this.dataset.action, this.dataset.id, this.dataset.version); });
    }
  }


  function renderGroups() {
    var content = $('content');
    $('audit').classList.add('hidden');
    content.classList.remove('hidden');
    if (!state.groups.length) {
      content.innerHTML = '<div class="empty">暂无分组</div>';
      return;
    }
    var html = '<table><thead><tr><th>分组</th><th>ID</th><th>成员</th><th>更新</th><th></th></tr></thead><tbody>';
    for (var i = 0; i < state.groups.length; i++) {
      var group = state.groups[i];
      html += '<tr>';
      html += '<td><div class="skill">' + esc(group.name) + '</div><div class="sub">' + esc(group.description || '') + '</div></td>';
      html += '<td>' + esc(group.id) + '</td>';
      html += '<td>' + (group.skillIds.length ? esc(group.skillIds.join(', ')) : '<span class="sub">空</span>') + '</td>';
      html += '<td>' + time(group.updatedAt) + '</td>';
      html += '<td class="actions">';
      if (can('admin')) {
        html += '<button class="btn" data-group-action="edit" data-group-id="' + esc(group.id) + '">编辑</button>';
        html += '<button class="btn danger" data-group-action="delete" data-group-id="' + esc(group.id) + '">删除</button>';
      }
      html += '</td></tr>';
    }
    html += '</tbody></table>';
    if (can('admin') && state.requests.length) {
      html += '<div class="section-title">加入申请</div><table><thead><tr><th>客户端</th><th>分组</th><th>时间</th><th></th></tr></thead><tbody>';
      for (var r = 0; r < state.requests.length; r++) {
        var request = state.requests[r];
        html += '<tr><td><div>' + esc(request.clientName) + '</div><div class="sub">' + esc(request.clientId) + '</div></td>' +
          '<td>' + esc(request.groupName) + '</td><td>' + time(request.updatedAt) + '</td>' +
          '<td class="actions"><button class="btn primary" data-request-action="approve" data-client="' + esc(request.clientId) + '" data-group="' + esc(request.groupId) + '">通过</button>' +
          '<button class="btn danger" data-request-action="reject" data-client="' + esc(request.clientId) + '" data-group="' + esc(request.groupId) + '">拒绝</button></td></tr>';
      }
      html += '</tbody></table>';
    }
    content.innerHTML = html;
    var buttons = document.querySelectorAll('[data-group-action]');
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].addEventListener('click', function () {
        var action = this.dataset.groupAction;
        var id = this.dataset.groupId;
        if (action === 'edit') {
          var group = null;
          for (var k = 0; k < state.groups.length; k++) {
            if (state.groups[k].id === id) { group = state.groups[k]; break; }
          }
          openGroup(group);
        } else if (action === 'delete') {
          deleteGroup(id);
        }
      });
    }
    var requestButtons = document.querySelectorAll('[data-request-action]');
    for (var n = 0; n < requestButtons.length; n++) {
      requestButtons[n].addEventListener('click', function () {
        actGroupRequest(this.dataset.requestAction, this.dataset.client, this.dataset.group);
      });
    }
  }

  async function actGroupRequest(action, clientId, groupId) {
    try {
      await api('/v1/group-requests/' + encodeURIComponent(clientId) + '/' + encodeURIComponent(groupId), {
        method: 'POST',
        body: { action: action }
      });
      toast(action === 'approve' ? '已通过加入申请' : '已拒绝加入申请');
      await load();
    } catch (error) { toast(error.message); }
  }

  function openGroup(group) {
    state.modal = { type: 'group', id: group ? group.id : null };
    $('modalTitle').textContent = group ? '编辑分组' : '新建分组';
    $('modalSub').textContent = '';
    $('modalMeta').innerHTML = '';
    $('modalFiles').innerHTML = '';
    $('modalReview').classList.add('hidden');
    $('groupForm').classList.remove('hidden');
    $('group-id').value = group ? group.id : '';
    $('group-id').disabled = Boolean(group);
    $('group-name').value = group ? group.name : '';
    $('group-desc').value = group ? group.description || '' : '';
    var ids = {};
    for (var i = 0; i < state.skills.length; i++) ids[state.skills[i].id] = state.skills[i];
    var selected = {};
    for (var j = 0; j < (group ? group.skillIds.length : 0); j++) selected[group.skillIds[j]] = true;
    var checks = Object.keys(ids).sort().map(function (id) {
      return '<label class="check"><input type="checkbox" value="' + esc(id) + '"' +
        (selected[id] ? ' checked' : '') + '> ' + esc(id) + ' <span class="sub">' + esc(ids[id].name || '') + '</span></label>';
    }).join('');
    $('group-skills').innerHTML = checks || '<span class="sub">暂无 skill</span>';
    $('modal').classList.remove('hidden');
  }

  async function saveGroup() {
    if (!state.modal || state.modal.type !== 'group') return;
    var id = $('group-id').value.trim();
    var name = $('group-name').value.trim();
    if (!id || !name) { toast('请填写分组 ID 和名称'); return; }
    var skillIds = [];
    var checks = document.querySelectorAll('#group-skills input[type=checkbox]');
    for (var i = 0; i < checks.length; i++) if (checks[i].checked) skillIds.push(checks[i].value);
    try {
      await api('/v1/groups/' + encodeURIComponent(id), {
        method: 'PUT',
        body: { name: name, description: $('group-desc').value.trim(), skillIds: skillIds }
      });
      $('modal').classList.add('hidden');
      toast('分组已保存');
      await load();
    } catch (error) { toast(error.message); }
  }

  async function deleteGroup(id) {
    if (!confirm('删除分组 ' + id + '？')) return;
    try {
      await api('/v1/groups/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('分组已删除');
      await load();
    } catch (error) { toast(error.message); }
  }

  async function act(action, id, version) {
    if (action === 'view' || action === 'review') return openPackage(id, version, action === 'review');
    if (action === 'revoke' && !confirm('撤销 ' + id + '@' + version + '？')) return;
    var item = null;
    for (var i = 0; i < state.skills.length; i++) {
      if (state.skills[i].id === id && state.skills[i].version === version) { item = state.skills[i]; break; }
    }
    try {
      if (action === 'require' || action === 'unrequire') {
        await api('/v1/skills/' + encodeURIComponent(id) + '/policy', {
          method: 'PUT',
          body: { required: action === 'require', enabled: item ? item.enabled !== false : true, version: version, target: 'all' }
        });
      } else if (action === 'enable' || action === 'disable') {
        await api('/v1/skills/' + encodeURIComponent(id) + '/policy', {
          method: 'PUT',
          body: { required: action === 'enable' ? (item && item.required) === true : false, enabled: action === 'enable', version: version, target: 'all' }
        });
      } else if (action === 'revoke') {
        await api('/v1/skills/' + encodeURIComponent(id) + '/' + encodeURIComponent(version) + '/revoke', { method: 'POST', body: {} });
      }
      toast('已更新');
      await load();
    } catch (error) { toast(error.message); }
  }

  async function openPackage(id, version, review) {
    try {
      var pkg = await api('/v1/skills/' + encodeURIComponent(id) + '/' + encodeURIComponent(version));
      state.modal = { id: id, version: version };
      $('modalTitle').textContent = id + '@' + version;
      $('modalSub').textContent = pkg.manifest && pkg.manifest.description ? pkg.manifest.description : '';
      $('modalMeta').innerHTML =
        '<div><label>Owner</label>' + esc(pkg.manifest && pkg.manifest.owner) + '</div>' +
        '<div><label>Activation</label>' + esc(pkg.manifest && pkg.manifest.activation) + '</div>' +
        '<div><label>Priority</label>' + esc(pkg.manifest && pkg.manifest.priority) + '</div>' +
        '<div><label>Hash</label><span style="word-break:break-all">' + esc(pkg.hash ? String(pkg.hash).slice(0, 16) : '') + '</span></div>';
      var files = pkg.files || {};
      var body = '';
      Object.keys(files).sort().forEach(function (name) {
        body += '<div class="file-title">' + esc(name) + '</div><pre>' + esc(files[name]) + '</pre>';
      });
      $('modalFiles').innerHTML = body;
      $('modalReview').classList.toggle('hidden', !review);
      $('groupForm').classList.add('hidden');
      $('comment').value = '';
      $('modal').classList.remove('hidden');
    } catch (error) { toast(error.message); }
  }

  async function review(action) {
    if (!state.modal) return;
    try {
      await api('/v1/skills/' + encodeURIComponent(state.modal.id) + '/' + encodeURIComponent(state.modal.version) + '/' + action, {
        method: 'POST',
        body: { comment: $('comment').value.trim() || undefined }
      });
      $('modal').classList.add('hidden');
      toast('已' + (action === 'approve' ? '通过' : '拒绝'));
      await load();
    } catch (error) { toast(error.message); }
  }

  async function loadAudit() {
    if (!can('admin')) return;
    try {
      var result = await api('/v1/audit?limit=200');
      var rows = (result.audit || []).map(function (item) {
        return '<tr><td>' + time(item.at) + '</td><td>' + esc(item.actor) + '</td><td>' + esc(item.action) + '</td><td>' + esc(item.id || '') + (item.version ? ' v' + esc(item.version) : '') + '</td><td>' + esc(item.detail || '') + '</td></tr>';
      }).join('');
      $('audit').innerHTML = '<table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>Skill</th><th>详情</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="empty">暂无记录</td></tr>') + '</tbody></table>';
    } catch (error) {
      $('audit').innerHTML = '<div class="empty">' + esc(error.message) + '</div>';
    }
  }

  function selectTab(tab) {
    state.tab = tab;
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i].dataset.tab === tab);
    if (tab === 'audit') {
      $('content').classList.add('hidden');
      $('audit').classList.remove('hidden');
      loadAudit();
    } else {
      $('audit').classList.add('hidden');
      $('content').classList.remove('hidden');
      render();
    }
  }

  $('loginForm').addEventListener('submit', function (e) { e.preventDefault(); login(); });
  $('logout').addEventListener('click', logout);
  $('refresh').addEventListener('click', load);
  $('newGroup').addEventListener('click', function () { openGroup(null); });
  $('groupSave').addEventListener('click', saveGroup);
  $('groupCancel').addEventListener('click', function () { $('modal').classList.add('hidden'); });
  $('search').addEventListener('input', render);
  $('modalClose').addEventListener('click', function () { $('modal').classList.add('hidden'); });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.add('hidden'); });
  $('approve').addEventListener('click', function () { review('approve'); });
  $('reject').addEventListener('click', function () { review('reject'); });
  var tabs = document.querySelectorAll('.tab');
  for (var k = 0; k < tabs.length; k++) {
    tabs[k].addEventListener('click', function () { selectTab(this.dataset.tab); });
  }

  if (state.token) {
    $('token').value = state.token;
    $('user').value = state.user;
    api('/v1/me').then(function (me) {
      state.actor = me.actor;
      state.role = me.role;
      showApp();
      return load();
    }).catch(function () { showLogin(''); });
  } else {
    showLogin('');
  }
})();
</script>
</body>
</html>`;
}
