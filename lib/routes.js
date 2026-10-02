/**
 * 插件的 HTTP 面：`/shinki-svn` 前缀下的单一 JSON 入口。
 * 所有方法按名字分派到 SVN 服务；会话工作目录在 host 侧解析（永不信任
 * 客户端传来的任意路径，只接受工作区内的相对子路径）。
 */
import path from 'node:path';
import { createFence } from './trust-fence.js';
import {
  createSvnService,
  resolveSessionCwd,
  SvnCommandError,
  validateRelPath,
  E_SVN_MISSING,
  E_NOT_WC,
  E_BAD_REQUEST,
  E_AUTH,
} from './svn-service.js';

const API_PATH = '/shinki-svn/api';
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 把客户端给的可选 `repoPath`（工作区相对、'/'-分隔）解析成工作区内的绝对目录。
 * 这是客户端选中「一级子目录里的工作副本」的方式。任何逃出工作区的路径
 * （绝对路径、'..'、盘符）一律拒绝。
 */
function subRepoDir(cwd, repoPath) {
  if (repoPath === undefined || repoPath === null || repoPath === '') return cwd;
  if (typeof repoPath !== 'string' || !validateRelPath(repoPath)) {
    throw new SvnCommandError('非法仓库路径', E_BAD_REQUEST);
  }
  const abs = path.resolve(cwd, ...repoPath.split('/'));
  const rel = path.relative(cwd, abs);
  if (path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
    throw new SvnCommandError('非法仓库路径', E_BAD_REQUEST);
  }
  return abs;
}

/** 读取有体积上限的 JSON 请求体。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/** 写 JSON 响应。 */
function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const OK = (value) => ({ ok: true, value });
const FAIL = (error) => ({
  ok: false,
  error: {
    code: error.code ?? 'internal',
    message: error.message,
    command: error.command ?? '',
    output: error.output ?? '',
    // 认证失败且系统凭据不可用时为 true：面板据此弹出账号密码输入。
    needsCredentials: error.needsCredentials === true,
  },
});

/**
 * 归一化客户端传来的认证信息（绝不回显到日志/响应里）。
 * `noCache` 默认 false —— 即默认允许 svn 使用/写入系统凭据缓存，
 * 「系统认证优先」才成立；只有用户勾选「不保存凭据」才禁用。
 */
function readAuth(payload) {
  const raw = payload?.auth;
  if (raw === null || typeof raw !== 'object') return { noCache: false };
  return {
    username: typeof raw.username === 'string' ? raw.username : '',
    password: typeof raw.password === 'string' ? raw.password : '',
    noCache: raw.noCache === true,
    trustCert: raw.trustCert === true,
    useSystem: raw.useSystem !== false,
  };
}

/**
 * 构建路由处理器。
 * @param {{sessions?: any, webRuntime?: any, logger?: any}} ctx
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler(ctx) {
  const fence = createFence(ctx);
  const service = createSvnService(ctx);

  return async (req, res) => {
    const gate = fence.check(req);
    if (!gate.ok) { writeJson(res, 403, FAIL(gate)); return; }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      res.writeHead(415); res.end(); return;
    }
    let payload;
    try { payload = await readJsonBody(req); }
    catch { writeJson(res, 400, FAIL({ code: E_BAD_REQUEST, message: '请求体需为合法 JSON' })); return; }

    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname !== API_PATH) { res.writeHead(404); res.end(); return; }

    const method = typeof payload?.method === 'string' ? payload.method : '';
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
    if (method === '' || sessionId === '') {
      writeJson(res, 400, FAIL({ code: E_BAD_REQUEST, message: '缺少 method / sessionId' }));
      return;
    }

    const resolved = await resolveSessionCwd(ctx, sessionId, typeof payload?.cwd === 'string' ? payload.cwd : '');
    if (resolved.cwd === null) {
      const missing = resolved.reason === 'workspace-missing';
      writeJson(res, 404, FAIL({
        code: missing ? 'workspace-missing' : 'session-not-found',
        message: missing
          ? `工作区目录不存在或不可访问：${resolved.detail ?? ''}`
          : '会话不存在或工作区不可访问',
      }));
      return;
    }
    const cwd = resolved.cwd;
    const auth = readAuth(payload);

    /** 目标目录：默认会话工作区，可指定其内部的一级子目录（已发现的工作副本）。 */
    const targetOf = () => subRepoDir(cwd, payload.repoPath);

    try {
      switch (method) {
        case 'init': {
          if (service.binaryPath() === null) {
            writeJson(res, 200, OK({ svnMissing: true, message: '未找到 svn 可执行文件（请安装 Subversion，或设置 DSH_SVN_BIN）' }));
            return;
          }
          const target = targetOf();
          const detail = await service.probe(target);
          const result = {
            svnMissing: false,
            svnBinary: service.binaryPath(),
            cwd,
            isWc: detail !== null,
            ...(detail ?? {}),
          };
          // 工作区本身不是工作副本时，才去发现一级子目录里的副本。
          if (!payload.repoPath && detail === null) {
            result.subrepos = await service.scanSubRepos(cwd);
          }
          writeJson(res, 200, OK(result));
          return;
        }
        case 'info': {
          writeJson(res, 200, OK(await service.info(targetOf(), { auth })));
          return;
        }
        case 'log': {
          writeJson(res, 200, OK(await service.log(targetOf(), {
            limit: Number.isInteger(payload.limit) ? payload.limit : 20,
            verbose: payload.verbose !== false,
            revision: typeof payload.revision === 'string' ? payload.revision : '',
            auth,
          })));
          return;
        }
        case 'status': {
          writeJson(res, 200, OK(await service.status(targetOf(), { auth })));
          return;
        }
        // 探测"系统凭据链"是否可用（不带任何凭据访问版本库根）。
        // 面板用它决定显示「已使用系统凭据」还是「需要登录」。
        case 'authStatus': {
          writeJson(res, 200, OK(await service.systemAuthAvailable(targetOf())));
          return;
        }
        case 'update': {
          writeJson(res, 200, OK(await service.update(targetOf(), {
            auth,
            force: payload.force === true,
            path: typeof payload.path === 'string' ? payload.path : '',
          })));
          return;
        }
        case 'add': {
          writeJson(res, 200, OK(await service.add(targetOf(), {
            auth,
            paths: Array.isArray(payload.paths) ? payload.paths : [],
          })));
          return;
        }
        case 'commit': {
          writeJson(res, 200, OK(await service.commit(targetOf(), {
            auth,
            message: typeof payload.message === 'string' ? payload.message : '',
            paths: Array.isArray(payload.paths) ? payload.paths : [],
            depth: typeof payload.depth === 'string' ? payload.depth : '',
            // 面板勾选「允许空提交说明」后才会带这个标记
            allowEmptyMessage: payload.allowEmptyMessage === true,
          })));
          return;
        }
        default:
          writeJson(res, 404, FAIL({ code: 'not-found', message: `未知方法 ${method}` }));
      }
    } catch (error) {
      if (error instanceof SvnCommandError) {
        // "不是工作副本" / "没装 svn" 是**状态**而不是故障：用 200 返回，
        // 让面板显示空态提示而不是错误弹窗。
        if (error.code === E_NOT_WC || error.code === E_SVN_MISSING) {
          writeJson(res, 200, OK({ error: error.code, message: error.message, output: error.output ?? '' }));
          return;
        }
        if (error.code === E_BAD_REQUEST) { writeJson(res, 400, FAIL(error)); return; }
        // 认证失败：401 + needsCredentials，面板据此切到"输入账号密码"。
        if (error.code === E_AUTH) { writeJson(res, 401, FAIL(error)); return; }
        writeJson(res, 500, FAIL(error));
        return;
      }
      ctx.logger?.warn?.(`[dsh-shinki-svn-graph] ${method} 失败: ${error instanceof Error ? error.message : String(error)}`);
      writeJson(res, 500, FAIL({ code: 'internal', message: error instanceof Error ? error.message : String(error) }));
    }
  };
}
