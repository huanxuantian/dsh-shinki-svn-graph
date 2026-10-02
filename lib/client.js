/*!
 * dsh-shinki-svn-graph client bundle (browser half).
 *
 * 通过 dsh-better-sidebar 的 `ctx.betterSidebar` 服务注册一个侧边栏 Tab
 * （「SVN 版本」），渲染：工作副本选择器、认证状态条、本地改动列表、
 * 提交说明框、以及提交日志（默认最近 20 条）。
 *
 * 数据来自 host 半边的 POST /shinki-svn/api 路由。
 *
 * 认证策略与 host 一致：**系统凭据优先**——默认不向 host 发送账号密码，
 * 让 svn 走自己的凭据链（macOS 上是钥匙串）；只有系统凭据不可用
 * （host 返回 needsCredentials）或用户主动点「切换账号」时，才显示
 * 账号/密码输入框。
 */
window.__ModuleLoader__.load({
  id: 'dsh-shinki-svn-graph',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const { useState, useEffect, useRef } = react;

    // ── helpers ──────────────────────────────────────────────────────────
    const h = (type, props, ...children) => react.createElement(type, props ?? null, ...children);

    /** 与 package.json 的 version 保持一致（浏览器半边读不到 package.json）。 */
    const PLUGIN_VERSION = '0.1.2';
    const name = 'dsh-shinki-svn-graph';

    /** 内联线性图标（16px，stroke=currentColor 跟随主题前景色）。 */
    const svgIcon = (d, size) => h('svg', {
      width: size || 16, height: size || 16, viewBox: '0 0 16 16',
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }, h('path', { d }));
    const Icons = {
      // 分叉/版本：双肩 + 节点
      IconBranch: (p) => svgIcon('M4 2v12M4 4.5h3.2a1.8 1.8 0 0 1 1.8 1.8v1.4a1.8 1.8 0 0 0 1.8 1.8H14', p && p.size),
      // 刷新
      IconRefresh: (p) => svgIcon('M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.2 2.4v2.4h-2.4', p && p.size),
      // 下载（拉取）
      IconPull: (p) => svgIcon('M8 2v8M4.8 6.8 8 10l3.2-3.2M2.8 13.2h10.4', p && p.size),
      // 加号（添加）
      IconAdd: (p) => svgIcon('M8 3.2v9.6M3.2 8h9.6', p && p.size),
      // 上传（提交）
      IconCommit: (p) => svgIcon('M8 10V2M4.8 5.2 8 2l3.2 3.2M2.8 13.2h10.4', p && p.size),
      // 用户（认证）
      IconUser: (p) => svgIcon('M8 8.2a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM2.8 13.6c.6-2.4 2.7-3.8 5.2-3.8s4.6 1.4 5.2 3.8', p && p.size),
      // 钥匙（系统凭据）
      IconKey: (p) => svgIcon('M9.6 6.4a2.7 2.7 0 1 1-2.4-2.7M8.4 5.4 2.6 11.2v2.2h2.2l.9-.9v-1.2h1.2l1-1v-1.2h1.2', p && p.size),
      // 文件
      IconFile: (p) => svgIcon('M3.6 2.2h5.2l3.6 3.6v8a.8.8 0 0 1-.8.8H3.6a.8.8 0 0 1-.8-.8V3a.8.8 0 0 1 .8-.8ZM8.8 2.4v3.4h3.4', p && p.size),
    };

    // ── i18n ─────────────────────────────────────────────────────────────
    const NS = 'shinkiSvnGraph';
    const zh = {
      tabTitle: 'SVN 版本',
      repoWorkspace: '工作区根目录',
      notWc: '当前工作区不是 SVN 工作副本',
      notWcHint: '可在下面的子目录中选择一个工作副本，或先用 svn checkout 检出。',
      svnMissing: '未找到 svn 可执行文件',
      noSession: '尚未绑定会话，无法定位工作区',
      retry: '重试',
      refresh: '刷新',
      pull: '拉取',
      add: '添加',
      commit: '提交',
      count: '条数',
      localChanges: '本地改动',
      noChanges: '工作副本干净，没有本地改动',
      log: '提交日志',
      noLog: '暂无日志',
      commitMessage: '提交说明',
      commitMessagePlaceholder: '填写提交说明（提交时必填）…',
      commitSelected: '只提交选中项',
      commitAll: '提交全部改动',
      selectAll: '全选',
      selectNone: '清空',
      authSystem: '系统凭据',
      authSystemOk: '系统凭据可用',
      authNeeded: '需要登录',
      authSwitch: '切换账号',
      authTitle: '账号认证',
      username: '用户名',
      password: '密码',
      saveCreds: '保存凭据（交给 svn 凭据缓存）',
      trustCert: '信任服务器证书（自签名/过期时）',
      apply: '使用该账号',
      cancel: '取消',
      useSystem: '改用系统凭据',
      loading: '加载中…',
      working: '执行中…',
      paths: '改动路径',
      revision: '版本',
      author: '作者',
      date: '时间',
      output: '输出',
      close: '关闭',
      done: '完成',
      failed: '失败',
      selectFirst: '请先勾选要操作的条目',
      needMessage: '请填写提交说明',
      itemAdded: '已添加',
      itemModified: '已修改',
      itemDeleted: '已删除',
      itemReplaced: '已替换',
      itemMissing: '缺失',
      itemConflicted: '冲突',
      itemUnversioned: '未纳入版本控制',
      itemIgnored: '已忽略',
      itemObstructed: '阻塞',
      itemExternal: '外部',
      itemIncomplete: '不完整',
      itemMerged: '已合并',
      itemNormal: '正常',
      itemUnknown: '未知',
      promotedNote: '其中 {n} 个新文件位于新增目录下，svn 要求连同该目录一并提交——这些目录下的全部新增文件都会一起提交。',
    };
    const en = {
      tabTitle: 'SVN',
      repoWorkspace: 'Workspace root',
      notWc: 'The workspace is not an SVN working copy',
      notWcHint: 'Pick a working copy from the subdirectories below, or run svn checkout first.',
      svnMissing: 'svn executable not found',
      noSession: 'No session bound; cannot locate the workspace',
      retry: 'Retry',
      refresh: 'Refresh',
      pull: 'Update',
      add: 'Add',
      commit: 'Commit',
      count: 'Count',
      localChanges: 'Local changes',
      noChanges: 'Working copy is clean',
      log: 'Log',
      noLog: 'No log entries',
      commitMessage: 'Commit message',
      commitMessagePlaceholder: 'Commit message (required)…',
      commitSelected: 'Selected only',
      commitAll: 'Commit all changes',
      selectAll: 'All',
      selectNone: 'None',
      authSystem: 'System credentials',
      authSystemOk: 'System credentials available',
      authNeeded: 'Sign-in required',
      authSwitch: 'Switch account',
      authTitle: 'Authentication',
      username: 'Username',
      password: 'Password',
      saveCreds: 'Save credentials (svn credential cache)',
      trustCert: 'Trust server certificate (self-signed/expired)',
      apply: 'Use this account',
      cancel: 'Cancel',
      useSystem: 'Use system credentials',
      loading: 'Loading…',
      working: 'Working…',
      paths: 'Changed paths',
      revision: 'Revision',
      author: 'Author',
      date: 'Date',
      output: 'Output',
      close: 'Close',
      done: 'Done',
      failed: 'Failed',
      selectFirst: 'Select at least one entry first',
      needMessage: 'Commit message is required',
      itemAdded: 'Added',
      itemModified: 'Modified',
      itemDeleted: 'Deleted',
      itemReplaced: 'Replaced',
      itemMissing: 'Missing',
      itemConflicted: 'Conflicted',
      itemUnversioned: 'Unversioned',
      itemIgnored: 'Ignored',
      itemObstructed: 'Obstructed',
      itemExternal: 'External',
      itemIncomplete: 'Incomplete',
      itemMerged: 'Merged',
      itemNormal: 'Normal',
      itemUnknown: 'Unknown',
      promotedNote: '{n} new file(s) are inside newly added directories; svn requires committing those directories too, so every new file under them is committed as well.',
    };
    const DICTS = { zh, en };
    const activeLocale = () => {
      try {
        const a = (typeof nw !== 'undefined' && nw) ? 'zh' : (navigator.language || 'zh');
        return a.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch { return 'zh'; }
    };
    const t = (key, vars) => {
      const dict = DICTS[activeLocale()] ?? zh;
      let s = dict[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
      return s;
    };

    /** svn 的 wc-status item → {字母, 文案 key, 色调}。 */
    const ITEM_META = {
      added: { letter: 'A', label: 'itemAdded', tone: 'ok' },
      modified: { letter: 'M', label: 'itemModified', tone: 'warn' },
      deleted: { letter: 'D', label: 'itemDeleted', tone: 'bad' },
      replaced: { letter: 'R', label: 'itemReplaced', tone: 'warn' },
      missing: { letter: '!', label: 'itemMissing', tone: 'bad' },
      conflicted: { letter: 'C', label: 'itemConflicted', tone: 'bad' },
      merged: { letter: 'G', label: 'itemMerged', tone: 'ok' },
      unversioned: { letter: '?', label: 'itemUnversioned', tone: 'muted' },
      ignored: { letter: 'I', label: 'itemIgnored', tone: 'muted' },
      obstructed: { letter: '~', label: 'itemObstructed', tone: 'bad' },
      external: { letter: 'X', label: 'itemExternal', tone: 'muted' },
      incomplete: { letter: '!', label: 'itemIncomplete', tone: 'bad' },
      normal: { letter: ' ', label: 'itemNormal', tone: 'muted' },
    };
    const itemMeta = (item) => ITEM_META[item] ?? { letter: '?', label: 'itemUnknown', tone: 'muted' };

    /** 未纳入版本控制、需要先 `svn add` 才能提交的条目。 */
    const isUnversioned = (item) => item === 'unversioned';

    /** 时间戳（ISO8601）→ 本地可读。 */
    function formatDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /** POST 一个 /shinki-svn/api 方法。 */
    function apiPost(method, sessionId, payload, signal) {
      return fetch('/shinki-svn/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, method, ...(payload ?? {}) }),
        signal,
      }).then(async (res) => {
        const body = await res.json().catch(() => ({ ok: false, error: { code: 'bad-response', message: '无效响应' } }));
        if (!res.ok || body.ok !== true) {
          const err = new Error(body?.error?.message ?? `HTTP ${res.status}`);
          err.code = body?.error?.code ?? `http-${res.status}`;
          err.needsCredentials = body?.error?.needsCredentials === true;
          err.output = body?.error?.output ?? '';
          throw err;
        }
        // host 把 "没装 svn / 不是工作副本" 这类**状态**用 200 + value.error 返回，
        // 这里翻成异常，调用方按 err.code 分支。
        if (body.value && typeof body.value === 'object' && body.value.error) {
          const err = new Error(body.value.message ?? body.value.error);
          err.code = body.value.error;
          err.output = body.value.output ?? '';
          throw err;
        }
        return body.value;
      });
    }

    /** better-sidebar 的插件设置读写（拿不到 store 时静默降级）。 */
    function readSetting(store, key, fallback) {
      try {
        const blob = store?.getPrefs?.()?.pluginSettings?.[name] ?? {};
        const v = blob[key];
        return v === undefined || v === null ? fallback : v;
      } catch { return fallback; }
    }
    function persistSetting(store, key, value) {
      try {
        if (!store || typeof store.getPrefs !== 'function' || typeof store.setPrefs !== 'function') return;
        const prefs = store.getPrefs() ?? {};
        const pluginSettings = { ...(prefs.pluginSettings ?? {}) };
        pluginSettings[name] = { ...(pluginSettings[name] ?? {}), [key]: value };
        store.setPrefs({ ...prefs, pluginSettings });
      } catch { /* 忽略 */ }
    }

    // ── styles ───────────────────────────────────────────────────────────
    // 取色用宿主主题 token（--dsw-alias-*），深浅色由宿主的
    // body[data-ds-dark-theme] 切换；只有少量语义色按主题各给一套值。
    const CSS = `
.ssg-root{display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary);height:100%;min-height:0;padding:2px}
.ssg-root *{box-sizing:border-box}
.ssg-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ssg-spacer{flex:1 1 auto}
.ssg-select,.ssg-input,.ssg-textarea{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 6px;font-size:12px;font-family:inherit}
.ssg-select{max-width:46%}
.ssg-textarea{width:100%;min-height:52px;resize:vertical;line-height:1.45}
.ssg-input{width:100%}
.ssg-btn{display:inline-flex;align-items:center;gap:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;font-family:inherit}
.ssg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ssg-btn:disabled{opacity:.5;cursor:default}
.ssg-btn--primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.ssg-btn--icon{padding:3px 5px}
.ssg-badge{display:inline-flex;align-items:center;gap:3px;border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px;border:1px solid transparent;white-space:nowrap}
.ssg-badge--ok{color:var(--ssg-ok);background:var(--ssg-ok-bg);border-color:var(--ssg-ok-line)}
.ssg-badge--warn{color:var(--ssg-warn);background:var(--ssg-warn-bg);border-color:var(--ssg-warn-line)}
.ssg-badge--bad{color:var(--ssg-bad);background:var(--ssg-bad-bg);border-color:var(--ssg-bad-line)}
.ssg-badge--muted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.ssg-rev{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary)}
.ssg-ver{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ssg-note{border-radius:6px;padding:5px 8px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.ssg-note--ok{color:var(--ssg-ok);background:var(--ssg-ok-bg);border:1px solid var(--ssg-ok-line)}
.ssg-note--bad{color:var(--ssg-bad);background:var(--ssg-bad-bg);border:1px solid var(--ssg-bad-line)}
.ssg-note--info{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.ssg-section{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;min-height:0}
.ssg-section>header{display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600}
.ssg-list{list-style:none;margin:0;padding:0;overflow:auto;max-height:240px;min-height:0}
.ssg-row{display:flex;align-items:flex-start;gap:6px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);cursor:default}
.ssg-row:last-child{border-bottom:none}
.ssg-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ssg-row--log{cursor:pointer;flex-direction:column;gap:2px}
.ssg-rowmain{display:flex;align-items:baseline;gap:6px;width:100%}
.ssg-msg{flex:1 1 auto;word-break:break-word}
.ssg-meta{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:11px}
.ssg-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;flex:1 1 auto}
.ssg-paths{margin:2px 0 2px 18px;padding:0;list-style:none;width:100%}
.ssg-paths li{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;display:flex;gap:5px}
.ssg-act{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.ssg-authbox{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-2)}
.ssg-field{display:flex;flex-direction:column;gap:3px}
.ssg-field>label{color:var(--dsw-alias-label-secondary)}
.ssg-check{display:flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary)}
.ssg-pre{margin:0;padding:6px 8px;max-height:180px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:6px}
:root{--ssg-ok:#1a7f37;--ssg-ok-bg:rgba(26,127,55,.10);--ssg-ok-line:rgba(26,127,55,.40);
--ssg-warn:#9a6700;--ssg-warn-bg:rgba(154,103,0,.12);--ssg-warn-line:rgba(154,103,0,.40);
--ssg-bad:#cf222e;--ssg-bad-bg:rgba(207,34,46,.10);--ssg-bad-line:rgba(207,34,46,.40)}
body[data-ds-dark-theme],html[data-ds-dark-theme]{--ssg-ok:#7ee787;--ssg-ok-bg:rgba(46,160,67,.18);--ssg-ok-line:rgba(126,231,135,.45);
--ssg-warn:#d29922;--ssg-warn-bg:rgba(210,153,34,.16);--ssg-warn-line:rgba(210,153,34,.45);
--ssg-bad:#ff7b72;--ssg-bad-bg:rgba(248,81,73,.16);--ssg-bad-line:rgba(255,123,114,.45)}
`;
    function injectCss() {
      const existing = document.querySelector(`style[data-dsh-plugin="${name}"]`);
      const style = existing ?? document.createElement('style');
      if (!existing) {
        style.dataset.dshPlugin = name;
        document.head.appendChild(style);
      }
      // 每次都覆写：client 半包被热更后 apply() 会重跑，而 <style> 元素是复用的，
      // 只在 "不存在时创建" 会让改动过的 CSS 永远不生效。
      if (style.textContent !== CSS) style.textContent = CSS;
    }

    // ── main tab ─────────────────────────────────────────────────────────
    const fileIcon = h(Icons.IconFile, { size: 13 });

    function SvnTab({ ctx, scope, sidebarStore }) {
      const sessionId = scope?.sessionId ?? '';

      const [phase, setPhase] = useState('loading'); // loading|ready|not-wc|svn-missing|no-session|error
      const [repos, setRepos] = useState([]);
      const [repoPath, setRepoPath] = useState('');
      const [repoInfo, setRepoInfo] = useState(null);
      const [logEntries, setLogEntries] = useState([]);
      const [statusEntries, setStatusEntries] = useState([]);
      const [selected, setSelected] = useState(() => new Set());
      const [expanded, setExpanded] = useState(() => new Set());
      const [message, setMessage] = useState('');
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState(null);
      const [output, setOutput] = useState('');
      const [limit, setLimit] = useState(() => {
        const n = Number(readSetting(sidebarStore, 'limit', 20));
        return Number.isFinite(n) && n > 0 ? n : 20;
      });

      // 认证状态：默认走系统凭据，不向 host 发送账号密码。
      const [authState, setAuthState] = useState({ available: false, detail: '', url: '' });
      const [authOpen, setAuthOpen] = useState(false);
      const [authForced, setAuthForced] = useState(false); // 系统凭据失败后强制显示
      const [username, setUsername] = useState('');
      const [password, setPassword] = useState('');
      const [saveCreds, setSaveCreds] = useState(false);
      const [trustCert, setTrustCert] = useState(false);

      const [tick, setTick] = useState(0);
      const refresh = () => setTick((n) => n + 1);
      const aliveRef = useRef(true);
      useEffect(() => () => { aliveRef.current = false; }, []);

      /** 发给 host 的认证信息：有账号密码才带，否则让 host 走系统凭据链。 */
      const authPayload = () => {
        const a = { noCache: !saveCreds, trustCert };
        if (username.trim() !== '' || password !== '') {
          a.username = username;
          a.password = password;
        }
        return a;
      };

      /** 统一的错误处理：认证失败 → 弹出账号密码框。 */
      const handleError = (err) => {
        if (err?.needsCredentials === true) {
          setAuthForced(true);
          setAuthOpen(true);
          setAuthState((prev) => ({ ...prev, available: false, detail: '系统凭据不可用，请输入账号密码' }));
          setNote({ kind: 'info', text: '系统凭据不可用，请点击「需要登录」输入账号密码。' });
          return;
        }
        if (err?.output) setOutput(err.output);
        setNote({ kind: 'bad', text: `${err?.code ? `[${err.code}] ` : ''}${err?.message ?? String(err)}` });
      };

      // 工作副本探测 + 日志 + 状态 + 认证探测
      useEffect(() => {
        if (sessionId === '') { setPhase('no-session'); return undefined; }
        const controller = new AbortController();
        let cancelled = false;
        (async () => {
          setPhase('loading');
          try {
            const init = await apiPost('init', sessionId, { repoPath }, controller.signal);
            if (cancelled) return;
            if (init.svnMissing === true) {
              setPhase('svn-missing');
              setNote({ kind: 'bad', text: init.message ?? t('svnMissing') });
              return;
            }
            setRepos(Array.isArray(init.subrepos) ? init.subrepos : []);
            if (init.isWc !== true) {
              setPhase('not-wc');
              setRepoInfo(null);
              setLogEntries([]);
              setStatusEntries([]);
              setNote(null);
              return;
            }
            setRepoInfo(init);
            setPhase('ready');
            setNote(null);

            // 认证探测（不带凭据）：面板据此显示"系统凭据可用 / 需要登录"。
            apiPost('authStatus', sessionId, { repoPath, auth: authPayload() }, controller.signal)
              .then((st) => { if (!cancelled) setAuthState(st); })
              .catch(() => { /* 探测失败不影响主流程 */ });

            const [log, status] = await Promise.all([
              apiPost('log', sessionId, { repoPath, limit, auth: authPayload() }, controller.signal),
              apiPost('status', sessionId, { repoPath, auth: authPayload() }, controller.signal),
            ]);
            if (cancelled) return;
            setLogEntries(log.entries ?? []);
            setStatusEntries(status.entries ?? []);
            setSelected(new Set());
            setAuthForced(false);
          } catch (error) {
            if (cancelled || error?.name === 'AbortError') return;
            if (error?.code === 'not-wc' || error?.code === 'svn-missing') {
              setPhase(error.code);
              setNote({ kind: 'bad', text: error.message });
              return;
            }
            if (error?.needsCredentials === true) {
              setPhase('ready');
              setRepoInfo((prev) => prev ?? {});
              setAuthForced(true);
              setAuthOpen(true);
              setNote({ kind: 'info', text: '系统凭据不可用，请输入账号密码。' });
              return;
            }
            setPhase('error');
            handleError(error);
          }
        })();
        return () => { cancelled = true; controller.abort(); };
        // 依赖里**故意不含** username/password/saveCreds/trustCert：它们是"用户正在
        // 输入"的中间态，若进依赖则每敲一个字符都会重新拉取。凭据生效通过「应用」
        // 按钮 → refresh() 触发 tick 变化来实现。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, repoPath, limit, tick]);

      const wc = repoInfo ?? {};
      const unversionedPaths = statusEntries.filter((e) => isUnversioned(e.item)).map((e) => e.path);
      const selectedPaths = statusEntries.filter((e) => selected.has(e.path)).map((e) => e.path);
      const selectedUnversioned = statusEntries
        .filter((e) => selected.has(e.path) && isUnversioned(e.item))
        .map((e) => e.path);

      const toggle = (p) => setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(p)) next.delete(p); else next.add(p);
        return next;
      });
      const toggleExpand = (rev) => setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rev)) next.delete(rev); else next.add(rev);
        return next;
      });

      /** 跑一个动作：置 busy、清提示、结束后刷新。 */
      const act = async (label, fn) => {
        if (busy !== '') return;
        setBusy(label);
        setNote(null);
        setOutput('');
        try {
          const result = await fn();
          const out = result?.output ?? '';
          if (out !== '') setOutput(out);
          const rev = result?.revision;
          let text = rev ? `${t('done')}（r${rev}）` : t('done');
          // 新增目录下的文件被"提升"为整目录提交时，如实告诉用户提交范围变大了。
          if (Array.isArray(result?.promoted) && result.promoted.length > 0) {
            text += ` ${t('promotedNote', { n: result.promoted.length })}`;
          }
          setNote({ kind: 'ok', text });
          if (Array.isArray(result?.conflicts) && result.conflicts.length > 0) {
            setNote({ kind: 'bad', text: `存在冲突：${result.conflicts.join('、')}` });
          }
          refresh();
        } catch (error) {
          handleError(error);
        } finally {
          setBusy('');
        }
      };

      const doPull = () => act('pull', () => apiPost('update', sessionId, { repoPath, auth: authPayload() }));
      const doAdd = () => {
        if (selectedUnversioned.length === 0) { setNote({ kind: 'info', text: t('selectFirst') }); return; }
        return act('add', () => apiPost('add', sessionId, { repoPath, paths: selectedUnversioned, auth: authPayload() }));
      };
      const doCommit = (all) => {
        if (message.trim() === '') { setNote({ kind: 'info', text: t('needMessage') }); return undefined; }
        if (!all && selectedPaths.length === 0) { setNote({ kind: 'info', text: t('selectFirst') }); return undefined; }
        const paths = all ? [] : selectedPaths;
        return act('commit', async () => {
          const result = await apiPost('commit', sessionId, { repoPath, message, paths, auth: authPayload() });
          setMessage('');
          return result;
        });
      };

      // ── render ─────────────────────────────────────────────────────────
      const renderHeader = () => h('div', { className: 'ssg-bar' },
        repos.length > 0 || (repoInfo !== null)
          ? h('select', {
              className: 'ssg-select',
              value: repoPath,
              onChange: (e) => { setRepoPath(e.target.value); setSelected(new Set()); },
              title: '工作副本',
            },
            h('option', { value: '' }, `${t('repoWorkspace')}${wc.url ? ` — ${wc.url}` : ''}`),
            repos.map((r) => h('option', { key: r.path, value: r.path }, `${r.name} — ${r.url ?? ''}`)))
          : null,
        phase === 'ready' && wc.revision !== undefined
          ? h('span', { className: 'ssg-rev', title: `${t('revision')} ${wc.revision}` }, `r${wc.revision}`)
          : null,
        h('span', { className: 'ssg-spacer' }),
        renderAuthBadge(),
        h('span', { className: 'ssg-ver' }, `v${PLUGIN_VERSION}`),
        h('button', {
          type: 'button', className: 'ssg-btn ssg-btn--icon', title: t('refresh'),
          onClick: refresh, disabled: busy !== '',
        }, h(Icons.IconRefresh, { size: 14 })),
      );

      const renderAuthBadge = () => {
        if (authForced || authOpen) {
          return h('button', {
            type: 'button', className: 'ssg-btn', title: t('authTitle'),
            onClick: () => setAuthOpen((v) => !v),
          }, h(Icons.IconUser, { size: 13 }), t('authNeeded'));
        }
        if (authState.available === true) {
          return h('button', {
            type: 'button', className: 'ssg-badge ssg-badge--ok',
            style: { cursor: 'pointer' }, title: authState.detail || t('authSystemOk'),
            onClick: () => setAuthOpen((v) => !v),
          }, h(Icons.IconKey, { size: 12 }), t('authSystem'));
        }
        return h('button', {
          type: 'button', className: 'ssg-badge ssg-badge--warn',
          style: { cursor: 'pointer' }, title: authState.detail || '',
          onClick: () => setAuthOpen((v) => !v),
        }, h(Icons.IconUser, { size: 12 }), t('authNeeded'));
      };

      const renderAuthForm = () => {
        if (!authOpen) return null;
        return h('div', { className: 'ssg-authbox' },
          h('div', { className: 'ssg-bar' },
            h('strong', null, t('authTitle')),
            h('span', { className: 'ssg-spacer' }),
            h('span', { className: 'ssg-meta' }, authState.detail || ''),
          ),
          h('div', { className: 'ssg-field' },
            h('label', null, t('username')),
            h('input', {
              className: 'ssg-input', type: 'text', value: username, autoComplete: 'off',
              onChange: (e) => setUsername(e.target.value),
            })),
          h('div', { className: 'ssg-field' },
            h('label', null, t('password')),
            h('input', {
              className: 'ssg-input', type: 'password', value: password, autoComplete: 'off',
              onChange: (e) => setPassword(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { setAuthOpen(false); refresh(); } },
            })),
          h('label', { className: 'ssg-check' },
            h('input', { type: 'checkbox', checked: saveCreds, onChange: (e) => setSaveCreds(e.target.checked) }),
            t('saveCreds')),
          h('label', { className: 'ssg-check' },
            h('input', { type: 'checkbox', checked: trustCert, onChange: (e) => setTrustCert(e.target.checked) }),
            t('trustCert')),
          h('div', { className: 'ssg-act' },
            h('button', {
              type: 'button', className: 'ssg-btn ssg-btn--primary',
              onClick: () => { setAuthForced(false); setAuthOpen(false); refresh(); },
            }, t('apply')),
            h('button', {
              type: 'button', className: 'ssg-btn',
              title: t('useSystem'),
              onClick: () => {
                setUsername(''); setPassword(''); setSaveCreds(false);
                setAuthForced(false); setAuthOpen(false); refresh();
              },
            }, t('useSystem')),
            h('button', {
              type: 'button', className: 'ssg-btn',
              onClick: () => { setAuthOpen(false); },
            }, t('cancel')),
          ),
        );
      };

      const renderActions = () => h('div', { className: 'ssg-act' },
        h('button', {
          type: 'button', className: 'ssg-btn', disabled: busy !== '', onClick: doPull,
        }, h(Icons.IconPull, { size: 13 }), t('pull')),
        h('button', {
          type: 'button', className: 'ssg-btn',
          disabled: busy !== '' || selectedUnversioned.length === 0,
          onClick: doAdd, title: t('add'),
        }, h(Icons.IconAdd, { size: 13 }), `${t('add')}${selectedUnversioned.length ? ` (${selectedUnversioned.length})` : ''}`),
        h('button', {
          type: 'button', className: 'ssg-btn ssg-btn--primary',
          disabled: busy !== '', onClick: () => doCommit(false),
        }, h(Icons.IconCommit, { size: 13 }), `${t('commit')}${selectedPaths.length ? ` (${selectedPaths.length})` : ''}`),
        h('button', {
          type: 'button', className: 'ssg-btn', disabled: busy !== '', onClick: () => doCommit(true),
        }, t('commitAll')),
        h('span', { className: 'ssg-spacer' }),
        h('label', { className: 'ssg-meta' }, t('count')),
        h('select', {
          className: 'ssg-select', value: String(limit),
          onChange: (e) => { const n = Number(e.target.value); setLimit(n); persistSetting(sidebarStore, 'limit', n); },
        }, [20, 50, 100].map((n) => h('option', { key: n, value: String(n) }, String(n)))),
      );

      const renderStatus = () => h('section', { className: 'ssg-section' },
        h('header', null,
          t('localChanges'),
          h('span', { className: 'ssg-badge ssg-badge--muted' }, String(statusEntries.length)),
          h('span', { className: 'ssg-spacer' }),
          h('button', {
            type: 'button', className: 'ssg-btn ssg-btn--icon', title: t('selectAll'),
            onClick: () => setSelected(new Set(statusEntries.map((e) => e.path))),
          }, t('selectAll')),
          h('button', {
            type: 'button', className: 'ssg-btn ssg-btn--icon', title: t('selectNone'),
            onClick: () => setSelected(new Set()),
          }, t('selectNone')),
        ),
        statusEntries.length === 0
          ? h('div', { className: 'ssg-note ssg-note--info', style: { margin: '6px 8px' } }, t('noChanges'))
          : h('ul', { className: 'ssg-list' }, statusEntries.map((e) => {
              const meta = itemMeta(e.item);
              return h('li', { key: e.path, className: 'ssg-row' },
                h('input', {
                  type: 'checkbox', checked: selected.has(e.path),
                  onChange: () => toggle(e.path),
                  title: e.path,
                }),
                h('span', { className: `ssg-badge ssg-badge--${meta.tone}`, title: e.item }, `${meta.letter} ${t(meta.label)}`),
                h('span', { className: 'ssg-path', title: e.path }, e.path),
                e.treeConflicted ? h('span', { className: 'ssg-badge ssg-badge--bad' }, 'tree') : null,
              );
            })),
      );

      const renderCommit = () => h('section', { className: 'ssg-section' },
        h('header', null, t('commitMessage')),
        h('div', { style: { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
          h('textarea', {
            className: 'ssg-textarea', value: message, placeholder: t('commitMessagePlaceholder'),
            onChange: (e) => setMessage(e.target.value),
          }),
          h('div', { className: 'ssg-act' },
            h('button', {
              type: 'button', className: 'ssg-btn ssg-btn--primary',
              disabled: busy !== '', onClick: () => doCommit(false),
            }, `${t('commitSelected')}${selectedPaths.length ? ` (${selectedPaths.length})` : ''}`),
            h('button', {
              type: 'button', className: 'ssg-btn', disabled: busy !== '', onClick: () => doCommit(true),
            }, t('commitAll')),
          ),
        ),
      );

      const renderLog = () => h('section', { className: 'ssg-section' },
        h('header', null, t('log'), h('span', { className: 'ssg-badge ssg-badge--muted' }, String(logEntries.length))),
        logEntries.length === 0
          ? h('div', { className: 'ssg-note ssg-note--info', style: { margin: '6px 8px' } }, t('noLog'))
          : h('ul', { className: 'ssg-list', style: { maxHeight: '320px' } }, logEntries.map((e) => {
              const open = expanded.has(e.revision);
              return h('li', {
                key: e.revision, className: 'ssg-row ssg-row--log',
                onClick: () => toggleExpand(e.revision),
                title: open ? '' : t('paths'),
              },
                h('div', { className: 'ssg-rowmain' },
                  h('span', { className: 'ssg-rev' }, `r${e.revision}`),
                  h('span', { className: 'ssg-msg' }, e.message || '(无提交说明)'),
                ),
                h('div', { className: 'ssg-rowmain' },
                  h('span', { className: 'ssg-meta' }, e.author || ''),
                  h('span', { className: 'ssg-meta' }, formatDate(e.date)),
                  h('span', { className: 'ssg-spacer' }),
                  e.paths.length > 0
                    ? h('span', { className: 'ssg-badge ssg-badge--muted' }, `${e.paths.length} ${t('paths')}`)
                    : null,
                ),
                open && e.paths.length > 0
                  ? h('ul', { className: 'ssg-paths' }, e.paths.map((p, i) => h('li', { key: `${p.path}-${i}` },
                      h('span', {
                        className: `ssg-badge ssg-badge--${p.action === 'D' ? 'bad' : p.action === 'A' ? 'ok' : 'warn'}`,
                      }, p.action),
                      h('span', null, p.path),
                    )))
                  : null,
              );
            })),
      );

      const renderBody = () => {
        if (phase === 'no-session') {
          return h('div', { className: 'ssg-note ssg-note--info' }, t('noSession'));
        }
        if (phase === 'svn-missing') {
          return h('div', { className: 'ssg-note ssg-note--bad' }, note?.text ?? t('svnMissing'));
        }
        if (phase === 'loading') {
          return h('div', { className: 'ssg-note ssg-note--info' }, t('loading'));
        }
        if (phase === 'not-wc') {
          return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { className: 'ssg-note ssg-note--info' }, `${t('notWc')}\n${t('notWcHint')}`),
            repos.length > 0
              ? h('section', { className: 'ssg-section' },
                  h('header', null, '子目录工作副本'),
                  h('ul', { className: 'ssg-list' }, repos.map((r) => h('li', { key: r.path, className: 'ssg-row' },
                    fileIcon,
                    h('span', { className: 'ssg-path' }, r.name),
                    h('span', { className: 'ssg-meta' }, `r${r.revision} ${r.url ?? ''}`),
                    h('span', { className: 'ssg-spacer' }),
                    h('button', {
                      type: 'button', className: 'ssg-btn',
                      onClick: () => setRepoPath(r.path),
                    }, '打开'),
                  ))))
              : null,
          );
        }
        if (phase === 'error') {
          return h('div', { className: 'ssg-note ssg-note--bad' }, note?.text ?? t('failed'));
        }
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', minHeight: 0 } },
          renderAuthForm(),
          note !== null ? h('div', { className: `ssg-note ssg-note--${note.kind}` }, note.text) : null,
          renderActions(),
          renderStatus(),
          renderCommit(),
          renderLog(),
          output !== ''
            ? h('section', { className: 'ssg-section' },
                h('header', null, t('output'),
                  h('span', { className: 'ssg-spacer' }),
                  h('button', { type: 'button', className: 'ssg-btn ssg-btn--icon', onClick: () => setOutput('') }, t('close'))),
                h('pre', { className: 'ssg-pre' }, output))
            : null,
        );
      };

      return h('div', { className: 'ssg-root' },
        renderHeader(),
        phase === 'ready' && wc.wcRoot
          ? h('div', { className: 'ssg-meta', title: wc.wcRoot }, wc.wcRoot)
          : null,
        busy !== '' ? h('div', { className: 'ssg-note ssg-note--info' }, `${t('working')} ${busy}`) : null,
        renderBody(),
      );
    }

    // ── plugin body ──────────────────────────────────────────────────────
    // cordis inject：未声明的属性访问会被拒（"cannot get property without
    // inject"）。betterSidebar 由 dsh-better-sidebar 的 client 半边提供。
    const inject = ['locale', 'betterSidebar'];

    function apply(ctx) {
      injectCss();
      try { ctx.locale?.register?.(NS, { zh, en }); } catch { /* locale 可选 */ }
      const service = ctx?.betterSidebar ?? (typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined);
      if (!service || typeof service.registerTab !== 'function') {
        console.warn('[dsh-shinki-svn-graph] ctx.betterSidebar 不可用（需安装 dsh-better-sidebar），侧边栏 Tab 未注册');
        return;
      }
      const off = service.registerTab({
        id: name,
        title: () => t('tabTitle'),
        icon: (size) => h(Icons.IconBranch, { size }),
        order: 26,
        single: true,
        settings: {
          pluginToggles: [
            {
              key: 'limit',
              type: 'select',
              title: () => t('count'),
              options: [20, 50, 100].map((n) => ({ value: n, title: () => String(n) })),
            },
          ],
        },
        component: (props) => h(SvnTab, {
          ctx,
          scope: props.scope,
          sidebarStore: props.store,
        }),
      });
      ctx.effect?.(() => () => { try { off(); } catch { /* 忽略 */ } }, 'dsh-shinki-svn-graph: sidebar tab');
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    // 仅供 Node 侧单测使用（浏览器半包没有别的导出通道；宿主不读这里）。
    exports.__internals = { SvnTab, apiPost, itemMeta, formatDate, isUnversioned };
    return module.exports;
  },
});
