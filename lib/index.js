/**
 * dsh-shinki-svn-graph 的 host 半边：Web profile 激活后挂载 SVN 路由
 * （`/shinki-svn/api`）。浏览器半边（lib/client.js）注册侧边栏面板并渲染
 * 日志 / 改动 / 拉取 / 添加 / 提交。
 */
import { createHandler } from './routes.js';

export const name = 'dsh-shinki-svn-graph';

/**
 * 挂载前必须就绪的服务（cordis inject）：没有 inject 声明就访问属性会在
 * 运行时被拒（"cannot get property without inject"）。
 */
export const inject = ['webServer', 'sessions', 'webRuntime'];

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'prefix',
        path: '/shinki-svn',
        handler: createHandler(ctx),
      }),
    ];
    return () => { for (const d of disposers) d(); };
  }, 'dsh-shinki-svn-graph: http routes');
}
