/**
 * client.js（浏览器半边）加载测试。
 *
 * 浏览器半包是 **classic script**（`window.__ModuleLoader__.load({id, factory})`），
 * 不是 ESM，Node 里没有 window/React/document —— 因此这里用替身把三者补上，
 * 只验证插件契约本身：
 *   · factory 能加载、返回的 exports 有 name/inject/apply
 *   · inject 是 **cordis 服务名**（locale / betterSidebar），不是 npm 包名
 *   · apply(ctx) 会通过 ctx.betterSidebar.registerTab 注册面板，且描述符形状正确
 *   · 面板组件能真实渲染一遍（用最小 hooks 替身），不抛异常
 *   · 无 betterSidebar 服务时只告警、不抛错（降级而不是崩掉整个 web boot）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/** 最小 React 替身：createElement 产树，hooks 由外部 hookState 驱动。 */
function makeReactHarness() {
  const state = { hooks: [], index: 0 };
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(init) {
      const i = state.index++;
      if (!(i in state.hooks)) state.hooks[i] = typeof init === 'function' ? init() : init;
      return [state.hooks[i], (v) => { state.hooks[i] = typeof v === 'function' ? v(state.hooks[i]) : v; }];
    },
    useEffect() { /* 渲染测试不跑副作用 */ },
    useRef(init) { const i = state.index++; if (!(i in state.hooks)) state.hooks[i] = { current: init }; return state.hooks[i]; },
    reset(seed) { state.index = 0; if (seed) state.hooks = seed; },
  };
  return { react, state };
}

/** 装好 window/document/navigator 再加载 client.js，返回 {exports, registry}。 */
async function loadClient(seedHooks) {
  const { react, state } = makeReactHarness();
  const registry = { tabs: [], styles: [] };
  const styleEl = { dataset: {}, textContent: '' };
  globalThis.window = {
    __ModuleLoader__: {
      load(reg) { registry.reg = reg; },
    },
  };
  // Node 22 起 globalThis.navigator 是只读 getter，必须用 defineProperty 覆盖。
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
  globalThis.document = {
    querySelector: () => null,
    createElement: () => styleEl,
    head: { appendChild: (el) => registry.styles.push(el) },
  };
  // 每个用例都重新执行一次脚本（缓存里的是同一个模块对象，重新 import 不会重跑，
  // 所以这里用 query 参数打破缓存）。
  await import(`${pathToFileURL(CLIENT).href}?t=${Date.now()}${Math.random()}`);
  assert.ok(registry.reg, 'window.__ModuleLoader__.load 必须被调用');
  assert.equal(registry.reg.id, 'dsh-shinki-svn-graph');
  const exports = registry.reg.factory((spec) => {
    if (spec === 'react') return react;
    throw new Error(`unexpected require: ${spec}`);
  });
  return { exports, registry, react, state, styleEl, reset: react.reset };
}

test('client bundle 通过 __ModuleLoader__.load 注册且 id = 包名', async () => {
  const { exports } = await loadClient();
  assert.equal(exports.name, 'dsh-shinki-svn-graph');
  assert.equal(typeof exports.apply, 'function');
});

test('exports.inject 是 cordis 服务名，不是 npm 包名', async () => {
  const { exports } = await loadClient();
  assert.deepEqual([...exports.inject].sort(), ['betterSidebar', 'locale']);
  for (const s of exports.inject) assert.ok(!s.startsWith('@'), `${s} 看起来是 npm 包名`);
});

test('apply() 注册侧边栏 Tab，描述符形状符合 betterSidebar 契约', async () => {
  const { exports, registry } = await loadClient();
  const disposers = [];
  const ctx = {
    locale: { register: () => () => {} },
    betterSidebar: { registerTab: (desc) => { registry.tabs.push(desc); return () => {}; } },
    effect: (fn) => { disposers.push(fn); },
  };
  exports.apply(ctx);
  assert.equal(registry.tabs.length, 1);
  const tab = registry.tabs[0];
  assert.equal(tab.id, 'dsh-shinki-svn-graph');
  assert.equal(typeof tab.title, 'function');
  assert.equal(typeof tab.title(), 'string');
  assert.equal(tab.single, true);
  assert.equal(typeof tab.order, 'number');
  assert.equal(typeof tab.icon, 'function');
  assert.equal(typeof tab.component, 'function');
  assert.ok(tab.settings?.pluginToggles?.length > 0, '应有声明式设置项');
  // 样式已注入且带 data-dsh-plugin 标记（HMR 复查靠它复用同一个 <style>）
  assert.equal(registry.styles.length, 1);
  assert.equal(registry.styles[0].dataset.dshPlugin, 'dsh-shinki-svn-graph');
  assert.match(registry.styles[0].textContent, /\.ssg-root/);
});

test('缺少 betterSidebar 服务时只告警、不抛错（降级）', async () => {
  const { exports } = await loadClient();
  const warnings = [];
  const original = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    exports.apply({ locale: { register: () => () => {} }, effect: () => {} });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /betterSidebar/);
});

test('面板组件可渲染（loading 初始态）', async () => {
  const { exports } = await loadClient();
  const tree = exports.__internals.SvnTab({ scope: { sessionId: 'acme' } });
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'ssg-root');
});

/**
 * SvnTab 里 useState/useRef 的**声明顺序**。测试靠索引播种 hooks，所以顺序一变
 * 播种就会错位——过去因此静默失效过（新增 state 后断言仍"通过"）。这里显式列出
 * 顺序，并在渲染后断言消费数量一致，任何增删都会立刻炸出来。
 */
const HOOK_ORDER = [
  'phase', 'repos', 'repoPath', 'repoInfo', 'rootInfo',
  'logEntries', 'statusEntries', 'selected', 'expanded', 'message', 'allowEmpty',
  'busy', 'note', 'output', 'limit', 'authState', 'authOpen', 'authForced',
  'username', 'password', 'saveCreds', 'trustCert', 'tick',
  'aliveRef', // useRef(aliveRef)，声明在 tick 之后
];

/** 用名字播种，避免直接摆弄索引。 */
function seedHooks(state, values) {
  const hooks = [];
  for (const [name, value] of Object.entries(values)) {
    const index = HOOK_ORDER.indexOf(name);
    assert.notEqual(index, -1, `未知的状态名 ${name}（需同步 HOOK_ORDER）`);
    hooks[index] = value;
  }
  state.hooks = hooks;
}

test('面板组件可渲染（ready 态：仓库选择 + 改动 + 日志）', async () => {
  const { exports, state } = await loadClient();
  seedHooks(state, {
    phase: 'ready',
    repos: [{ name: 'PROJ-A', path: 'PROJ-A', url: 'http://svn.example.com/repo/group/sub/PROJ-A', revision: 2803 }],
    repoPath: '',
    repoInfo: { isWc: true, wcRoot: '/work/PROJ-A', url: 'http://svn.example.com/repo/group/sub/PROJ-A', revision: 2803 },
    rootInfo: { isWc: false },
    logEntries: [{ revision: 2803, author: 'alice', date: '2026-10-02T15:41:29Z', message: '更新固件', paths: [{ action: 'A', path: '/x/y.bin' }] }],
    statusEntries: [{ path: 'proja/new.bin', item: 'unversioned', props: 'none', revision: -1, copied: false, treeConflicted: false, movedFrom: '' }],
    selected: new Set(['proja/new.bin']),
    expanded: new Set([2803]),
    message: '提交说明',
    allowEmpty: false,
    note: { kind: 'ok', text: '完成' },
    output: 'svn 输出',
    limit: 20,
    authState: { available: true, detail: '系统凭据可用', url: 'http://svn.example.com/repo' },
  });
  const tree = exports.__internals.SvnTab({ scope: { sessionId: 'acme' } });
  assert.equal(tree.type, 'div');
  assert.equal(state.index, HOOK_ORDER.length, 'hook 顺序/数量与 HOOK_ORDER 不一致（组件加了 state？）');
  const text = JSON.stringify(tree, (k, v) => (k === 'onChange' || k === 'onClick' || k === 'onKeyDown' ? undefined : v));
  assert.match(text, /SVN|本地改动/);
  assert.match(text, /proja\/new\.bin/);
  assert.match(text, /2803/);
  // 未进入子目录 → 不应出现"返回"入口
  assert.doesNotMatch(text, /返回/);
});

test('进入子目录后出现"返回"入口，且根选项不再借用子目录的 URL', async () => {
  const { exports, state } = await loadClient();
  const subUrl = 'http://svn.example.com/repo/ble';
  seedHooks(state, {
    phase: 'ready',
    repos: [{ name: 'ble', path: 'ble', url: subUrl, revision: 2803 }],
    repoPath: 'ble',                                    // ← 已进入子目录
    repoInfo: { isWc: true, wcRoot: '/work/ble', url: subUrl, revision: 2803 },
    rootInfo: { isWc: false },                          // 工作区根不是工作副本
    logEntries: [],
    statusEntries: [],
  });
  const tree = exports.__internals.SvnTab({ scope: { sessionId: 'acme' } });
  const text = JSON.stringify(tree, (k, v) => (k === 'onChange' || k === 'onClick' || k === 'onKeyDown' ? undefined : v));
  // 根不是工作副本 → 返回按钮文案是"返回子目录列表"
  assert.match(text, /返回子目录列表/);
  // 根选项标签不得出现子目录的 URL（历史 bug：根选项借用了当前 wc.url）
  const options = JSON.stringify(tree).match(/"工作区根目录[^"]*"/g) ?? [];
  assert.ok(options.length > 0, '应有根选项');
  for (const o of options) assert.ok(!o.includes(subUrl), `根选项不应带子目录 URL：${o}`);
});

test('工作区根本身是工作副本时，返回文案为"返回工作区根目录"', async () => {
  const { exports, state } = await loadClient();
  seedHooks(state, {
    phase: 'ready',
    repos: [{ name: 'ble', path: 'ble', url: 'http://svn.example.com/repo/ble', revision: 2803 }],
    repoPath: 'ble',
    repoInfo: { isWc: true, wcRoot: '/work/ble', url: 'http://svn.example.com/repo/ble', revision: 2803 },
    rootInfo: { isWc: true, wcRoot: '/work', url: 'http://svn.example.com/repo', revision: 2800 },
    logEntries: [],
    statusEntries: [],
  });
  const tree = exports.__internals.SvnTab({ scope: { sessionId: 'acme' } });
  const text = JSON.stringify(tree, (k, v) => (k === 'onChange' || k === 'onClick' || k === 'onKeyDown' ? undefined : v));
  assert.match(text, /返回工作区根目录/);
});

test('内部工具：itemMeta / formatDate / isUnversioned', async () => {
  const { exports } = await loadClient();
  const { itemMeta, formatDate, isUnversioned } = exports.__internals;
  assert.equal(itemMeta('unversioned').letter, '?');
  assert.equal(itemMeta('modified').letter, 'M');
  assert.equal(itemMeta('conflicted').tone, 'bad');
  assert.equal(itemMeta('something-new').letter, '?');
  assert.equal(isUnversioned('unversioned'), true);
  assert.equal(isUnversioned('added'), false);
  assert.equal(formatDate('2026-10-02T15:41:29Z').length, 16);
  assert.equal(formatDate(''), '');
  assert.equal(formatDate('not-a-date'), 'not-a-date');
});

test('client.js 里没有 ESM import 语法（必须是 classic script 形态）', () => {
  const source = readFileSync(CLIENT, 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false, '浏览器半包不能出现 import 语句');
  assert.equal(/\bexport\s+(const|function|default)\b/.test(source), false, '导出只能经 module.exports');
  assert.match(source, /window\.__ModuleLoader__\.load\(/);
});

test('host 路由前缀与 client 里的 fetch 路径一致', async () => {
  const source = readFileSync(CLIENT, 'utf8');
  const m = source.match(/fetch\('([^']+)'/);
  assert.notEqual(m, null);
  assert.equal(m[1], '/shinki-svn/api');
  const host = readFileSync(fileURLToPath(new URL('../lib/routes.js', import.meta.url)), 'utf8');
  assert.match(host, new RegExp(`API_PATH\\s*=\\s*'${m[1]}'`));
});
