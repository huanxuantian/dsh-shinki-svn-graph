/**
 * SVN 服务层（host 半边）：工作副本探测、日志读取、状态读取、以及
 * 拉取(update) / 添加(add) / 提交(commit) 三个写操作。
 *
 * 设计取舍
 * ────────
 * 1. **所有命令的 cwd 都是工作副本根**（`wcRootOf` 的结果）。`svn status` 与
 *    `svn commit` 的路径参数是"相对当前目录"的，把 cwd 固定在副本根，客户端
 *    拿到的路径就能原样回传，不必做二次换算。
 * 2. **认证两级走**：默认不传凭据，让 svn 走**系统凭据链**（它自己的凭据缓存，
 *    macOS 上是钥匙串）；系统凭据不可用时抛 E_AUTH(`needsCredentials`)，由面板
 *    做**交互式输入**——此时账号走 argv、密码走 stdin
 *    (`--password-from-stdin`)，且全程 `--non-interactive`，绝不在终端索要口令。
 * 3. **错误分类而不只是抛错**：svn 的失败靠 stderr 里的 E 码识别，这里映射成
 *    稳定的 error code，客户端据此决定是弹认证框、提示冲突、还是显示原始输出。
 * 4. 提交信息经**临时文件 + `--encoding UTF-8`** 传递：`-m` 会被 svn 按本地
 *    编码解释，本机 locale 为 C/POSIX 时中文提交信息会乱码。
 */
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { existsSync, realpathSync, readdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { runSvn, resolveSvnBinary, DEFAULT_TIMEOUT_MS, NETWORK_TIMEOUT_MS, SPAWN_FAILURE_EXIT, TIMEOUT_EXIT } from './svn-runner.js';
import { parseXml, childOf, textOf, childrenOf } from './xml.js';

/** svn 命令失败。`code` 供客户端分支，`command` 便于排障。 */
export class SvnCommandError extends Error {
  constructor(message, code = 'svn-error', command = '') {
    super(message);
    this.name = 'SvnCommandError';
    this.code = code;
    this.command = command;
  }
}

export const E_SVN_MISSING = 'svn-missing';
export const E_NOT_WC = 'not-wc';
export const E_TIMEOUT = 'timeout';
export const E_BAD_REQUEST = 'bad-request';
export const E_AUTH = 'svn-auth';
export const E_FORBIDDEN = 'svn-forbidden';
export const E_CONNECT = 'svn-connect';
export const E_CONFLICT = 'svn-conflict';
export const E_WC_LOCKED = 'wc-locked';
export const E_NOT_VERSIONED = 'not-versioned';

/** 一次 status 扫描最多返回的条目数。 */
export const MAX_STATUS_ENTRIES = 2000;
/** 一次提交最多接受的显式路径数（超过则整副本提交，避免 argv 过长）。 */
export const MAX_COMMIT_PATHS = 500;
/** 一级子目录扫描上限。 */
const MAX_SCAN_DIRS = 200;

/**
 * 校验客户端传来的工作副本内相对路径：必须是 '/'-分隔的相对路径，
 * 不含 '..'、盘符、反斜杠、前导 '-'（会被当成选项）。
 * @param {unknown} p
 */
export function validateRelPath(p) {
  if (typeof p !== 'string' || p === '') return false;
  if (p.startsWith('-')) return false;
  if (p.includes('\\') || p.includes(':') || p.includes('\0')) return false;
  if (path.isAbsolute(p)) return false;
  const segments = p.split('/');
  for (const segment of segments) {
    if (segment === '..') return false;
    if (segment === '') continue; // 允许 'a//b' 之外的重复斜杠很少见，容忍空段
  }
  return true;
}

/** 现有目录的 realpath，否则 null。 */
function existingDir(value) {
  if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) return null;
  if (!existsSync(value)) return null;
  try { return realpathSync(value); } catch { return null; }
}

/**
 * 解析会话工作目录（host 侧，永不信任客户端给的任意路径）。
 * 与 dsh-shinki-git-graph 的 resolveSessionCwd 同构：
 *   1. ctx.sessions 的活动会话
 *   2. sessionQuery.listSessions() 的持久化会话头
 *   3. workspaceRegistry.list() 的工作区台账
 *   4. 客户端 cwd 提示——仅当它是台账中的某个工作区路径时才接受
 * @returns {Promise<{cwd: string|null, reason: 'ok'|'workspace-missing'|'session-unknown', source?: string, detail?: string}>}
 */
async function resolveCwd(ctx, sessionId, clientCwd) {
  let knownButMissing = null;
  const rememberRaw = (value) => {
    if (typeof value === 'string' && value !== '') knownButMissing = value;
  };

  const liveRaw = ctx.sessions?.get?.(sessionId)?.header?.cwd;
  const live = existingDir(liveRaw);
  if (live !== null) return { cwd: live, reason: 'ok', source: 'live' };
  rememberRaw(liveRaw);

  const query = ctx.get?.('sessionQuery');
  if (typeof query?.listSessions === 'function') {
    try {
      const records = await query.listSessions();
      const record = (records ?? []).find((r) => (r?.header?.id ?? r?.id) === sessionId);
      const raw = record?.header?.cwd ?? record?.cwd;
      const persisted = existingDir(raw);
      if (persisted !== null) return { cwd: persisted, reason: 'ok', source: 'persisted' };
      rememberRaw(raw);
    } catch { /* 落到工作区台账 */ }
  }

  const registry = ctx.get?.('workspaceRegistry');
  let workspaces = null;
  if (typeof registry?.list === 'function') {
    try { workspaces = registry.list() ?? []; } catch { workspaces = null; }
  }
  if (workspaces !== null) {
    for (const workspace of workspaces) {
      if (Array.isArray(workspace?.sessionIds) && workspace.sessionIds.includes(sessionId)) {
        const fromWorkspace = existingDir(workspace.path);
        if (fromWorkspace !== null) return { cwd: fromWorkspace, reason: 'ok', source: 'workspace' };
      }
    }
    const hint = existingDir(clientCwd);
    if (hint !== null) {
      for (const workspace of workspaces) {
        if (existingDir(workspace?.path) === hint) return { cwd: hint, reason: 'ok', source: 'client' };
      }
    }
  }

  if (knownButMissing !== null) return { cwd: null, reason: 'workspace-missing', detail: knownButMissing };
  return { cwd: null, reason: 'session-unknown' };
}

const CWD_CACHE_MAX = 200;
const CWD_MISS_TTL_MS = 5_000;
const cwdCache = new Map();

/** 清空会话 cwd 解析缓存（测试钩子）。 */
export function resetSessionCwdCache() { cwdCache.clear(); }

/**
 * 带缓存的会话工作目录解析（会话的 cwd 不会变，命中即可长期复用；
 * 未命中的结果短 TTL 后重试，因为会话可能是刚建的）。
 * @returns {Promise<{cwd: string|null, reason: 'ok'|'workspace-missing'|'session-unknown', source?: string, detail?: string}>}
 */
export async function resolveSessionCwd(ctx, sessionId, clientCwd = '') {
  if (typeof sessionId !== 'string' || sessionId === '') return { cwd: null, reason: 'session-unknown' };
  const key = `${sessionId}\u0000${typeof clientCwd === 'string' ? clientCwd : ''}`;
  const cached = cwdCache.get(key);
  if (cached !== undefined) {
    if (cached.result.cwd !== null || Date.now() - cached.at < CWD_MISS_TTL_MS) return cached.result;
    cwdCache.delete(key);
  }
  const result = await resolveCwd(ctx, sessionId, clientCwd);
  if (cwdCache.size >= CWD_CACHE_MAX) cwdCache.clear();
  cwdCache.set(key, { result, at: Date.now() });
  return result;
}

/** 从 stderr 的 E 码/文案把 svn 失败归类。 */
export function classifySvnError(stderr, command = '') {
  const text = String(stderr ?? '');
  // 同时认 E 与 W 前缀：svn 对某些问题（如"不是工作副本"）在 status 上只发
  // W155007 警告且退出码为 0，不看警告就会漏判。
  const codeOf = (name) => new RegExp(`\\b[EW]${name.slice(1)}\\b`).test(text);
  if (codeOf('E170001') || /Authentication failed|认证失败|No more credentials|E215004/.test(text)) {
    return new SvnCommandError(text.trim() || '认证失败', E_AUTH, command);
  }
  if (codeOf('E175013') || /forbidden|Access denied|拒绝访问|禁止访问/.test(text)) {
    return new SvnCommandError(text.trim() || '权限不足（该账号无此路径的写权限）', E_FORBIDDEN, command);
  }
  if (codeOf('E155007') || /is not a working copy|不是工作副本/.test(text)) {
    return new SvnCommandError(text.trim() || '该目录不是工作副本', E_NOT_WC, command);
  }
  if (codeOf('E170013') || codeOf('E670002') || /Unable to connect|无法连接/.test(text)) {
    return new SvnCommandError(text.trim() || '无法连接到版本库', E_CONNECT, command);
  }
  if (codeOf('E155015') || /\bconflict\b|冲突/.test(text)) {
    return new SvnCommandError(text.trim() || '存在冲突', E_CONFLICT, command);
  }
  if (codeOf('E155004') || /locked|已锁定/.test(text)) {
    return new SvnCommandError(text.trim() || '工作副本被锁定（请先执行清理/cleanup）', E_WC_LOCKED, command);
  }
  if (codeOf('E200009') || codeOf('E155010') || /not under version control|不在版本控制下/.test(text)) {
    return new SvnCommandError(text.trim() || '路径不在版本控制下', E_NOT_VERSIONED, command);
  }
  return new SvnCommandError(text.trim() || 'svn 命令失败', 'svn-error', command);
}

/**
 * 认证参数装配。
 *
 * 凭据分两级来源：
 *   1. **系统凭据链** —— 不传 `--username/--password`，让 svn 自己去找：
 *      它自己的凭据缓存（macOS 上是 `passtype=keychain`，即系统钥匙串）。
 *   2. **交互式输入** —— 面板里填的账号密码：用户名走 argv（不是秘密），
 *      密码走 **stdin**（`--password-from-stdin`，1.14+ 支持），不进命令行，
 *      `ps` 里看不到明文。
 *
 * `--non-interactive` 始终附加：svn 需要凭据时会尝试读 `/dev/tty`，宿主进程
 * 若恰有控制终端，那既会阻塞本次调用、又会把提示画到别人的终端上。加上它以
 * 后 svn 直接以 E170001/E215004 失败，由上层转成「需要认证」交给面板。
 *
 * `--no-auth-cache` **默认不加**（`noCache` 默认 false）：默认允许 svn 使用并
 * 写入系统凭据缓存，"系统认证优先"才成立；只有用户显式勾选「不保存凭据」时
 * 才禁用。
 * @param {{username?: string, password?: string, noCache?: boolean, trustCert?: boolean}} [auth]
 * @returns {{args: string[], stdin?: string, usedPassword: boolean}}
 */
export function authArgs(auth = {}) {
  const args = ['--non-interactive'];
  let stdin;
  const username = typeof auth.username === 'string' ? auth.username.trim() : '';
  const password = typeof auth.password === 'string' ? auth.password : '';
  if (username !== '') args.push('--username', username);
  if (password !== '') {
    // 关键：密码走 stdin，不进 argv（否则 ps 可见明文）。
    args.push('--password-from-stdin');
    stdin = `${password}\n`;
  }
  if (auth.noCache === true) args.push('--no-auth-cache');
  if (auth.trustCert === true) {
    args.push('--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other');
  }
  return { args, stdin, usedPassword: password !== '' };
}

/** 客户端是否显式提供了凭据（用户名或密码任一非空）。 */
export function hasExplicitCredentials(auth = {}) {
  const username = typeof auth.username === 'string' ? auth.username.trim() : '';
  const password = typeof auth.password === 'string' ? auth.password : '';
  return username !== '' || password !== '';
}

/** 一次 svn 调用的结果是否属于「认证失败」（而非网络/权限等其它失败）。 */
export function isAuthFailure(result) {
  if (result.exitCode === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`;
  return /E170001|E215004|Authentication failed|认证失败|No more credentials|authorization failed/i.test(text);
}

/** 把 svn 缺失/超时转成稳定错误。 */
function checkTransport(result, command) {
  if (result.exitCode === SPAWN_FAILURE_EXIT) throw new SvnCommandError(result.stderr.trim() || 'svn 不可用', E_SVN_MISSING, command);
  if (result.exitCode === TIMEOUT_EXIT) throw new SvnCommandError(`svn 命令超时：${command}`, E_TIMEOUT, command);
}

/**
 * 创建绑定宿主上下文的 SVN 服务。
 * @param {{logger?: {warn?: (...a:any[])=>void}}} ctx
 */
export function createSvnService(ctx) {
  const warn = (...a) => ctx.logger?.warn?.(...a);
  /** wc-root 探测结果缓存：`${dir}` -> `{root, at}`（避免每次刷新都 spawn）。 */
  const wcCache = new Map();
  const WC_TTL_MS = 4_000;

  /**
   * 跑一条可能触发认证的 svn 命令，按「系统凭据优先 → 交互输入兜底」的顺序：
   *
   *   · 客户端**显式**给了账号密码 → 直接用（用户明确指定了身份）。
   *   · 没给 → 先不传任何凭据跑一次，让 svn 走它自己的凭据链（含 macOS
   *     钥匙串）。成功即记 `authSource:'system'`。
   *   · 系统凭据不可用（认证失败）→ 抛 E_AUTH 且 `needsCredentials=true`，
   *     面板据此弹出账号密码输入框；绝不在终端上索要口令。
   *
   * @param {string} cwd
   * @param {string[]} args 子命令参数（不含认证全局选项）
   * @param {{auth?: object, timeoutMs?: number}} [options]
   * @returns {Promise<{result: {exitCode:number,stdout:string,stderr:string,timedOut:boolean}, authSource: 'system'|'explicit'|'none'}>}
   */
  async function runWithAuth(cwd, args, options = {}) {
    const auth = options.auth ?? {};
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (hasExplicitCredentials(auth)) {
      const { args: authA, stdin } = authArgs(auth);
      const result = await runSvn(cwd, [...args, ...authA], { timeoutMs, stdin });
      return { result, authSource: 'explicit' };
    }

    if (auth.useSystem !== false) {
      // 阶段 1：系统凭据链。显式不加 --no-auth-cache，让 svn 读取它自己的缓存。
      const { args: authA } = authArgs({ ...auth, noCache: false });
      const result = await runSvn(cwd, [...args, ...authA], { timeoutMs });
      if (!isAuthFailure(result)) return { result, authSource: 'system' };
    }

    // 系统凭据不可用（或调用方禁用了它）→ 交给面板做交互式输入。
    const error = new SvnCommandError('需要认证：系统凭据不可用，请在面板中输入账号密码', E_AUTH, '');
    error.needsCredentials = true;
    throw error;
  }

  /**
   * 目录所属工作副本的根。非工作副本返回 null。
   * 抛 SvnCommandError(E_SVN_MISSING/E_TIMEOUT)——这两者**不能**被当成"不是副本"。
   */
  async function wcRootOf(dir, options = {}) {
    const key = dir;
    const cached = wcCache.get(key);
    if (options.refresh !== true && cached !== undefined && Date.now() - cached.at < WC_TTL_MS) return cached.root;
    const result = await runSvn(dir, ['info', '--show-item', 'wc-root', '.'], { timeoutMs: DEFAULT_TIMEOUT_MS });
    checkTransport(result, 'info --show-item wc-root');
    let root = null;
    if (result.exitCode === 0) {
      const value = result.stdout.trim();
      root = value === '' ? null : (existingDir(value) ?? value);
    }
    wcCache.set(key, { root, at: Date.now() });
    return root;
  }

  /** 工作副本信息（`svn info --xml` 的结构化视图）。 */
  async function info(target, options = {}) {
    const { result, authSource } = await runWithAuth(target, ['info', '--xml', target], {
      auth: options.auth,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    checkTransport(result, 'info');
    if (result.exitCode !== 0) throw classifySvnError(result.stderr, 'info');
    const { root } = parseXml(result.stdout);
    if (root === null) throw new SvnCommandError('无法解析 svn info 输出', 'svn-error', 'info');
    const entry = root.name === 'entry' ? root : childOf(root, 'entry') ?? root;
    const wcInfo = childOf(entry, 'wc-info');
    const repository = childOf(entry, 'repository');
    const commit = childOf(entry, 'commit');
    return {
      path: entry.attrs.path ?? '',
      kind: entry.attrs.kind ?? '',
      revision: Number.parseInt(entry.attrs.revision ?? '-1', 10),
      url: textOf(entry, 'url'),
      relativeUrl: textOf(entry, 'relative-url'),
      repositoryRoot: repository === null ? '' : textOf(repository, 'root'),
      repositoryUuid: repository === null ? '' : textOf(repository, 'uuid'),
      wcRoot: wcInfo === null ? '' : textOf(wcInfo, 'wcroot-abspath'),
      schedule: wcInfo === null ? '' : textOf(wcInfo, 'schedule'),
      depth: wcInfo === null ? '' : textOf(wcInfo, 'depth'),
      // 注意：commit 的版本号是**属性**（<commit revision="N">），不是子元素。
      lastChangedRev: commit === null ? -1 : Number.parseInt(commit.attrs.revision ?? '-1', 10),
      lastChangedAuthor: commit === null ? '' : textOf(commit, 'author'),
      lastChangedDate: commit === null ? '' : textOf(commit, 'date'),
      authSource,
    };
  }

  /**
   * 只读探测：系统凭据链当前是否可用（用于面板显示「已使用系统凭据 / 需要登录」）。
   * 做法是**不带任何凭据**地访问版本库根 URL：成功即说明钥匙串/凭据缓存里
   * 已有可用凭据。失败（含认证失败、无网络）都报 false，不抛错。
   */
  async function systemAuthAvailable(target) {
    let repoUrl = '';
    try {
      const detail = await info(target);
      repoUrl = detail.repositoryRoot || detail.url;
    } catch { return { available: false, url: '', detail: '无法读取工作副本信息' }; }
    if (repoUrl === '') return { available: false, url: '', detail: '工作副本未关联版本库' };
    const args = ['info', '--non-interactive', repoUrl];
    const result = await runSvn(target, args, { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (result.exitCode === 0) return { available: true, url: repoUrl, detail: '系统凭据可用' };
    if (isAuthFailure(result)) return { available: false, url: repoUrl, detail: '系统凭据不可用（需要账号密码）' };
    return { available: false, url: repoUrl, detail: result.stderr.trim().split('\n')[0] || '探测失败' };
  }


  /** 只读探测：某目录是否是工作副本（返回 null 表示不是）。 */
  async function probe(target) {
    try {
      const root = await wcRootOf(target, { refresh: true });
      if (root === null) return null;
      const detail = await info(target);
      return {
        wcRoot: root,
        url: detail.url,
        repositoryRoot: detail.repositoryRoot,
        revision: detail.revision,
        lastChangedRev: detail.lastChangedRev,
        lastChangedAuthor: detail.lastChangedAuthor,
        lastChangedDate: detail.lastChangedDate,
      };
    } catch (error) {
      if (error instanceof SvnCommandError && (error.code === E_SVN_MISSING || error.code === E_TIMEOUT)) throw error;
      return null;
    }
  }

  /**
   * 扫描 cwd 的一级子目录，找出本身就是工作副本根的那些。
   * 判据：子目录下存在 `.svn` 目录（Subversion 1.7+ 只在副本根放一个 .svn），
   * 再用 `svn info` 复核，避免把残留的 .svn 目录误判成副本。
   */
  async function scanSubRepos(cwd) {
    let entries;
    try {
      entries = readdirSync(cwd, { withFileTypes: true });
    } catch (error) {
      warn(`[dsh-shinki-svn-graph] 无法读取目录 ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const candidates = [];
    for (const entry of entries) {
      if (candidates.length >= MAX_SCAN_DIRS) break;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(cwd, entry.name);
      if (!existsSync(path.join(abs, '.svn'))) continue;
      try {
        if (!statSync(abs).isDirectory()) continue;
      } catch { continue; }
      candidates.push({ name: entry.name, abs });
    }
    const found = [];
    // 小并发：每个候选要 spawn 一次 svn info，串行在慢盘上会明显变慢。
    const CONCURRENCY = 6;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const slice = candidates.slice(i, i + CONCURRENCY);
      const probed = await Promise.all(slice.map(async (candidate) => ({ candidate, info: await probe(candidate.abs) })));
      for (const { candidate, info: detail } of probed) {
        if (detail === null) continue;
        found.push({
          name: candidate.name,
          path: candidate.name,
          wcRoot: detail.wcRoot,
          url: detail.url,
          revision: detail.revision,
          lastChangedRev: detail.lastChangedRev,
        });
      }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 读取日志。
   * @param {string} target 工作副本路径（cwd 固定为副本根）
   * @param {{limit?: number, verbose?: boolean, revision?: string, auth?: object}} [options]
   */
  async function log(target, options = {}) {
    const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 500) : 20;
    const verbose = options.verbose !== false;
    const args = ['log', '--xml', '-l', String(limit)];
    if (verbose) args.push('-v');
    if (typeof options.revision === 'string' && options.revision !== '') {
      args.push('-r', options.revision);
    } else {
      // ⚠ 必须显式给范围：`svn log <工作副本路径>` 默认走 `BASE:1`，而工作副本
      // **根目录节点**的版本常常是 0（提交子文件并不会抬高它），此时日志会是空的
      // —— 这正是"面板里日志一片空白"的成因。`HEAD:1` 表示"从最新往回取"。
      args.push('-r', 'HEAD:1');
    }
    args.push(target);
    const { result, authSource } = await runWithAuth(target, args, {
      auth: options.auth,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    checkTransport(result, 'log');
    if (result.exitCode !== 0) throw classifySvnError(result.stderr, 'log');
    const { root, errors } = parseXml(result.stdout);
    const entries = [];
    if (root !== null) {
      for (const node of childrenOf(root, 'logentry')) {
        const paths = [];
        const pathsNode = childOf(node, 'paths');
        if (pathsNode !== null) {
          for (const p of childrenOf(pathsNode, 'path')) {
            paths.push({
              action: p.attrs.action ?? '',
              kind: p.attrs.kind ?? '',
              textMods: p.attrs['text-mods'] === 'true',
              propMods: p.attrs['prop-mods'] === 'true',
              path: p.text.trim(),
            });
          }
        }
        entries.push({
          revision: Number.parseInt(node.attrs.revision ?? '-1', 10),
          author: textOf(node, 'author'),
          date: textOf(node, 'date'),
          message: textOf(node, 'msg'),
          paths,
        });
      }
    }
    return { entries, limit, verbose, warnings: errors, authSource };
  }

  /** 读取本地改动（`svn status --xml`）。 */
  async function status(target, options = {}) {
    const { result, authSource } = await runWithAuth(target, ['status', '--xml'], {
      auth: options.auth,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    checkTransport(result, 'status');
    if (result.exitCode !== 0) throw classifySvnError(result.stderr, 'status');
    // ⚠ `svn status` 在非工作副本目录里**退出码为 0**，只在 stderr 打 W155007 警告
    // 并返回空的 <status>。若不看警告，面板会把"这里根本不是工作副本"显示成
    // "工作副本干净" —— 那是最误导人的一种错。
    if (/\bW155007\b/.test(result.stderr)) throw classifySvnError(result.stderr, 'status');
    const { root, errors } = parseXml(result.stdout);
    const entries = [];
    if (root !== null) {
      for (const targetNode of childrenOf(root, 'target')) {
        for (const entry of childrenOf(targetNode, 'entry')) {
          const wc = childOf(entry, 'wc-status');
          if (wc === null) continue;
          const item = wc.attrs.item ?? '';
          if (item === 'normal' || item === 'none' || item === '') continue;
          entries.push({
            path: entry.attrs.path ?? '',
            item,
            props: wc.attrs.props ?? '',
            revision: Number.parseInt(wc.attrs.revision ?? '-1', 10),
            copied: wc.attrs.copied === 'true',
            treeConflicted: wc.attrs['tree-conflicted'] === 'true',
            movedFrom: wc.attrs['moved-from'] ?? '',
          });
          if (entries.length >= MAX_STATUS_ENTRIES) break;
        }
      }
    }
    return { entries, warnings: errors, truncated: entries.length >= MAX_STATUS_ENTRIES, authSource };
  }

  /**
   * 从 svn 输出里提取 "Committed revision N." / "Updated to revision N."。
   * ⚠ 这些是**本地化文案**（zh 下是「提交后的版本为 1。」），英文正则必然落空，
   * 因此这里同时认几种常见写法，调用方仍必须在返回 null 时走 headRevision() 兜底。
   */
  function revisionFromOutput(text) {
    const m = /(?:Committed|Updated to|At|Updated)\s+revision\s+(\d+)/i.exec(text);
    if (m !== null) return Number.parseInt(m[1], 10);
    // 中文（本部署的 locale）：提交后的版本为 N。/ 更新到版本 N。/ 版本 N。
    const zh = /(?:提交后的版本为|更新到版本|版本为|版本)\s*(\d+)/.exec(text);
    return zh === null ? null : Number.parseInt(zh[1], 10);
  }

  /** 工作副本关联的版本库根 URL（本地查询，不联网）。 */
  async function reposRootUrlOf(target) {
    const result = await runSvn(target, ['info', '--show-item', 'repos-root-url', '.'], { timeoutMs: DEFAULT_TIMEOUT_MS });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  }

  /**
   * 与语言无关地取**版本库当前 HEAD 版本号**。
   *
   * 为什么不能用工作副本自己的 revision：`svn info --show-item revision .`
   * 给的是**该节点**的 BASE 版本。刚提交完时副本根目录节点自身没被改动，
   * 它仍然是 0；即使只改文件内容也一直是 0（实测）。提交后真正新的版本号
   * 只能从版本库侧拿 —— 查仓库根 URL 的 revision 即可（提交刚发生，HEAD 即
   * 本次提交号）。
   */
  async function headRevision(target) {
    const url = await reposRootUrlOf(target);
    if (url === '') return null;
    const result = await runSvn(target, ['info', '--show-item', 'revision', url], { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (result.exitCode !== 0) return null;
    const n = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * 拉取（svn update）。`--accept postpone` 让冲突保留标记而不是中断，
   * 冲突详情由返回的 conflicts 列表交给 UI 呈现。
   */
  async function update(target, options = {}) {
    const args = ['update', '--accept', 'postpone'];
    if (options.force === true) args.push('--force');
    args.push(options.path === undefined || options.path === '' ? '.' : options.path);
    const { result, authSource } = await runWithAuth(target, args, {
      auth: options.auth,
      timeoutMs: NETWORK_TIMEOUT_MS,
    });
    checkTransport(result, 'update');
    const output = `${result.stdout}${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      const error = classifySvnError(result.stderr || result.stdout, 'update');
      error.output = output;
      throw error;
    }
    const conflicts = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const m = /^(C|Tree conflict)\s+(.*)$/.exec(line);
      if (m !== null) conflicts.push(m[2].trim());
    }
    return {
      revision: revisionFromOutput(result.stdout) ?? await headRevision(target),
      output,
      conflicts,
      updated: /^(A|D|U|C|G)\s/m.test(result.stdout) || conflicts.length > 0,
      authSource,
    };
  }

  /**
   * 添加未纳入版本控制的路径（`svn add`）。
   * 默认带 `--parents`（补全中间目录）与 `--force`（对已受控目录递归时继续）。
   * 被 svn 判定为 ignore 的文件不会被添加——这与命令行行为一致。
   */
  async function add(target, options = {}) {
    const paths = Array.isArray(options.paths) ? options.paths : [];
    if (paths.length === 0) throw new SvnCommandError('没有指定要添加的路径', E_BAD_REQUEST, 'add');
    for (const p of paths) {
      if (!validateRelPath(p)) throw new SvnCommandError(`非法路径：${p}`, E_BAD_REQUEST, 'add');
    }
    if (paths.length > MAX_COMMIT_PATHS) throw new SvnCommandError(`一次最多添加 ${MAX_COMMIT_PATHS} 个路径`, E_BAD_REQUEST, 'add');
    const args = ['add', '--parents', '--force', ...paths];
    const { result, authSource } = await runWithAuth(target, args, {
      auth: options.auth,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    checkTransport(result, 'add');
    const output = `${result.stdout}${result.stderr}`.trim();
    // `svn add` 对被忽略的文件打印告警但整体仍成功；只有真正失败
    // （权限、锁定、非工作副本）才抛错。
    if (result.exitCode !== 0) {
      const err = classifySvnError(result.stderr || result.stdout, 'add');
      err.output = output;
      throw err;
    }
    const added = result.stdout
      .split(/\r?\n/)
      .map((line) => /^A\s+(?:\(bin\)\s+)?(.+)$/.exec(line))
      .filter((m) => m !== null)
      .map((m) => m[1].trim());
    const skipped = [];
    if (/\bignored\b|被忽略/i.test(output)) skipped.push(...paths.filter((p) => output.includes(p)));
    return { added, skipped, output, authSource };
  }

  /**
   * 提交信息写临时文件（0600）后执行回调，返回前删除。
   * 必须 `await` 回调——异步回调下"先删文件再让 svn 读"会直接失败。
   */
  async function withMessageFile(message, fn) {
    const file = path.join(os.tmpdir(), `dsh-svn-msg-${crypto.randomBytes(8).toString('hex')}.txt`);
    try {
      writeFileSync(file, message, { encoding: 'utf8', mode: 0o600 });
      return await fn(file);
    } finally {
      try { unlinkSync(file); } catch { /* 忽略 */ }
    }
  }

  /**
   * 把提交路径提升到"最上层的新增祖先"。
   *
   * SVN 的一致性要求：如果选中路径位于一个**新增(added)目录**之下，提交时那个
   * 目录必须一并出现在 pathspec 里，否则 svn 报
   * `E200009: "<dir>" 不在版本库中，也不是提交的一部分，但是它的子路径 "<file>" 是提交的一部分`。
   * 把一个新增目录放进 pathspec，等于提交它整棵子树 —— 对新增目录而言其中每一项
   * 本来也都是新增的，所以这是唯一可行的做法。这里同时把提升情况回报给 UI，
   * 让用户知道"实际提交的比选中的多"。
   *
   * @returns {Promise<{paths: string[], promoted: Array<{from: string, to: string}>}>}
   */
  async function promoteCommitPaths(target, paths) {
    if (paths.length === 0) return { paths, promoted: [] };
    let entries = [];
    try {
      entries = (await status(target)).entries;
    } catch {
      return { paths, promoted: [] }; // 取不到状态就按原样提交，让 svn 自己报错
    }
    const itemOf = new Map(entries.map((e) => [e.path, e.item]));
    const out = [];
    const promoted = [];
    for (const p of paths) {
      const segments = p.split('/');
      let chosen = p;
      // 从最上层往下找第一个 added/replaced 祖先（i=1 是最外层，i=segments.length 是自身）
      for (let i = 1; i <= segments.length; i += 1) {
        const candidate = segments.slice(0, i).join('/');
        const item = itemOf.get(candidate);
        if (item === 'added' || item === 'replaced') { chosen = candidate; break; }
      }
      if (chosen !== p) promoted.push({ from: p, to: chosen });
      if (!out.includes(chosen)) out.push(chosen);
    }
    return { paths: out, promoted };
  }

  /**
   * 提交（`svn commit`）。`paths` 为空表示提交整个工作副本的改动。
   */
  async function commit(target, options = {}) {
    const message = typeof options.message === 'string' ? options.message : '';
    if (message.trim() === '') throw new SvnCommandError('提交说明不能为空', E_BAD_REQUEST, 'commit');
    const requested = Array.isArray(options.paths) ? options.paths : [];
    if (requested.length > MAX_COMMIT_PATHS) throw new SvnCommandError(`一次最多提交 ${MAX_COMMIT_PATHS} 个路径`, E_BAD_REQUEST, 'commit');
    for (const p of requested) {
      if (!validateRelPath(p)) throw new SvnCommandError(`非法路径：${p}`, E_BAD_REQUEST, 'commit');
    }
    const { paths, promoted } = await promoteCommitPaths(target, requested);
    const { result, authSource } = await withMessageFile(message, async (file) => {
      const args = ['commit', '-F', file, '--encoding', 'UTF-8'];
      if (options.depth !== undefined && options.depth !== '') args.push('--depth', String(options.depth));
      if (paths.length > 0) args.push(...paths);
      return runWithAuth(target, args, { auth: options.auth, timeoutMs: NETWORK_TIMEOUT_MS });
    });
    checkTransport(result, 'commit');
    const output = `${result.stdout}${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      const error = classifySvnError(result.stderr || result.stdout, 'commit');
      error.output = output;
      throw error;
    }
    return { revision: revisionFromOutput(result.stdout) ?? await headRevision(target), output, authSource, committedPaths: paths, promoted };
  }

  /** 把客户端给的相对路径解析成绝对路径，限制在工作副本内。 */
  function resolveInWc(wcRoot, relPath) {
    if (relPath === undefined || relPath === null || relPath === '') return wcRoot;
    if (!validateRelPath(relPath)) throw new SvnCommandError(`非法路径：${relPath}`, E_BAD_REQUEST);
    const abs = path.resolve(wcRoot, ...relPath.split('/'));
    const rel = path.relative(wcRoot, abs);
    if (path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
      throw new SvnCommandError(`路径越出工作副本：${relPath}`, E_BAD_REQUEST);
    }
    return abs;
  }

  /** svn 可执行文件路径（用于状态栏展示与排障）。 */
  function binaryPath() { return resolveSvnBinary(); }

  return {
    wcRootOf, probe, scanSubRepos, info, log, status, update, add, commit,
    systemAuthAvailable, resolveInWc, binaryPath,
  };
}
