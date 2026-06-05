# rtunnel 管理器

一个 Linear 风格的 SSH 隧道管理面板，用来运行 / 关闭 / 管理多个
[`rtunnel`](https://github.com/yangxikun/rtunnel) 隧道。

两种用法，二选一：
- **桌面 App**（推荐）：双击 `rtunnel.app` 启动，独立窗口、Dock 图标，跟普通 macOS 软件一样。
- **CLI 模式**：`node server.js`，在浏览器打开 `http://127.0.0.1:7070`。和以前一样。

## 前提

- 已安装 `rtunnel` 并在 `PATH` 中（`which rtunnel` 能找到）
- 已安装 Node.js（`node -v`，CLI 模式和 App 构建期都需要）

## 用法 A：桌面 App（双击启动）

### 一次性构建

```bash
npm install                  # 安装 electron + electron-builder（首次约 30s）
npm run dist                 # 产出 dist/rtunnel-*.dmg 与 dist/mac-arm64/rtunnel.app
```

构建产物：
- `dist/mac-arm64/rtunnel.app` —— 可直接双击运行，也可拖进 `/Applications`。
- `dist/rtunnel-1.0.0-arm64.dmg` —— 分发用的安装镜像，双击挂载、拖入 Applications。

> 仅构建 .app 不打 DMG：`npm run dist:dir`（更快）

### 日常使用

双击 `rtunnel.app` 即可：
- 内置一个 HTTP 服务（监听 127.0.0.1:7070），由 Electron 窗口加载。
- 关闭窗口 → 退出整个 App，端口随之释放。已运行的 `rtunnel` 子进程独立存活，不受影响。
- 应用图标：高分辨率 `build/icon.icns`（16/32/128/256/512px + @2x），不会被 BrowserWindow 的低分图标覆盖。

> **首次打开提示**：因为这个 .app 是 ad-hoc 签名（没有 Apple Developer ID），
> macOS Gatekeeper 首次会拦住。在「**系统设置 → 隐私与安全性**」拉到最下面点
> 「**仍要打开**」一次即可，之后不会再问。
>
> 命令行等价：`xattr -dr com.apple.quarantine /Applications/rtunnel.app`

### 配置文件位置（桌面 App 模式）

App 不写自己的 .app 包内（asar 只读）。隧道列表落在用户可写的：

```
~/Library/Application Support/rtunnel-manager/tunnels.json   # 隧道列表
~/Library/Application Support/rtunnel-manager/runtime.json   # 运行状态（pid/status）
~/Library/Application Support/rtunnel-manager/logs/          # 每条隧道的日志
```

需要跨设备同步可手动 symlink `tunnels.json` 到 iCloud / Dropbox 目录。

## 用法 B：CLI 模式（保留原行为）

```bash
# 方式一：后台常驻（关掉终端也不影响）
./start.sh

# 方式二：前台运行
node server.js

# 换个 Web 端口
RT_MANAGER_PORT=8090 ./start.sh
```

启动后浏览器打开 **http://127.0.0.1:7070**（macOS 会自动打开）。
CLI 模式下 `tunnels.json` 仍写在脚本同目录（用于 iCloud/Dropbox 同步）。

## 使用

1. 「新建隧道」里填：
   - **远程 URL**：例如 `https://nat2-notebook-inspire.sii.edu.cn/.../proxy/47230/`
   - **用户名**：登录服务器的用户名，默认 `root`
   - **本地端口**：例如 `4444`（之后用它 ssh 进去）
   - **额外参数**（可选）：如 `--secure`
2. 点「添加」→ 点「启动」。
3. 启动成功后（状态变「运行中」），条目里会出现一条**高亮的 ssh 指令**
   `ssh -p 4444 root@127.0.0.1`，点一下即可复制粘贴到终端登录。

等价命令：`rtunnel <远程URL> <本地端口> [额外参数]`

## 修改已添加的隧道

每条隧道都有「**编辑**」按钮：就地展开表单，可改名称 / URL / 用户名 / 端口 / 额外参数。

- **未运行**：保存后下次「启动」用新配置。
- **运行中**：会多出「**保存并重启**」按钮——先保存再用新配置重启（同样过直连探测）。
  只点「保存」则已在跑的旧进程不受影响。

## 直连保证

只让 **rtunnel 这条命令**走直连，**不影响**你 shell 里给其它程序用的代理：

1. **子进程剔除代理变量**：启动 `rtunnel` 时清掉 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY`
   （含小写形式），保证 rtunnel 永远直连；你的全局代理原样保留。
2. **启动前直连探测**：对远程 URL 探测一次（Node 原生请求本身就是直连），
   连得上才放行，连不上拒绝并给出原因。

## 远程健康检查

`rtunnel` 是「懒连接」——本地进程存活 ≠ 远程可达（远程关机后客户端进程照样活着，
只在真正建连时才失败）。管理器每 15 秒后台做一次**端到端 SSH 探测**：
TCP 连本地隧道端口，读首包看是否能拿到 `SSH-2.0-...` 协议头。整条链路
（本地 rtunnel → 远程网关 → 远程 sshd）都通才算可达。

- 拿不到 SSH banner / 超时 → 显示「**已断开**」红色徽章，鼠标悬停看原因
  （最常见就是远程服务器已关机、断网、或 sshd 没起来）
- 同时探一次代理 URL，把原因说得更具体：是网关挂了，还是网关在但后端挂了
- 这只是显示信号，不会自动停掉本地隧道，方便判断是远程问题还是本地问题
- 启动后 2 秒会主动探一次，远程若已关机能很快看到「已断开」，不必等下一轮 15 秒

## 后台与存活

- `rtunnel` 进程通过 `detached + unref` **完全脱离**管理器：
  关掉前端、甚至关掉管理器，已启动的隧道仍在后台运行。
- 管理器重启后**自动接管**：检测每条隧道的进程是否存活并刷新状态——
  重开前端依然能停掉之前启动的隧道。
- 顶部「**退出管理器**」按钮可优雅关闭后台进程并释放 7070 端口，已运行的隧道不受影响。

## 数据位置（重要：跨设备同步设计）

配置拆成两份，分别放在不同位置：

| 文件 | 位置 | 是否跨设备同步 | 内容 |
|---|---|---|---|
| `tunnels.json` | 脚本同目录 | ✅ 是（如果脚本在 iCloud/Dropbox 同步目录） | 隧道列表（URL/端口/名字/用户/参数） |
| `runtime.json` | `~/Library/Application Support/rtunnel-manager/` | ❌ 否（本机独占） | 运行状态（pid / status / startedAt） |
| 各隧道日志 | `~/Library/Application Support/rtunnel-manager/logs/<id>.log` | ❌ 否 | 单条隧道的输出 |
| 管理器日志 | `~/Library/Application Support/rtunnel-manager/manager.log` | ❌ 否 | manager 本身的 stdout/stderr |

### 为什么要拆开

如果整个数据目录都放在 iCloud 同步目录下，会出问题：`pid` 是机器本地编号，
A 机的 PID 在 B 机上几乎肯定不存在，B 机的 `reconcile()` 会把"对方机器还活着的隧道"
误判为 stopped 并写回文件；同步回 A 机后，A 机以为这条没在跑，下次启动就撞
`EADDRINUSE`。

拆分后：

- **多台 Mac 共享隧道列表**：A 机加一条，iCloud 同步过去，B 机刷新就能看到
- **运行状态各管各的**：A 机启动不会影响 B 机的视图，反之亦然
- **删除请谨慎**：A 机删了某条会同步删 B 机的；如果 B 机这条还在跑，会变成
  管理器看不见的孤儿进程，得手动 `lsof -nP -iTCP:<port>` + `kill`

历史版本（数据放在脚本同目录的 `data/` 或 `~/.rtunnel-manager/`）首次启动时会
自动迁移到上面的新布局，旧数据原样保留以防万一。

## 停止管理器

点前端右上角「退出管理器」即可。或命令行：

```bash
pkill -f "node server.js"     # 不影响已脱离的 rtunnel 隧道
```

## 文件结构

```
rtunnel-manager/
├── server.js              # 主程序：HTTP server + 前端页面 + 子进程管理（CLI / Electron 共用）
├── electron-main.js       # Electron 主进程：拉起 server.js + BrowserWindow
├── package.json           # npm + electron-builder 构建配置
├── start.sh               # CLI 模式：后台启动脚本（nohup + disown）
├── build/
│   ├── icon.svg           # App 图标源（RT + 浅色圆角底 + 低饱和蓝）
│   ├── icon.icns          # 编译好的 macOS 应用图标（含 16~1024 全套尺寸）
│   └── icon-1024.png      # 中间产物（用于 sips 缩放）
├── scripts/
│   └── build-icon.sh      # SVG → 1024 PNG → iconset → icns 的脚本
├── tunnels.json           # 隧道列表（CLI 模式落在此处）
└── README.md
```
