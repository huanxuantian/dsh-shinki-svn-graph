# dsh-shinki-svn-graph

DSH Web GUI 的**侧边栏 SVN 插件**：探测当前工作区（及其一级子目录）中的 Subversion
工作副本，读取提交日志与本地改动，并支持拉取 / 添加 / 提交。

功能刻意保持精简 —— 只有"看历史 + 提交改动"这条主链路，不做分支图、合并、标签管理。

---

## 功能

| 区域 | 能力 |
|---|---|
| 工作副本发现 | 会话工作区本身；工作区不是工作副本时，自动扫描**一级子目录**里以 `.svn` 为根的工作副本（`svn info` 复核），在下拉框中选择 |
| 提交日志 | 默认**最近 20 条**（可切 50/100，选择会持久化），含版本号 / 作者 / 时间 / 提交说明 / 改动路径（点击行展开），使用 `-r HEAD:1` 从最新往回取 |
| 本地改动 | `svn status --xml`：已修改 / 已添加 / 已删除 / 未纳入版本控制 / 缺失 / 冲突…，可勾选条目 |
| 拉取 | `svn update --accept postpone`，冲突不中断而是回传列表单独提示 |
| 添加 | 对勾选的"未纳入版本控制"条目执行 `svn add --parents`（被 ignore 的会被 svn 跳过并如实回报） |
| 提交 | 勾选条目提交（未受控的勾选项会**自动 `svn add`** 再提交），或"提交全部改动"（**只提交已受控改动，绝不自动 add**）；提交说明经**临时文件 + `--encoding UTF-8`** 传递，中文不乱码；勾选「**允许空提交说明**」可用空内容提交（默认拦截只是防误触，svn 本身允许空说明且不需要 `--force-log`） |
| 认证 | **系统凭据优先、交互式输入兜底**（见下） |
| 输出面板 | 展示 svn 的原始输出，便于核对实际发生了什么 |

---

## 认证模型（本插件的核心设计）

两级来源，**默认走第一级**：

1. **系统凭据链** —— 默认不向 host 传任何账号密码，让 svn 自己去查它的凭据缓存
   （macOS 上是 `passtype=keychain`，即**系统钥匙串**）。面板右上角会显示探测结果：
   「系统凭据」= 可用，「需要登录」= 不可用。
2. **交互式输入** —— 系统凭据不可用时（host 返回 `needsCredentials`），点面板上的
   「需要登录」输入账号密码。此时：
   - 用户名走 `--username`（不是秘密）；
   - **密码走 stdin**（`--password-from-stdin`，SVN 1.14+），**绝不进入命令行**，
     `ps` 里看不到明文；
   - 默认允许 svn 写它的凭据缓存（等价于"记住"）；勾选「不保存凭据」才加 `--no-auth-cache`。

所有命令一律附加 `--non-interactive`：svn 需要凭据时会尝试读 `/dev/tty`，宿主进程
若恰有控制终端，那既会**阻塞本次调用**、又会把提示画到别人的终端上。加上该选项后
svn 直接以 `E170001/E215004` 失败，转成面板里的输入提示。

HTTPS 自签名/过期证书可用「信任服务器证书」开关放行
（`--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other`）。

---

## HTTP API（host 半边）

单个 JSON 入口：`POST /shinki-svn/api`，请求体 `{ sessionId, method, ...payload }`，
响应外壳 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, command, output, needsCredentials } }`。

| method | 说明 |
|---|---|
| `init` | 探测工作区是否为工作副本；否则返回一级子目录中的副本列表（`subrepos`） |
| `info` | `svn info --xml` 的结构化结果 |
| `log` | 日志，`limit` 默认 20、`verbose` 默认 true |
| `status` | 本地改动（`svn status --xml`） |
| `authStatus` | 不带凭据探测"系统凭据链"是否可用 |
| `update` / `add` / `commit` | 拉取 / 添加 / 提交 |

- 会话工作目录由 host **权威解析**（活动会话 → 持久化会话头 → 工作区台账），客户端
  传来的 `cwd` 只作为提示，且必须命中台账；`repoPath` 必须是工作区内的相对路径。
- 仅接受回环连接，或 `--trusted-host` 白名单中的 Host（`lib/trust-fence.js`）。

---

## 目录结构

```
dsh-shinki-svn-graph/
├── package.json          # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml      # 把插件行插进 profile roster
├── lib/
│   ├── index.js          # host 半边：挂载 /shinki-svn 前缀路由
│   ├── routes.js         # JSON 分派 + 安全栅栏 + 错误归类
│   ├── svn-service.js    # 工作副本探测/日志/状态/update/add/commit/认证
│   ├── svn-runner.js     # svn 子进程执行（超时、输出上限、密码走 stdin）
│   ├── xml.js            # 零依赖 XML 解析（svn --xml 输出的子集）
│   ├── trust-fence.js    # 回环/受信 Host 栅栏
│   └── client.js         # 浏览器半边：侧边栏面板（classic script + __ModuleLoader__）
└── tests/                # node --test
```

---

## 安装与生效

1. **部署**：把本目录放到 profile 可引用的位置。本机约定：
   - 生效副本：`$PLUGIN_DIR`
   - 源码仓库：`$PLUGIN_DIR`

2. **登记进 profile**（`shinki-desktop`）：

   ```sh
   bash dsh plugin \
     --profile shinki-desktop add file:$PLUGIN_DIR
   ```

   该命令会跑 pnpm 并把包名追加进 profile 的 `dsh.profile.bundles`。
   本地反复迭代时也可以用 `link:<源码目录>`：pnpm 建符号链接，源码即被服务，改完刷新即可。

3. **重启 dsh web**（bundle 成员变更是启动边界）：

   ```sh
   bash dsh --profile shinki-desktop --port 30820 --no-open
   ```

4. **验证**：页面里出现 `dsh-shinki-svn-graph` 的 boot 行，且
   `GET /plugins/??dsh-shinki-svn-graph/client.js&rev=<rev>` 返回 200；侧边栏出现「SVN 版本」Tab。

> ⚠️ 生效副本是 profile 里 pnpm 安装的那份（`file:` 是**快照**）。改源码后必须重跑
> 第 2 步刷新快照，或直接改用 `link:`。host 半边（`lib/*.js`）改动**必须重启** dsh web。

---

## 环境要求

- 本机有 `svn` 可执行文件。查找顺序：`DSH_SVN_BIN` 环境变量 → `PATH` → 常见安装路径
  （`/opt/homebrew/bin/svn`、`/usr/local/bin/svn`、`/usr/bin/svn` …）。找不到时面板显示
  明确提示而不是空白。
- SVN 1.14+ 以获得 `--password-from-stdin`（1.13 及更早会退化为在命令行传密码，
  面板会因此不可用于认证——请升级 svn）。
- Node 20+（宿主进程）。

---

## 开发

```sh
export PATH=/opt/homebrew/bin:$PATH
node --test          # 41 项：XML 解析、路径校验、认证装配、错误归类、
                     #          路由边界，以及一个真实本地 file:// 仓库的端到端用例
```

测试里的端到端用例用 `svnadmin create` 建临时仓库，因此**不需要网络与凭据**。

### 三个容易踩的坑（都已在代码里注释并加测试）

- **locale 必须是 UTF-8**，否则中文路径必挂：宿主进程常常没有 `LANG`/`LC_ALL`
  （→ C locale），svn 会把 argv 里的 UTF-8 路径按当前字符集**二次转换** ——
  `示例目录` 变成 一串乱码（各字的 UTF-8 尾字节还在、
  前导字节被吞），`svn add/commit` 直接报 `E155010 找不到节点`。
  `lib/svn-runner.js` 的 `utf8LocaleOverride()` 给子进程补 `LC_CTYPE=*.UTF-8`，
  并把 `LC_ALL` 置空以解除它对 LC_CTYPE 的压制 —— 只改字符集，**不改消息语言**。
- `svn log <工作副本>` 默认按该路径的 `BASE:1` 取，而工作副本**根目录节点**的版本
  常常是 0（提交子文件不会抬高它）→ 日志会是空的。必须显式 `-r HEAD:1`。
- `svn status` 在非工作副本目录里**退出码是 0**，只在 stderr 打 `W155007` 警告并返回
  空的 `<status>`。不当真就会把"不是工作副本"显示成"工作副本干净"。

### 提交范围可能大于所选（这是 svn 的固有语义）

SVN 要求：若选中路径位于一个**新增(added)目录**之下，该目录必须一并进入提交
pathspec，否则报 `E200009`。服务层会自动把路径**提升**到最上层的新增祖先目录
（`commit()` 返回 `promoted` / `committedPaths`），面板据此提示"提交范围被提升"。
git 有暂存区所以没有这个问题，svn 没有。

另注：`svn status` **不会递归进未受控目录**，此时只报目录本身、不报里面的文件；
目录一旦受控，其中的未受控文件才会单独列出。

### 版本号

`lib/client.js` 里的 `PLUGIN_VERSION` 是 `package.json` 的**硬编码副本**（浏览器半边读不到
package.json），改版本时两处都要改。

---

## 许可

Apache-2.0
