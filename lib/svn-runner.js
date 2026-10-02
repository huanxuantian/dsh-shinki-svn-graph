/**
 * svn 命令执行器：每条命令一个受管子进程，带硬超时与输出上限。
 * 纯 spawn（不经 shell），因此路径/URL 永远不会被 shell 解释。
 *
 * 认证模型（与 git 版的关键差异）：
 *   Subversion 没有 `GIT_ASKPASS` 那样的外部助手协议，但它从 1.14 起支持
 *   **`--password-from-stdin`**（本题环境的 svn 1.14.5 实测支持）。因此密码
 *   经 stdin 送入子进程，**不出现在 argv 里** —— 否则 `ps` 能看到明文密码。
 *   `--username` 仍走 argv（它不是秘密）。
 *
 * 一律附加 `--non-interactive`：svn 在需要凭据时会尝试读 /dev/tty，若宿主
 * 进程正好有控制终端，那既会阻塞调用、又会把提示画到别人的终端上；加上该
 * 选项后 svn 直接报 E170001/E215004 失败，由上层转成"需要认证"提示。
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** 单条命令收集的 stdout/stderr 上限（各自）。 */
export const OUTPUT_CAP_BYTES = 1 << 20; // 1 MiB
/** 本地命令（info / status / log）默认超时。 */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** 网络命令（update / commit）默认超时——提交大文件时可能较慢。 */
export const NETWORK_TIMEOUT_MS = 300_000;
/** "连 svn 都没能启动"的退出码约定。 */
export const SPAWN_FAILURE_EXIT = 127;
/** 超时退出码约定（与 GNU timeout 一致）。 */
export const TIMEOUT_EXIT = 124;

/** 找不到 svn 时的常见安装位置（PATH 未包含 Homebrew 时兜底）。 */
const CANDIDATE_PATHS = [
  '/opt/homebrew/bin/svn',
  '/usr/local/bin/svn',
  '/opt/local/bin/svn',
  '/usr/bin/svn',
  'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
  'C:\\Program Files\\SlikSvn\\bin\\svn.exe',
];

let cachedBinary;

/** 在 PATH 中查找可执行文件（不 spawn `which`，避免多一次进程）。 */
function findOnPath(names) {
  const pathVar = process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch { /* 忽略权限/竞态 */ }
    }
  }
  return null;
}

/**
 * 定位 svn 可执行文件。优先级：`DSH_SVN_BIN` 环境变量 → PATH → 常见安装路径。
 * 结果为 null 表示本机没有可用的 svn（上层报 'svn-missing'）。
 * @param {{refresh?: boolean}} [options]
 * @returns {string | null}
 */
export function resolveSvnBinary(options = {}) {
  if (options.refresh !== true && cachedBinary !== undefined) return cachedBinary;
  const explicit = process.env.DSH_SVN_BIN;
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) {
    cachedBinary = explicit;
    return cachedBinary;
  }
  const names = process.platform === 'win32' ? ['svn.exe', 'svn'] : ['svn'];
  const onPath = findOnPath(names);
  if (onPath !== null) { cachedBinary = onPath; return cachedBinary; }
  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) { cachedBinary = candidate; return cachedBinary; }
  }
  cachedBinary = null;
  return null;
}

/** 测试钩子：清掉二进制路径缓存。 */
export function resetSvnBinaryCache() { cachedBinary = undefined; }

/**
 * 给 svn 子进程补一个 UTF-8 的字符集 locale。
 *
 * 为什么必须做：svn 把命令行上的路径视为**当前 locale 字符集**的字符串，内部再转成
 * UTF-8。宿主进程（dsh web）常常没有 LANG/LC_ALL（→ C locale），此时中文路径会被
 * 二次转换而面目全非 —— 实测 `示例目录` 变成 一串乱码
 * （各字的 UTF-8 尾字节还在、前导字节被吞），于是 `svn add/commit` 直接报
 * `E155010 找不到节点`。
 *
 * 只改 **LC_CTYPE**（字符编码），并把 `LC_ALL` 置空以解除它对 LC_CTYPE 的压制，
 * 因此**消息语言不受影响**（中文环境下 svn 提示仍是中文）。
 * Windows 走 UTF-16 argv，不存在该问题，直接跳过。
 *
 * @param {Record<string, string|undefined>} env
 * @returns {Record<string, string>} 需要覆盖的环境变量
 */
export function utf8LocaleOverride(env = {}) {
  if (process.platform === 'win32') return {};
  const isUtf8 = (v) => typeof v === 'string' && /utf-?8/i.test(v);
  // 用户已经显式配了 UTF-8，尊重之（不要覆盖成别的语言环境）。
  if (isUtf8(env.LC_ALL) || isUtf8(env.LC_CTYPE)) return {};
  // macOS 一律带 en_US.UTF-8；Linux 上 C.UTF-8 由 glibc 内置，最不容易缺席。
  const locale = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return { LC_ALL: '', LC_CTYPE: locale };
}

/**
 * 运行一条 svn 命令。
 * @param {string} cwd 执行目录。
 * @param {string[]} args 参数（不含开头的 'svn'）。
 * @param {{timeoutMs?: number, maxBytes?: number, env?: Record<string,string>,
 *          signal?: AbortSignal, stdin?: string}} [options]
 *   `stdin` 用于 `--password-from-stdin`：写入后立即关闭。
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function runSvn(cwd, args, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = OUTPUT_CAP_BYTES,
    env,
    signal,
    stdin,
  } = options;

  const binary = resolveSvnBinary();
  if (binary === null) {
    return Promise.resolve({
      exitCode: SPAWN_FAILURE_EXIT,
      stdout: '',
      stderr: 'svn: 未找到 svn 可执行文件（请安装 Subversion，或设置 DSH_SVN_BIN）',
      timedOut: false,
    });
  }

  return new Promise((resolve) => {
    let child;
    // 见 utf8LocaleOverride：不补 UTF-8 的 LC_CTYPE，中文路径会被 svn 转成乱码。
    const baseEnv = env ?? process.env;
    const childEnv = { ...baseEnv, ...utf8LocaleOverride(baseEnv) };
    try {
      child = spawn(binary, args, {
        cwd,
        env: childEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        exitCode: SPAWN_FAILURE_EXIT,
        stdout: '',
        stderr: `svn: 启动失败: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      });
      return;
    }

    if (stdin !== undefined) {
      try { child.stdin.end(String(stdin)); } catch { /* 忽略 */ }
    } else {
      // 不喂数据时关闭 stdin：避免 svn 在极少数分支上等待输入。
      try { child.stdin.end(); } catch { /* 忽略 */ }
    }

    // 收集 Buffer 而不是逐块 toString：多字节 UTF-8 字符可能被切在块边界。
    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      if (outBytes >= maxBytes) return;
      outBytes += chunk.length;
      outChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errBytes >= maxBytes) return;
      errBytes += chunk.length;
      errChunks.push(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
    }, timeoutMs);

    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* 忽略 */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (error) => {
      finish({
        exitCode: SPAWN_FAILURE_EXIT,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: `svn: 启动失败: ${error instanceof Error ? error.message : String(error)}`,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      let stderr = Buffer.concat(errChunks).toString('utf8');
      if (timedOut) {
        stderr = `${stderr}\nsvn: 命令超时（${timeoutMs}ms）`.trim();
        finish({ exitCode: TIMEOUT_EXIT, stdout, stderr, timedOut: true });
        return;
      }
      finish({ exitCode: code ?? SPAWN_FAILURE_EXIT, stdout, stderr, timedOut: false });
    });
  });
}
