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

test('面板组件可渲染（ready 态：仓库选择 + 改动 + 日志）', async () => {
  const { exports, state } = await loadClient();
  // 按 useState 调用顺序预置初值：0 phase, 1 repos, 2 repoPath, 3 repoInfo,
  // 4 logEntries, 5 statusEntries, ... 13 limit, 14 authState
  const hooks = [];
  hooks[0] = 'ready';
  hooks[1] = [{ name: 'PROJ-A', path: 'PROJ-A', url: 'http://svn.example.com/repo/group/sub/PROJ-A', revision: 2803 }];
  hooks[2] = '';
  hooks[3] = { isWc: true, wcRoot: '/work/PROJ-A', url: 'http://svn.example.com/repo/group/sub/PROJ-A', revision: 2803 };
  hooks[4] = [{ revision: 2803, author: 'alice', date: '2026-10-02T15:41:29Z', message: '更新固件', paths: [{ action: 'A', path: '/x/y.bin' }] }];
  hooks[5] = [{ path: 'proja/new.bin', item: 'unversioned', props: 'none', revision: -1, copied: false, treeConflicted: false, movedFrom: '' }];
  hooks[6] = new Set(['proja/new.bin']);
  hooks[7] = new Set([2803]);
  hooks[8] = '提交说明';
  hooks[9] = '';
  hooks[10] = { kind: 'ok', text: '完成' };
  hooks[11] = 'svn 输出';
  hooks[12] = 20;
  hooks[13] = { available: true, detail: '系统凭据可用', url: 'http://svn.example.com/repo' };
  hooks[14] = false;
  hooks[15] = false;
  hooks[16] = '';
  hooks[17] = '';
  hooks[18] = false;
  hooks[19] = false;
  hooks[20] = 0;
  state.hooks = hooks;
  const tree = exports.__internals.SvnTab({ scope: { sessionId: 'acme' } });
  assert.equal(tree.type, 'div');
  // 渲染产物里应出现关键文案（默认 20 条的日志、认证徽标、未纳入版本控制的条目）
  const text = JSON.stringify(tree, (k, v) => (k === 'onChange' || k === 'onClick' || k === 'onKeyDown' ? undefined : v));
  assert.match(text, /SVN|本地改动/);
  assert.match(text, /proja\/new\.bin/);
  assert.match(text, /2803/);
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
