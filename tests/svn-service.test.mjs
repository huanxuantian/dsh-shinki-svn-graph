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
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateRelPath, authArgs, hasExplicitCredentials, isAuthFailure, classifySvnError,
  createSvnService, SvnCommandError,
  E_AUTH, E_NOT_WC, E_BAD_REQUEST, E_FORBIDDEN,
} from '../lib/svn-service.js';
import { resolveSvnBinary } from '../lib/svn-runner.js';

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
  return execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
