/**
 * svn-service 单测：纯函数（路径校验、认证装配、错误归类）+ 一个**真实本地
 * 版本库**的端到端用例（svnadmin create → checkout → add → commit → log → update）。
 *
 * 端到端用 `file://` 本地库，不需要网络与凭据，因此 CI/离线都可跑；
 * 认证相关的行为由纯函数测试覆盖（避免依赖具体机器上的钥匙串）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateRelPath, authArgs, hasExplicitCredentials, isAuthFailure, classifySvnError,
  createSvnService, SvnCommandError,
  E_AUTH, E_NOT_WC, E_BAD_REQUEST, E_FORBIDDEN,
} from '../lib/svn-service.js';
import { resolveSvnBinary, utf8LocaleOverride } from '../lib/svn-runner.js';

// ── 纯函数 ────────────────────────────────────────────────────────────────

test('validateRelPath 接受副本内相对路径', () => {
  for (const p of ['a.bin', 'proja/a.bin', 'a/b/c.bin', '带中文/文件.bin']) {
    assert.equal(validateRelPath(p), true, p);
  }
});

test('validateRelPath 拒绝越界与危险路径', () => {
  for (const p of ['', '../x', 'a/../../x', '/abs/x', 'a\\b', 'C:/x', '-rf', 'a\0b', null, 42]) {
    assert.equal(validateRelPath(p), false, String(p));
  }
});

test('authArgs：默认走系统凭据链（不加 --no-auth-cache，不带账号）', () => {
  const { args, stdin } = authArgs({});
  assert.deepEqual(args, ['--non-interactive']);
  assert.equal(stdin, undefined);
});

test('authArgs：显式账号时用户名进 argv、密码进 stdin', () => {
  const { args, stdin } = authArgs({ username: 'sket', password: 'sket' });
  assert.ok(args.includes('--username'));
  assert.ok(args.includes('sket'));
  // 关键安全性质：密码绝不出现在 argv 里
  assert.ok(!args.includes('sket-super-secret'));
  const withPass = authArgs({ username: 'u', password: 'u-super-secret' });
  assert.ok(!withPass.args.some((a) => String(a).includes('u-super-secret')));
  assert.ok(withPass.args.includes('--password-from-stdin'));
  assert.equal(withPass.stdin, 'u-super-secret\n');
});

test('authArgs：noCache 显式为 true 时才禁用凭据缓存', () => {
  assert.ok(authArgs({ noCache: true }).args.includes('--no-auth-cache'));
  assert.ok(!authArgs({ noCache: false }).args.includes('--no-auth-cache'));
  assert.ok(!authArgs({}).args.includes('--no-auth-cache'));
});

test('authArgs：trustCert 展开为 trust-server-cert-failures', () => {
  const { args } = authArgs({ trustCert: true });
  assert.ok(args.some((a) => a.startsWith('--trust-server-cert-failures=')));
});

test('hasExplicitCredentials', () => {
  assert.equal(hasExplicitCredentials({}), false);
  assert.equal(hasExplicitCredentials({ username: '  ' }), false);
  assert.equal(hasExplicitCredentials({ password: '' }), false);
  assert.equal(hasExplicitCredentials({ username: 'u' }), true);
  assert.equal(hasExplicitCredentials({ password: 'p' }), true);
});

test('isAuthFailure 只认认证类失败', () => {
  assert.equal(isAuthFailure({ exitCode: 0, stdout: '', stderr: '' }), false);
  assert.equal(isAuthFailure({ exitCode: 1, stdout: '', stderr: 'svn: E170001: Authentication failed' }), true);
  assert.equal(isAuthFailure({ exitCode: 1, stdout: 'svn: E215004: No more credentials', stderr: '' }), true);
  assert.equal(isAuthFailure({ exitCode: 1, stdout: '', stderr: 'svn: E155007: not a working copy' }), false);
});

test('classifySvnError 把 svn 错误码映射为稳定 code', () => {
  assert.equal(classifySvnError('svn: E170001: Authentication failed').code, E_AUTH);
  assert.equal(classifySvnError('svn: E155007: /x is not a working copy').code, E_NOT_WC);
  assert.equal(classifySvnError("svn: E175013: Access to '/svn/x' forbidden").code, E_FORBIDDEN);
  assert.equal(classifySvnError('svn: E155015: conflict').code, 'svn-conflict');
  assert.equal(classifySvnError('svn: E170013: Unable to connect to a repository').code, 'svn-connect');
  assert.equal(classifySvnError('svn: E155004: locked').code, 'wc-locked');
  assert.equal(classifySvnError('something else').code, 'svn-error');
  assert.ok(classifySvnError('x') instanceof SvnCommandError);
});

test('authArgs 不泄漏密码进命令行的回归断言', () => {
  // 这条断言是本插件最重要的安全性质，单独钉死：任何改动若把密码放回 argv 都会红。
  const secret = 'p@ss word-42';
  const { args, stdin } = authArgs({ username: 'u', password: secret });
  assert.equal(args.filter((a) => a.includes('p@ss')).length, 0);
  assert.equal(stdin, `${secret}\n`);
});

// ── 端到端（本地 file:// 版本库）─────────────────────────────────────────

const svnBin = resolveSvnBinary();

/** svnadmin 与 svn 同目录。 */
function svnadminPath() {
  return svnBin === null ? null : path.join(path.dirname(svnBin), process.platform === 'win32' ? 'svnadmin.exe' : 'svnadmin');
}

function run(bin, args, cwd) {
  // 与插件一致：测试自身调 svn 时也必须补 UTF-8 字符集，否则中文路径同样会乱码。
  const env = { ...process.env, ...utf8LocaleOverride(process.env) };
  return execFileSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('端到端：探测/日志/状态/添加/提交/拉取（本地仓库）', { skip: svnBin === null || !existsSync(svnadminPath() ?? '') }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-svn-test-'));
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  try {
    run(svnadminPath(), ['create', repo], root);
    run(svnBin, ['checkout', `${pathToFileURL(repo).href}`, wc], root);

    const svc = createSvnService({ logger: { warn: () => {} } });

    // 探测：是工作副本 / 不是工作副本
    const probed = await svc.probe(wc);
    assert.notEqual(probed, null);
    assert.equal(probed.url.startsWith('file://'), true);
    assert.equal(await svc.probe(path.join(root, 'repo')), null, 'svnadmin 库目录不是工作副本');
    assert.equal(await svc.probe(tmpdir()), null);

    // 新增文件 → status 应报 unversioned
    writeFileSync(path.join(wc, 'new.bin'), 'hello-firmware');
    let st = await svc.status(wc);
    assert.deepEqual(st.entries.map((e) => [e.path, e.item]), [['new.bin', 'unversioned']]);

    // add → status 变 added
    const added = await svc.add(wc, { paths: ['new.bin'] });
    assert.deepEqual(added.added, ['new.bin']);
    st = await svc.status(wc);
    assert.deepEqual(st.entries.map((e) => [e.path, e.item]), [['new.bin', 'added']]);

    // commit（中文说明，验证 UTF-8 经临时文件传递不乱码）
    const message = '新增固件 new.bin（中文提交说明）';
    const committed = await svc.commit(wc, { message });
    assert.equal(typeof committed.revision, 'number');
    assert.ok(committed.revision >= 1);

    // status 干净
    st = await svc.status(wc);
    assert.deepEqual(st.entries, []);

    // log：默认 20 条、含作者/时间/说明/改动路径
    const lg = await svc.log(wc, { limit: 20 });
    assert.equal(lg.entries.length, 1);
    assert.equal(lg.entries[0].message, message);
    assert.equal(lg.entries[0].paths.length, 1);
    assert.equal(lg.entries[0].paths[0].action, 'A');

    // 提交说明为空 → E_BAD_REQUEST
    await assert.rejects(() => svc.commit(wc, { message: '   ' }), (e) => e.code === E_BAD_REQUEST);

    // 非法路径 → E_BAD_REQUEST
    await assert.rejects(() => svc.add(wc, { paths: ['../escape.bin'] }), (e) => e.code === E_BAD_REQUEST);
    await assert.rejects(() => svc.add(wc, { paths: [] }), (e) => e.code === E_BAD_REQUEST);

    // update（已是最新 → At revision N）
    const up = await svc.update(wc, {});
    assert.equal(typeof up.revision, 'number');
    assert.deepEqual(up.conflicts, []);

    // 系统凭据探测：file:// 本地库无需凭据 → 可用
    const auth = await svc.systemAuthAvailable(wc);
    assert.equal(auth.available, true);
    assert.equal(auth.url.startsWith('file://'), true);

    // 非工作副本目录：status 抛 not-wc
    await assert.rejects(() => svc.status(path.join(root, 'repo')), (e) => e.code === E_NOT_WC);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('add 前置校验：目标不存在时明确报错，且不在磁盘上留下垃圾目录',
  { skip: svnBin === null || !existsSync(svnadminPath() ?? '') }, async () => {
    // 事故背景（2026-10-03）：`svn add --parents` 会创建并添加缺失的中间目录。
    // 当路径在传递过程中被转码（当年是 locale 问题）时，svn 会在磁盘上造出一个
    // 同名的空目录并排入添加队列；用户再点"提交全部"就会把它提交进版本库。
    // 现在 add 会先校验目标在磁盘上真实存在。
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-svn-guard-'));
    try {
      const repo = path.join(root, 'repo');
      const wc = path.join(root, 'wc');
      run(svnadminPath(), ['create', repo], root);
      run(svnBin, ['checkout', pathToFileURL(repo).href, wc], root);
      const svc = createSvnService({ logger: { warn: () => {} } });

      const before = readdirSync(wc).sort();
      await assert.rejects(
        () => svc.add(wc, { paths: ['并不存在的目录/文件.bin'] }),
        (e) => e.code === E_BAD_REQUEST && /不存在/.test(e.message),
      );
      assert.deepEqual(readdirSync(wc).sort(), before, '失败的 add 不得在磁盘上留下任何新条目');

      // 真实存在的路径仍然可以正常添加
      mkdirSync(path.join(wc, '真实目录'), { recursive: true });
      writeFileSync(path.join(wc, '真实目录', 'a.bin'), 'x');
      const ok = await svc.add(wc, { paths: ['真实目录/a.bin'] });
      assert.ok(ok.added.includes('真实目录/a.bin'), JSON.stringify(ok));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('提交未受控的选中项：只对勾选项自动 add（现场卡点回归）',
  { skip: svnBin === null || !existsSync(svnadminPath() ?? '') }, async () => {
    // 事故背景：用户勾选一个"未纳入版本控制"的文件直接点提交，svn 回
    // `E200009: … 尚未纳入版本控制`，对用户是死路。现在：**勾选的**未受控项会自动先 add。
    // 结构复刻真实工作副本：中文目录先受控，其中的新文件才是未受控（svn 不递归未受控目录，
    // 目录本身未受控时其中的文件根本不会出现在 status 里）。
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-svn-auto-add-'));
    try {
      const repo = path.join(root, 'repo');
      const wc = path.join(root, 'wc');
      run(svnadminPath(), ['create', repo], root);
      run(svnBin, ['checkout', pathToFileURL(repo).href, wc], root);

      mkdirSync(path.join(wc, '示例目录'), { recursive: true });
      writeFileSync(path.join(wc, '示例目录', '修改说明.txt'), 'v1');
      run(svnBin, ['add', '示例目录'], wc);
      run(svnBin, ['commit', '-m', 'init'], wc);

      // 现在目录已受控，往里面放一个未受控文件 —— 这正是真实工作副本的常见形态
      writeFileSync(path.join(wc, '示例目录', '固件.bin'), 'BIN');
      const rel = '示例目录/固件.bin';
      const svc = createSvnService({ logger: { warn: () => {} } });
      assert.equal((await svc.status(wc)).entries.find((e) => e.path === rel)?.item, 'unversioned');

      // 直接提交（不先调 add）
      const committed = await svc.commit(wc, { message: '直接提交未受控文件', paths: [rel] });
      assert.equal(typeof committed.revision, 'number');
      assert.ok(committed.revision >= 2, `提交版本号异常：${committed.revision}`);
      assert.deepEqual(committed.autoAdded, [rel], `应只自动 add 勾选项：${JSON.stringify(committed)}`);
      // 父目录已受控 → 无需提升
      assert.deepEqual(committed.committedPaths, [rel]);
      assert.deepEqual(committed.promoted, []);

      // 仓库侧确认已进库，且中文路径与中文提交说明都正常
      const lg = await svc.log(wc, { limit: 1 });
      assert.equal(lg.entries[0].message, '直接提交未受控文件');
      assert.deepEqual(lg.entries[0].paths.map((p) => p.path), ['/示例目录/固件.bin']);
      assert.deepEqual((await svc.status(wc)).entries, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('提交全部改动：必须排除未受控文件（不自动 add）',
  { skip: svnBin === null || !existsSync(svnadminPath() ?? '') }, async () => {
    // 需求（用户 2026-10-03 明确）：`paths: []`（= 面板的"提交全部改动"）
    // 只提交**已纳入版本控制**的改动，未受控文件一律排除、绝不自动 add；
    // 只有用户显式勾选的条目才自动 add。
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-svn-commit-all-'));
    try {
      const repo = path.join(root, 'repo');
      const wc = path.join(root, 'wc');
      run(svnadminPath(), ['create', repo], root);
      run(svnBin, ['checkout', pathToFileURL(repo).href, wc], root);
      writeFileSync(path.join(wc, '受控.txt'), 'v1');
      run(svnBin, ['add', '受控.txt'], wc);
      run(svnBin, ['commit', '-m', 'init'], wc);

      // 一个已受控文件的修改 + 一个未受控文件 + 一个未受控目录
      writeFileSync(path.join(wc, '受控.txt'), 'v2');
      writeFileSync(path.join(wc, '未受控.bin'), 'BIN');
      mkdirSync(path.join(wc, '新目录'), { recursive: true });
      writeFileSync(path.join(wc, '新目录', 'x.bin'), 'BIN');

      const svc = createSvnService({ logger: { warn: () => {} } });
      const committed = await svc.commit(wc, { message: '只提交受控改动', paths: [] });
      assert.ok(committed.revision >= 2);
      assert.deepEqual(committed.autoAdded, [], '提交全部不得触发任何自动 add');

      // 仓库里只有受控文件的改动；未受控的两项原样保留在本地
      const lg = await svc.log(wc, { limit: 1 });
      assert.deepEqual(lg.entries[0].paths.map((p) => p.path), ['/受控.txt']);
      const after = (await svc.status(wc)).entries.map((e) => [e.path, e.item]).sort();
      // 与 after 用同一个比较器排序，避免依赖中文的代码点顺序
      const expected = [['未受控.bin', 'unversioned'], ['新目录', 'unversioned']].sort();
      assert.deepEqual(after, expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('空提交说明：默认拦截，勾选 allowEmptyMessage 后放行',
  { skip: svnBin === null || !existsSync(svnadminPath() ?? '') }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-svn-empty-msg-'));
    try {
      const repo = path.join(root, 'repo');
      const wc = path.join(root, 'wc');
      run(svnadminPath(), ['create', repo], root);
      run(svnBin, ['checkout', pathToFileURL(repo).href, wc], root);
      const svc = createSvnService({ logger: { warn: () => {} } });

      // 默认：空说明（含纯空白）必须被拦下
      await assert.rejects(() => svc.commit(wc, { message: '   ' }), (e) => e.code === E_BAD_REQUEST);
      await assert.rejects(() => svc.commit(wc, { message: '' }), (e) => e.code === E_BAD_REQUEST);

      // 勾选后：空说明可以提交（svn 允许空说明，不需要 --force-log）
      writeFileSync(path.join(wc, '空白说明.txt'), 'v1');
      const committed = await svc.commit(wc, {
        message: '', allowEmptyMessage: true, paths: ['空白说明.txt'],
      });
      assert.equal(typeof committed.revision, 'number');
      assert.ok(committed.revision >= 1);

      // 仓库侧的提交说明确实是空串
      const lg = await svc.log(wc, { limit: 1 });
      assert.equal(lg.entries[0].message, '');
      assert.deepEqual(lg.entries[0].paths.map((p) => p.path), ['/空白说明.txt']);

      // 纯空白也放行（写进版本库的是原样的空白串）——只验证不再报错
      writeFileSync(path.join(wc, '空白说明2.txt'), 'v2');
      const c2 = await svc.commit(wc, {
        message: '   ', allowEmptyMessage: true, paths: ['空白说明2.txt'],
      });
      assert.ok(c2.revision > committed.revision);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test('端到端：一级子目录工作副本扫描', { skip: svnBin === null || !existsSync(svnadminPath() ?? '') }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-svn-scan-'));
  try {
    const repo = path.join(root, 'repo');
    run(svnadminPath(), ['create', repo], root);
    const url = pathToFileURL(repo).href;
    // 两个一级子目录：一个检出成工作副本，另一个只是普通目录
    run(svnBin, ['checkout', url, path.join(root, 'wc_a')], root);
    mkdirSync(path.join(root, 'plain'), { recursive: true });
    writeFileSync(path.join(root, 'plain', 'x.txt'), 'not a wc');

    const svc = createSvnService({ logger: { warn: () => {} } });
    const found = await svc.scanSubRepos(root);
    assert.deepEqual(found.map((r) => r.path), ['wc_a']);
    assert.equal(typeof found[0].revision, 'number');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 中文路径（locale 回归）──────────────────────────────────────────────
// 事故背景：宿主进程没有 LANG/LC_ALL（C locale）时，svn 会把 argv 里的 UTF-8
// 中文路径按当前字符集二次转换 —— 实测会变成一串乱码（各字的 UTF-8 尾字节还在、
// 前导字节被吞），于是 add/commit 直接报 E155010 找不到节点。lib/svn-runner.js 现在给子进程补
// UTF-8 的 LC_CTYPE。这两个用例就是那次事故的回归测试。

test('utf8LocaleOverride：补齐 UTF-8 字符集，且不覆盖用户已有的 UTF-8 设置', () => {
  if (process.platform === 'win32') {
    assert.deepEqual(utf8LocaleOverride({}), {}); // Windows 走 UTF-16 argv
    return;
  }
  const override = utf8LocaleOverride({});
  // LC_ALL 会压过 LC_CTYPE，必须置空才能让 LC_CTYPE 生效
  assert.equal(override.LC_ALL, '');
  assert.match(override.LC_CTYPE, /utf-?8/i);
  // 用户已显式配 UTF-8 → 尊重之，不覆盖（否则会改掉消息语言）
  assert.deepEqual(utf8LocaleOverride({ LC_ALL: 'zh_CN.UTF-8' }), {});
  assert.deepEqual(utf8LocaleOverride({ LC_CTYPE: 'en_US.UTF-8' }), {});
  // 非 UTF-8 的 LC_ALL 必须被解除
  assert.equal(utf8LocaleOverride({ LC_ALL: 'C' }).LC_ALL, '');
  assert.equal(utf8LocaleOverride({ LANG: 'C', LC_ALL: 'C' }).LC_CTYPE.includes('UTF-8'), true);
});

test('端到端：中文目录/文件名可 add + commit（locale 回归）',
  { skip: svnBin === null || !existsSync(svnadminPath() ?? '') }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-svn-cjk-'));
    try {
      const repo = path.join(root, 'repo');
      const wc = path.join(root, 'wc');
      run(svnadminPath(), ['create', repo], root);
      run(svnBin, ['checkout', pathToFileURL(repo).href, wc], root);

      // 首次提交一个中文文件，让工作副本有真实历史
      writeFileSync(path.join(wc, '说明.txt'), 'v1');
      run(svnBin, ['add', '说明.txt'], wc);
      run(svnBin, ['commit', '-m', 'init'], wc);

      // 新增中文目录 + 中文文件，模拟真实工作副本
      mkdirSync(path.join(wc, '示例目录'), { recursive: true });
      writeFileSync(path.join(wc, '示例目录', '修改说明.txt'), 'v1');
      writeFileSync(path.join(wc, '示例目录', '固件_v000018.bin'), 'BIN');

      const svc = createSvnService({ logger: { warn: () => {} } });
      const rel = '示例目录/修改说明.txt';

      // status 必须原样给出中文路径（不能被转码）。
      // 注意 svn 的行为：**未受控目录不会递归**，此时只报目录本身，不报里面的文件。
      const st = await svc.status(wc);
      assert.ok(st.entries.some((e) => e.path === '示例目录' && e.item === 'unversioned'),
        `status 应报出未受控的中文目录：${JSON.stringify(st.entries)}`);
      assert.ok(!st.entries.some((e) => e.path === rel),
        '未受控目录下的文件不应单独出现在 status 里（svn 不递归）');

      // add --parents 连带父目录 → 目录与文件都变成 added
      const added = await svc.add(wc, { paths: [rel] });
      assert.ok(added.added.includes(rel), `add 应成功：${JSON.stringify(added)}`);
      const afterAdd = await svc.status(wc);
      assert.ok(afterAdd.entries.some((e) => e.path === '示例目录' && e.item === 'added'),
        `add 后目录应为 added：${JSON.stringify(afterAdd.entries)}`);

      // 只选"新增目录下的文件"提交：svn 要求把新增目录一并放进 pathspec，
      // 服务层必须自动提升，否则报 E200009。
      const committed = await svc.commit(wc, { message: '中文提交说明', paths: [rel] });
      assert.equal(typeof committed.revision, 'number');
      assert.ok(committed.revision >= 2, `提交版本号异常：${committed.revision}`);
      assert.deepEqual(committed.committedPaths, ['示例目录']);
      assert.equal(committed.promoted.length, 1);
      assert.equal(committed.promoted[0].from, rel);
      assert.equal(committed.promoted[0].to, '示例目录');

      // 从仓库侧回读：中文路径必须原样存在（用 --xml 避开终端编码）
      const lg = await svc.log(wc, { limit: 1 });
      const paths = lg.entries[0].paths.map((p) => p.path);
      assert.deepEqual(paths, ['/示例目录', '/示例目录/修改说明.txt']);
      assert.equal(lg.entries[0].message, '中文提交说明');

      // 提交说明里的中文也不能乱码（经临时文件 + --encoding UTF-8 传递）。
      // 提交后目录里只剩那个**没被 add 过**的 .bin 仍未受控 —— 说明"提升为整目录提交"
      // 只提交了已受控内容，不会把未 add 的文件也带上去。
      const after = await svc.status(wc);
      assert.deepEqual(after.entries.map((e) => [e.path, e.item]),
        [['示例目录/固件_v000018.bin', 'unversioned']]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
