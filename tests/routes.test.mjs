/**
 * routes.js 单测：只跑 deps 注入的边界与分派逻辑（不依赖真实 svn 命令），
 * 用假的 req/res 断言状态码、错误码与响应外壳。
 */
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHandler } from '../lib/routes.js';
import { resetSessionCwdCache } from '../lib/svn-service.js';

// 会话 cwd 解析在 host 侧有缓存（生产环境里 sessionId→cwd 是稳定的）。
// 测试里同一个 sessionId 会指向不同的临时目录，因此每个用例前清缓存。
beforeEach(() => { resetSessionCwdCache(); });

function makeCtx(cwd) {
  return {
    sessions: { get: (id) => (id === 'acme' ? { header: { cwd } } : undefined) },
    webRuntime: { trustedHosts: [] },
    logger: { warn: () => {} },
    webServer: { register: () => () => {} },
    get: () => undefined,
  };
}

function makeReq(body, options = {}) {
  const {
    url = '/shinki-svn/api',
    method = 'POST',
    remote = '127.0.0.1',
    contentType = 'application/json',
    host = '127.0.0.1:30820',
  } = options;
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': contentType, host };
  req.socket = { remoteAddress: remote };
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? null; },
    end(text) { this.body = text ?? ''; },
  };
}

async function call(handler, body, options) {
  const res = makeRes();
  await handler(makeReq(body, options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* 非 JSON（405/415 空体） */ }
  return { res, json };
}

test('非回环客户端且不在信任名单 → 403', async () => {
  const handler = createHandler(makeCtx(tmpdir()));
  // 192.0.2.0/24 是 RFC 5737 保留的文档示例网段 —— 用非回环地址触发栅栏，不涉及任何真实内网
  const { res, json } = await call(handler, { method: 'init', sessionId: 'acme' }, { remote: '192.0.2.9' });
  assert.equal(res.statusCode, 403);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'forbidden');
});

test('非 POST → 405', async () => {
  const handler = createHandler(makeCtx(tmpdir()));
  const { res } = await call(handler, { method: 'init', sessionId: 'acme' }, { method: 'GET' });
  assert.equal(res.statusCode, 405);
});

test('错误的 content-type → 415', async () => {
  const handler = createHandler(makeCtx(tmpdir()));
  const { res } = await call(handler, { method: 'init', sessionId: 'acme' }, { contentType: 'text/plain' });
  assert.equal(res.statusCode, 415);
});

test('非法 JSON → 400', async () => {
  const handler = createHandler(makeCtx(tmpdir()));
  const { res, json } = await call(handler, '{not json');
  assert.equal(res.statusCode, 400);
  assert.equal(json.error.code, 'bad-request');
});

test('非法 URL 路径 → 404', async () => {
  const handler = createHandler(makeCtx(tmpdir()));
  const { res } = await call(handler, { method: 'init', sessionId: 'acme' }, { url: '/shinki-svn/other' });
  assert.equal(res.statusCode, 404);
});

test('缺少 method / sessionId → 400', async () => {
  const handler = createHandler(makeCtx(tmpdir()));
  const a = await call(handler, { sessionId: 'acme' });
  assert.equal(a.res.statusCode, 400);
  const b = await call(handler, { method: 'init' });
  assert.equal(b.res.statusCode, 400);
});

test('未知会话 → 404 session-not-found', async () => {
  const handler = createHandler(makeCtx(tmpdir()));
  const { res, json } = await call(handler, { method: 'init', sessionId: 'nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(json.error.code, 'session-not-found');
});

test('会话存在但工作区目录已消失 → 404 workspace-missing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-svn-routes-'));
  rmSync(dir, { recursive: true, force: true });
  const handler = createHandler(makeCtx(dir));
  const { res, json } = await call(handler, { method: 'init', sessionId: 'acme' });
  assert.equal(res.statusCode, 404);
  assert.equal(json.error.code, 'workspace-missing');
});

test('工作区不是工作副本 → 200 + isWc:false（状态而非故障）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-svn-routes-'));
  try {
    const handler = createHandler(makeCtx(dir));
    const { res, json } = await call(handler, { method: 'init', sessionId: 'acme' });
    // 装了 svn 的环境下应当是 200；没装 svn 时返回 svnMissing 也走 200。
    assert.equal(res.statusCode, 200);
    assert.equal(json.ok, true);
    if (json.value.svnMissing !== true) {
      assert.equal(json.value.isWc, false);
      assert.deepEqual(json.value.subrepos, []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未知方法 → 404 not-found', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-svn-routes-'));
  try {
    const handler = createHandler(makeCtx(dir));
    const { res, json } = await call(handler, { method: 'definitelyNotAMethod', sessionId: 'acme' });
    assert.equal(res.statusCode, 404);
    assert.equal(json.error.code, 'not-found');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('越界的 repoPath → 400（客户端不能把服务指向工作区之外）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-svn-routes-'));
  try {
    const handler = createHandler(makeCtx(dir));
    for (const repoPath of ['../etc', '/etc', 'a/../../b', '-x']) {
      const { res } = await call(handler, { method: 'init', sessionId: 'acme', repoPath });
      assert.equal(res.statusCode, 400, repoPath);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
