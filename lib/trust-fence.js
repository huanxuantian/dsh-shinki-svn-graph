/**
 * /shinki-svn 路由的浏览器信任栅栏：只允许回环连接（Host 头为回环名）或
 * `--trusted-host` 白名单中的主机访问，避免把 dsh web 暴露到局域网后，
 * 任何人都能通过它对本机任意工作副本执行 add/commit。
 *
 * 与 dsh-shinki-git-graph / dsh-better-sidebar 的栅栏保持同构，便于两套插件
 * 在同一份 webRuntime 配置下行为一致。
 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 套接字远端地址是否回环。 */
export function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(address);
}

/** Host 头是否指向回环主机。 */
export function isLoopbackHost(hostHeader) {
  return LOOPBACK_HOSTNAMES.has(hostnameOf(hostHeader));
}

/** 从 Host 头取出主机名（去掉端口与方括号）。 */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

/**
 * 构建绑定到宿主上下文的栅栏。
 * @param {{webRuntime?: {trustedHosts?: readonly string[]}}} ctx
 */
export function createFence(ctx) {
  const trusted = () => {
  // DSH 0.2.1 移除了 webRuntime 服务：直接读 ctx.webRuntime 会抛异常（cordis 未注入访问）
  // 之前每次请求都在 fence 里抛 ⇒ 路由统一 500。这里改为逐层 try/catch，拿不到就用空列表（仅回环可访问）。
  try { const w = ctx && ctx.web; if (w && Array.isArray(w.trustedHosts)) return w.trustedHosts; } catch { /* 未注入 */ }
  try { const r = ctx && ctx.webRuntime; if (r && Array.isArray(r.trustedHosts)) return r.trustedHosts; } catch { /* 0.2.1 已移除 */ }
  return [];
};
  return {
    /**
     * 校验一次请求。
     * @returns {{ok: true} | {ok: false, code: string, message: string}}
     */
    check(req) {
      const address = req.socket?.remoteAddress;
      if (typeof address === 'string' && isLoopbackAddress(address)) return { ok: true };
      const host = hostnameOf(req.headers?.host);
      if (host !== '' && trusted().includes(host)) return { ok: true };
      return {
        ok: false,
        code: 'forbidden',
        message: '非受信任客户端（需回环连接或 --trusted-host 白名单）',
      };
    },
  };
}
