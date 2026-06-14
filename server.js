#!/usr/bin/env node
'use strict';

/*
 * rtunnel 管理器 —— 单文件、零依赖（仅用 Node 内置模块）。
 *
 * 用法：
 *   node server.js                # 默认监听 http://127.0.0.1:7070
 *   RT_MANAGER_PORT=8090 node server.js
 *   nohup node server.js >/dev/null 2>&1 &   # 脱离终端常驻
 *
 * 前提：机器上已安装 rtunnel，且在 PATH 中。
 */

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// ---------- 路径与配置 ----------
// 配置拆成两份，跨设备共享列表但运行状态各管各的：
//   - SHARED_CONFIG: 跟着 server.js 走（通常在 iCloud / Dropbox 同步目录），
//     只存"共享字段"——id / name / url / port / user / args / rtunnelCommand / useSudo / skipDirectCheck。
//     sudo 密码只在启动请求里临时使用，绝不写入配置文件。
//     在 A 机加一条隧道，B 机自动也能看到。
//   - RUNTIME_FILE:  本机 Library 下，按 id 存 { pid, status, startedAt }。
//     pid 是机器本地编号，绝不能跨设备共享，否则 reconcile() 会把对方机器
//     还活着的隧道误判为 stopped 并写回，下次启动就撞 EADDRINUSE。
// 打包成 Electron .app 后 __dirname 落在只读的 asar 里，不能在那写配置。
// 允许通过 RT_SHARED_CONFIG 显式指定一个可写位置（Electron 主进程会设置它），
// CLI 模式下保持原行为：与 server.js 同目录（这样跟着 iCloud / Dropbox 同步走）。
const SHARED_CONFIG = process.env.RT_SHARED_CONFIG || path.join(__dirname, 'tunnels.json');
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'rtunnel-manager');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const WEB_PORT = parseInt(process.env.RT_MANAGER_PORT || '7070', 10);

// 历史数据目录，按"新→旧"顺序尝试一次性迁移；命中第一个含 tunnels.json 的就用它。
// 老格式是单文件 [{ id, name, url, port, user, args, pid, status, startedAt }, ...]，
// 迁移时会拆成 SHARED_CONFIG + RUNTIME_FILE 两份。
//   1) ~/Library/Application Support/rtunnel-manager/tunnels.json  —— 上一版（按机器隔离但不共享）
//   2) 脚本同目录的 data/tunnels.json                                —— 更早版（iCloud 串味的那版）
//   3) ~/.rtunnel-manager/tunnels.json                              —— 最早版
const LEGACY_CONFIG_FILES = [
  path.join(DATA_DIR, 'tunnels.json'),
  path.join(__dirname, 'data', 'tunnels.json'),
  path.join(os.homedir(), '.rtunnel-manager', 'tunnels.json'),
];

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy',
];

function nvmBinDirs() {
  const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    return fs.readdirSync(root)
      .filter((name) => name.startsWith('v'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => path.join(root, name, 'bin'));
  } catch (_) {
    return [];
  }
}

// GUI 启动（双击 .app）继承的是 launchd 的精简 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
// 不含 Homebrew / nvm 路径，于是 spawn('rtunnel'/'wstunnel') 会 ENOENT。
// 这里补齐常见安装目录。
const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',   // Apple Silicon Homebrew
  '/usr/local/bin',      // Intel Homebrew / 手动安装
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), 'go', 'bin'), // rtunnel 是 Go 程序，go install 默认落点
  ...nvmBinDirs(),       // npm -g 安装的 wstunnel 常见落点
];

// 把缺失的常见 bin 目录补进 PATH，保留原有顺序与内容。
function augmentedPath(prependDirs = []) {
  const cur = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = [];
  for (const d of [...prependDirs, ...cur, ...EXTRA_BIN_DIRS]) {
    if (!merged.includes(d)) merged.push(d);
  }
  return merged.join(':');
}

function resolveBinByName(name) {
  for (const d of augmentedPath().split(':')) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* 继续找下一个 */ }
  }
  return null;
}

// 在补齐后的 PATH 里把 rtunnel 解析为绝对路径；找不到返回 null。
function resolveRtunnelBin() {
  return resolveBinByName('rtunnel');
}

function normalizeRtunnelCommand(raw) {
  const cmd = String(raw || '').trim();
  if (/[\0\r\n]/.test(cmd)) throw new Error('隧道命令不能包含换行或空字符');
  return cmd;
}

function resolveRtunnelCommand(t) {
  const custom = normalizeRtunnelCommand(t.rtunnelCommand || '');
  if (!custom) {
    const bin = resolveRtunnelBin();
    if (!bin) {
      return {
        ok: false,
        reason: '找不到 rtunnel 命令。请确认已安装（brew/go install），'
          + `已搜索：${EXTRA_BIN_DIRS.join(', ')}。`,
      };
    }
    return { ok: true, bin, label: 'rtunnel' };
  }

  if (custom.includes('/')) {
    try {
      fs.accessSync(custom, fs.constants.X_OK);
      return { ok: true, bin: custom, label: custom };
    } catch (e) {
      return { ok: false, reason: `自定义隧道命令不可执行: ${custom}` };
    }
  }

  const bin = resolveBinByName(custom);
  if (!bin) return { ok: false, reason: `找不到自定义隧道命令: ${custom}` };
  return { ok: true, bin, label: custom };
}

function isWstunnelCommand(resolved) {
  return path.basename(resolved.bin) === 'wstunnel';
}

function buildTunnelArgs(t, resolved, extra) {
  if (isWstunnelCommand(resolved)) {
    // npm 的 wstunnel 默认可能只监听 ::1；显式绑定 127.0.0.1，匹配前端展示的 ssh 命令。
    return ['-t', `127.0.0.1:${t.port}:127.0.0.1:22`, ...extra, t.url];
  }
  return [t.url, String(t.port), ...extra];
}

function splitArgs(input) {
  const s = String(input || '').trim();
  if (!s) return [];
  const out = [];
  let cur = '';
  let quote = null;
  let escaped = false;
  let tokenStarted = false;
  for (const ch of s) {
    if (escaped) {
      cur += ch;
      escaped = false;
      tokenStarted = true;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      tokenStarted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        out.push(cur);
        cur = '';
        tokenStarted = false;
      }
      continue;
    }
    cur += ch;
    tokenStarted = true;
  }
  if (escaped) cur += '\\';
  if (quote) throw new Error('额外参数中的引号未闭合');
  if (tokenStarted) out.push(cur);
  return out;
}

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 一次性迁移：SHARED_CONFIG 不存在时，找第一个能用的老 tunnels.json，
// 把"共享字段"写到 SHARED_CONFIG，"运行时字段"写到 RUNTIME_FILE。
// 同时把对应目录的 logs/ 拷过来。只拷不删，旧文件原样保留以防万一。
function migrateLegacy() {
  try {
    if (fs.existsSync(SHARED_CONFIG)) return; // 已迁过，不动
    const sourceFile = LEGACY_CONFIG_FILES.find((f) => fs.existsSync(f));
    if (!sourceFile) return;

    const raw = fs.readFileSync(sourceFile, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;

    const shared = list.map((t) => ({
      id: t.id, name: t.name, url: t.url, port: t.port,
      user: t.user || 'root', args: t.args || '',
      rtunnelCommand: t.rtunnelCommand || '',
      useSudo: !!t.useSudo,
      skipDirectCheck: !!t.skipDirectCheck,
    }));
    const runtime = {};
    for (const t of list) {
      // 历史 pid 可能来自别的进程甚至别的机器，统一清零，让 reconcile 重新认。
      runtime[t.id] = { pid: null, status: 'stopped', startedAt: t.startedAt || null };
    }
    writeIfChanged(SHARED_CONFIG, JSON.stringify(shared, null, 2));
    writeIfChanged(RUNTIME_FILE, JSON.stringify(runtime, null, 2));

    const legacyLogs = path.join(path.dirname(sourceFile), 'logs');
    if (fs.existsSync(legacyLogs) && legacyLogs !== LOG_DIR) {
      for (const f of fs.readdirSync(legacyLogs)) {
        try {
          fs.copyFileSync(path.join(legacyLogs, f), path.join(LOG_DIR, f));
        } catch (_) { /* 单个日志拷贝失败忽略 */ }
      }
    }
    console.log(`已迁移历史隧道: ${sourceFile} -> ${SHARED_CONFIG} (+ ${RUNTIME_FILE})`);
  } catch (e) {
    console.warn(`迁移旧数据时出错（忽略，按空配置继续）: ${e.message}`);
  }
}

// 共享配置（iCloud 同步）+ 本机 runtime 合并成跟旧版同形态的对象，
// 这样调用方（reconcile / publicView 等）完全不用动。
function loadTunnels() {
  let shared = [];
  try {
    const data = JSON.parse(fs.readFileSync(SHARED_CONFIG, 'utf8'));
    if (Array.isArray(data)) shared = data;
  } catch (_) { /* 文件不存在或解析失败：按空配置走 */ }

  let runtime = {};
  try {
    const data = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (data && typeof data === 'object' && !Array.isArray(data)) runtime = data;
  } catch (_) { /* 同上 */ }

  return shared.map((s) => {
    const r = runtime[s.id] || {};
    return {
      id: s.id,
      name: s.name,
      url: s.url,
      port: s.port,
      user: s.user || 'root',
      args: s.args || '',
      rtunnelCommand: s.rtunnelCommand || '',
      useSudo: !!s.useSudo,
      skipDirectCheck: !!s.skipDirectCheck,
      pid: r.pid || null,
      status: r.status || 'stopped',
      startedAt: r.startedAt || null,
    };
  });
}

// 写入时拆分回两个文件；只有内容真变了才落盘，避免：
//   - iCloud 反复 sync SHARED_CONFIG（启动/停止时只动 runtime，不应惊扰 iCloud）
//   - 多机并发改 runtime 时产生无谓的 mtime 抖动
function saveTunnels(tunnels) {
  const shared = tunnels.map((t) => ({
    id: t.id, name: t.name, url: t.url, port: t.port,
    user: t.user || 'root', args: t.args || '',
    rtunnelCommand: t.rtunnelCommand || '',
    useSudo: !!t.useSudo,
    skipDirectCheck: !!t.skipDirectCheck,
  }));
  const runtime = {};
  for (const t of tunnels) {
    runtime[t.id] = {
      pid: t.pid || null,
      status: t.status || 'stopped',
      startedAt: t.startedAt || null,
    };
  }
  writeIfChanged(SHARED_CONFIG, JSON.stringify(shared, null, 2));
  writeIfChanged(RUNTIME_FILE, JSON.stringify(runtime, null, 2));
}

function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch (_) { /* 文件不存在 → 继续写 */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// ---------- 进程工具 ----------
function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 存在但无权限发信号时也算活着
  }
}

// 启动时重新接管：刷新每条隧道的真实状态
function reconcile(tunnels) {
  let changed = false;
  for (const t of tunnels) {
    const alive = isAlive(t.pid);
    if (alive && t.status !== 'running') { t.status = 'running'; changed = true; }
    if (!alive && (t.status === 'running' || t.pid)) {
      t.status = 'stopped'; t.pid = null; changed = true;
    }
  }
  if (changed) saveTunnels(tunnels);
  return tunnels;
}

// ---------- 直连校验 ----------
// 对目标 URL 做一次直连探测（Node 原生请求不走环境代理）。
// 只要 TLS+HTTP 连通并返回任意状态码即视为可达（ws 端点可能回 400/426）。
function probeUrl(rawUrl, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (e) {
      resolve({ ok: false, reason: `URL 格式无效: ${e.message}` });
      return;
    }
    // rtunnel 接受 http(s):// 与 ws(s):// —— 明文走 http，加密走 https
    const plain = u.protocol === 'http:' || u.protocol === 'ws:';
    const mod = plain ? http : https;
    const opts = {
      method: 'GET',
      host: u.hostname,
      port: u.port || (plain ? 80 : 443),
      path: u.pathname + u.search,
      timeout: timeoutMs,
      // 仅探测连通性，不做证书校验，避免代理/自签名导致误判
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'rtunnel-manager-probe' },
    };
    const req = mod.request(opts, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: `连接超时（${timeoutMs}ms），目标可能不可直达` });
    });
    req.on('error', (err) => {
      resolve({ ok: false, reason: `无法直连目标: ${err.message}` });
    });
    req.end();
  });
}

// 端到端 SSH 探测：TCP 连本地隧道端口，读首包看是否是 SSH 协议头（"SSH-2.0-..."）。
// 这条链路要走完整路径：本地 rtunnel → 远程网关 → 远程 sshd。任何一环断（远程关机
// 最常见）都会拿不到 banner。比 probeUrl 准——proxy 网关常在远端宕机时仍返回 200。
function probeSshBanner(port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('data', (chunk) => {
      const banner = chunk.toString('utf8', 0, Math.min(chunk.length, 64));
      if (banner.startsWith('SSH-')) {
        finish({ ok: true, banner: banner.split(/\r?\n/)[0] });
      } else {
        finish({ ok: false, reason: 'TCP 已连通但未收到 SSH 协议头' });
      }
    });
    socket.on('timeout', () => finish({ ok: false, reason: `SSH 探测超时（${timeoutMs}ms），远程服务器可能已关机或断网` }));
    socket.on('error', (err) => finish({ ok: false, reason: `无法建立 SSH 连接: ${err.message}` }));
    socket.on('close', () => finish({ ok: false, reason: '连接被对端关闭，未收到 SSH 协议头' }));
    socket.connect(port, '127.0.0.1');
  });
}

// ---------- 远程健康检查 ----------
// rtunnel 是「懒连接」：本地进程存活 ≠ 远程可达（远程关机后客户端进程照样活着，
// 只在真正有连接时才会拨远程并失败）。所以只看 pid 检测不出远程关机。
// 这里对每条「运行中」隧道周期性直连探测远程 URL，结果存内存（不写盘）。
const health = new Map(); // id -> { reachable: bool, checkedAt: iso, reason: string|null }

async function checkOne(t) {
  // 主信号：端到端 SSH banner 探测。能拿到 SSH-banner 说明整条链路都通。
  const ssh = await probeSshBanner(t.port, 5000);
  if (ssh.ok) {
    health.set(t.id, { reachable: true, checkedAt: new Date().toISOString(), reason: null });
    return;
  }
  // SSH 探测失败 → 再探一次代理 URL，把原因说得更具体一点（究竟是网关挂了，还是后端挂了）
  let reason = ssh.reason;
  try {
    const probe = await probeUrl(t.url, 6000);
    if (!probe.ok) reason = `远程网关不可达：${probe.reason}`;
    else if (probe.status >= 500) reason = `远程网关返回 ${probe.status}（后端可能已下线）`;
    // 网关 2xx/3xx/4xx 但 SSH 拿不到 → 远程主机大概率关机，保留 ssh.reason
  } catch (_) { /* URL 探测异常忽略，沿用 ssh.reason */ }
  health.set(t.id, { reachable: false, checkedAt: new Date().toISOString(), reason });
}

// 探测所有运行中的隧道；非运行的清掉其健康记录。
async function runHealthChecks() {
  const tunnels = reconcile(loadTunnels());
  const running = [];
  for (const t of tunnels) {
    if (t.status === 'running') running.push(t);
    else health.delete(t.id);
  }
  await Promise.all(running.map((t) => checkOne(t).catch(() => {
    health.set(t.id, { reachable: false, checkedAt: new Date().toISOString(), reason: '健康检查异常' });
  })));
}

// ---------- GPU 使用情况 ----------
// 节点已配置免密公钥，可非交互式 SSH 进去跑 nvidia-smi。结果存内存（不写盘）：
//   gpuStats: id -> { gpus: [...], queriedAt: iso, error: string|null }
// gpus 每项: { index, name, util(%), memUsed(MiB), memTotal(MiB), temp(℃), power(W) }
const gpuStats = new Map();

const NVIDIA_QUERY = 'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits';

// 隧道连的都是 127.0.0.1:<port>，同一端口被不同节点复用会触发 known_hosts 冲突；
// localhost 隧道场景主机密钥校验意义不大，直接绕过。BatchMode 确保免密不可用时
// 快速失败而非挂起等密码。
function gpuSshArgs(t) {
  return [
    '-p', String(t.port),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    `${t.user || 'root'}@127.0.0.1`,
    NVIDIA_QUERY,
  ];
}

// 把 nvidia-smi 的 CSV 行解析成数字字段；解析不出的字段留 null。
function parseGpuCsv(stdout) {
  const num = (s) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  };
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const c = line.split(',').map((x) => x.trim());
      return {
        index: num(c[0]),
        name: c[1] || '',
        util: num(c[2]),
        memUsed: num(c[3]),
        memTotal: num(c[4]),
        temp: num(c[5]),
        power: num(c[6]),
      };
    });
}

function queryGpu(t) {
  return new Promise((resolve) => {
    execFile('ssh', gpuSshArgs(t), {
      timeout: 8000,
      env: childEnvWithoutProxy(),
      maxBuffer: 1 << 20,
    }, (err, stdout, stderr) => {
      if (err) {
        // 无 nvidia-smi / 连接失败 / 超时 —— 记原因，gpus 留空，前端不展示。
        const reason = (stderr || err.message || '').trim().split(/\r?\n/)[0] || 'GPU 查询失败';
        gpuStats.set(t.id, { gpus: [], queriedAt: new Date().toISOString(), error: reason });
        resolve();
        return;
      }
      const gpus = parseGpuCsv(stdout);
      gpuStats.set(t.id, { gpus, queriedAt: new Date().toISOString(), error: gpus.length ? null : '未解析到 GPU' });
      resolve();
    });
  });
}

// 查所有运行中隧道的 GPU；非运行的清掉记录。
async function runGpuChecks() {
  const tunnels = reconcile(loadTunnels());
  const running = [];
  for (const t of tunnels) {
    if (t.status === 'running') running.push(t);
    else gpuStats.delete(t.id);
  }
  await Promise.all(running.map((t) => queryGpu(t).catch(() => {
    gpuStats.set(t.id, { gpus: [], queriedAt: new Date().toISOString(), error: 'GPU 查询异常' });
  })));
}

// rtunnel 子进程会剔除代理变量（见 childEnvWithoutProxy），始终直连运行——
// 不影响你 shell 里给其它程序用的代理。这里只做一次「直连可达」探测：
// 探测本身不走代理（Node 原生请求不读代理环境变量），连得上才放行，否则拒绝。
async function directConnectionGate(url) {
  const probe = await probeUrl(url);
  if (!probe.ok) {
    return { ok: false, reason: probe.reason };
  }
  return { ok: true, status: probe.status };
}

// ---------- 启动 / 停止 ----------
function childEnvWithoutProxy(prependPathDirs = []) {
  const env = Object.assign({}, process.env);
  for (const k of PROXY_ENV_KEYS) delete env[k];
  env.PATH = augmentedPath(prependPathDirs); // GUI 启动时补齐 Homebrew/nvm 等路径，保证子进程能找到命令和 node
  return env;
}

function startTunnel(t, opts = {}) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `${t.id}.log`);
    let out;
    try {
      out = fs.openSync(logPath, 'a');
    } catch (e) {
      resolve({ ok: false, reason: `无法打开日志文件: ${e.message}` });
      return;
    }
    fs.writeSync(out, `\n===== 启动于 ${new Date().toISOString()} =====\n`);

    let extra;
    try {
      extra = splitArgs(t.args || '');
    } catch (e) {
      fs.closeSync(out);
      resolve({ ok: false, reason: e.message });
      return;
    }
    const resolved = resolveRtunnelCommand(t);
    if (!resolved.ok) {
      fs.closeSync(out);
      resolve({ ok: false, reason: resolved.reason });
      return;
    }
    const args = buildTunnelArgs(t, resolved, extra);

    const useSudo = !!t.useSudo;
    const sudoPassword = String(opts.sudoPassword || '');
    if (useSudo && !sudoPassword) {
      fs.closeSync(out);
      resolve({ ok: false, reason: '该隧道设置为 sudo 启动，请填写 sudo/root 密码。' });
      return;
    }

    const sudoBin = '/usr/bin/sudo';
    const command = useSudo ? sudoBin : resolved.bin;
    const spawnArgs = useSudo ? ['-S', '-p', '', '--', resolved.bin, ...args] : args;
    fs.writeSync(out, `命令: ${useSudo ? 'sudo ' : ''}${resolved.bin} ${args.map((x) => JSON.stringify(x)).join(' ')}\n`);

    let child;
    try {
      child = spawn(command, spawnArgs, {
        detached: true,
        stdio: [useSudo ? 'pipe' : 'ignore', out, out],
        env: childEnvWithoutProxy([path.dirname(resolved.bin)]),
        cwd: os.homedir(),
      });
      if (useSudo && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(sudoPassword + '\n');
      }
    } catch (e) {
      fs.closeSync(out);
      resolve({ ok: false, reason: `启动失败: ${e.message}` });
      return;
    }

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(out); } catch (_) {}
      const hint = err.code === 'ENOENT'
        ? '找不到 rtunnel 命令，请确认已安装并在 PATH 中。'
        : err.message;
      resolve({ ok: false, reason: `启动失败: ${hint}` });
    });

    child.unref();
    const pid = child.pid;

    // 给 rtunnel 一点时间，确认没有立刻退出（URL/参数错误会立即退出）
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(out); } catch (_) {}
      if (isAlive(pid)) {
        t.pid = pid;
        t.status = 'running';
        t.startedAt = new Date().toISOString();
        resolve({ ok: true, pid });
      } else {
        t.pid = null;
        t.status = 'stopped';
        const tail = readLogTail(logPath, 1200);
        resolve({ ok: false, reason: `rtunnel 启动后立即退出。日志末尾:\n${tail}` });
      }
    }, 700);
  });
}

function stopTunnel(t) {
  if (t.pid && isAlive(t.pid)) {
    try { process.kill(-t.pid, 'SIGTERM'); }
    catch (_) {
      try { process.kill(t.pid, 'SIGTERM'); } catch (_) {}
    }
  }
  t.pid = null;
  t.status = 'stopped';
}

function readLogTail(logPath, bytes) {
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(logPath, 'r');
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) {
    return '(无日志)';
  }
}

// ---------- HTTP 辅助 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function publicView(tunnels) {
  return tunnels.map((t) => {
    const h = health.get(t.id);
    const g = gpuStats.get(t.id);
    return {
      id: t.id,
      name: t.name,
      url: t.url,
      port: t.port,
      user: t.user || 'root',
      args: t.args || '',
      rtunnelCommand: t.rtunnelCommand || '',
      useSudo: !!t.useSudo,
      skipDirectCheck: !!t.skipDirectCheck,
      status: t.status,
      pid: t.pid || null,
      startedAt: t.startedAt || null,
      // 远程可达性：true/false 已探测，null 尚未探测（刚启动）
      reachable: t.status === 'running' && h ? h.reachable : null,
      checkedAt: h ? h.checkedAt : null,
      checkReason: h ? h.reason : null,
      // GPU 使用情况：null = 未查 / 非运行；否则 { gpus, queriedAt, error }
      gpu: t.status === 'running' && g ? g : null,
    };
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${WEB_PORT}`);
  const pathname = u.pathname;
  const method = req.method;

  try {
    if (method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML_PAGE);
      return;
    }

    if (method === 'GET' && pathname === '/api/tunnels') {
      const tunnels = reconcile(loadTunnels());
      sendJson(res, 200, { tunnels: publicView(tunnels) });
      return;
    }

    // 退出管理器本身。隧道是脱离终端的独立进程，关闭管理器不影响它们继续运行。
    if (method === 'POST' && pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true });
      console.log('收到退出请求，管理器即将关闭。已运行的隧道不受影响。');
      // 先把响应刷给前端，再退出进程
      setTimeout(() => {
        server.close(() => process.exit(0));
        // 兜底：连接未及时关闭也强制退出
        setTimeout(() => process.exit(0), 500);
      }, 100);
      return;
    }

    if (method === 'POST' && pathname === '/api/tunnels') {
      const body = await readBody(req);
      const url = (body.url || '').trim();
      const port = parseInt(body.port, 10);
      let rtunnelCommand;
      try { rtunnelCommand = normalizeRtunnelCommand(body.rtunnelCommand); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
      if (!url) return sendJson(res, 400, { error: 'url 不能为空' });
      if (!port || port < 1 || port > 65535) return sendJson(res, 400, { error: '端口无效（1-65535）' });
      const tunnels = loadTunnels();
      const t = {
        id: crypto.randomUUID(),
        name: (body.name || '').trim() || `tunnel-${port}`,
        url,
        port,
        user: (body.user || '').trim() || 'root',
        args: (body.args || '').trim(),
        rtunnelCommand,
        useSudo: !!body.useSudo,
        skipDirectCheck: !!body.skipDirectCheck,
        pid: null,
        status: 'stopped',
        startedAt: null,
      };
      tunnels.push(t);
      saveTunnels(tunnels);
      sendJson(res, 200, { tunnel: publicView([t])[0] });
      return;
    }

    // /api/tunnels/:id/(start|stop|restart)  以及  DELETE /api/tunnels/:id
    const m = pathname.match(/^\/api\/tunnels\/([^/]+)(?:\/(start|stop|restart))?$/);
    if (m) {
      const id = m[1];
      const action = m[2];
      const tunnels = reconcile(loadTunnels());
      const t = tunnels.find((x) => x.id === id);
      if (!t) return sendJson(res, 404, { error: '未找到该隧道' });

      if (method === 'DELETE') {
        stopTunnel(t);
        const next = tunnels.filter((x) => x.id !== id);
        saveTunnels(next);
        return sendJson(res, 200, { ok: true });
      }

      // 编辑：更新隧道的可改字段（名称 / URL / 用户名 / 端口 / 额外参数）。
      // 只改配置，不动正在运行的进程——新配置在下次启动/重启时生效。
      if (method === 'PUT') {
        const body = await readBody(req);
        const url = (body.url || '').trim();
        const port = parseInt(body.port, 10);
        let rtunnelCommand;
        try { rtunnelCommand = normalizeRtunnelCommand(body.rtunnelCommand); }
        catch (e) { return sendJson(res, 400, { error: e.message }); }
        if (!url) return sendJson(res, 400, { error: 'url 不能为空' });
        if (!port || port < 1 || port > 65535) return sendJson(res, 400, { error: '端口无效（1-65535）' });
        t.url = url;
        t.port = port;
        t.name = (body.name || '').trim() || `tunnel-${port}`;
        t.user = (body.user || '').trim() || 'root';
        t.args = (body.args || '').trim();
        t.rtunnelCommand = rtunnelCommand;
        t.useSudo = !!body.useSudo;
        t.skipDirectCheck = !!body.skipDirectCheck;
        saveTunnels(tunnels);
        return sendJson(res, 200, { tunnel: publicView([t])[0] });
      }

      if (method === 'POST' && action === 'stop') {
        stopTunnel(t);
        saveTunnels(tunnels);
        return sendJson(res, 200, { tunnel: publicView([t])[0] });
      }

      if (method === 'POST' && (action === 'start' || action === 'restart')) {
        const body = await readBody(req);
        if (action === 'restart') stopTunnel(t);
        if (t.status === 'running' && isAlive(t.pid)) {
          return sendJson(res, 200, { tunnel: publicView([t])[0] });
        }
        if (!t.skipDirectCheck) {
          const gate = await directConnectionGate(t.url);
          if (!gate.ok) {
            saveTunnels(tunnels);
            return sendJson(res, 409, { error: `直连校验未通过：${gate.reason}` });
          }
        }
        const result = await startTunnel(t, { sudoPassword: body.sudoPassword });
        saveTunnels(tunnels);
        if (!result.ok) return sendJson(res, 500, { error: result.reason });
        // 启动门确认过远程网关可达时，乐观初始化为"运行中、可达"；
        // 若用户跳过直连校验，则等待 2s 后的端到端 SSH 探测给出真实状态。
        if (t.skipDirectCheck) health.delete(t.id);
        else health.set(t.id, { reachable: true, checkedAt: new Date().toISOString(), reason: null });
        setTimeout(() => { checkOne(t).catch(() => {}); }, 2000);
        // 顺带查一次 GPU，前端展开时立刻有数据（不必等下一轮 15s 轮询）
        setTimeout(() => { queryGpu(t).catch(() => {}); }, 2000);
        return sendJson(res, 200, { tunnel: publicView([t])[0] });
      }
    }

    // 查看日志
    const lm = pathname.match(/^\/api\/tunnels\/([^/]+)\/log$/);
    if (method === 'GET' && lm) {
      const logPath = path.join(LOG_DIR, `${lm[1]}.log`);
      sendJson(res, 200, { log: readLogTail(logPath, 8000) });
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// ---------- 前端页面 ----------
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="author" content="SII-ljh">
<meta name="generator" content="rtunnel-manager · ljh">
<title>rtunnel 管理器</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='%23eef1fb'/><text x='32' y='43' text-anchor='middle' font-family='-apple-system,Segoe UI,sans-serif' font-size='26' font-weight='700' fill='%234f6bed'>RT</text></svg>">
<!-- crafted by SII-ljh · https://github.com/SII-ljh -->
<style>
  /* ---------- 主题变量：浅色（默认）+ 深色 ---------- */
  :root[data-theme='light'] {
    --bg: #fafbfc;
    --surface: #ffffff;
    --surface-2: #f4f5f8;
    --surface-3: #eceef2;
    --border: #e5e6ec;
    --border-strong: #d2d5dd;
    --text: #1a1d24;
    --text-muted: #686d78;
    --text-subtle: #9499a3;
    --accent: #4f6bed;
    --accent-hover: #3f59d4;
    --accent-soft: #eef1fc;
    --accent-border: #cfd7f5;
    --accent-text: #ffffff;
    --success: #1f9d55;
    --success-soft: #e6f4ec;
    --warning: #b8770e;
    --warning-soft: #f9efe0;
    --danger: #c0392b;
    --danger-soft: #fae9e7;
    --overlay: rgba(15,18,28,.42);
    --focus-ring: rgba(79,107,237,.25);
  }
  :root[data-theme='dark'] {
    --bg: #0d0f14;
    --surface: #14171f;
    --surface-2: #1b1f2a;
    --surface-3: #232838;
    --border: #262a36;
    --border-strong: #353a4a;
    --text: #e6e8ee;
    --text-muted: #8a8f9c;
    --text-subtle: #62677a;
    --accent: #6b85f2;
    --accent-hover: #8198f5;
    --accent-soft: #1d2238;
    --accent-border: #2a3354;
    --accent-text: #ffffff;
    --success: #4ac38a;
    --success-soft: #14241c;
    --warning: #d99550;
    --warning-soft: #2a2117;
    --danger: #e26565;
    --danger-soft: #2a181a;
    --overlay: rgba(0,0,0,.6);
    --focus-ring: rgba(107,133,242,.35);
  }

  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  }

  /* ---------- 顶部状态栏 ---------- */
  .topbar {
    height: 52px;
    padding: 0 20px;
    display: flex; align-items: center; gap: 18px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 20;
  }
  /* Electron 桌面端：顶栏整条作为窗口拖动区，并给左侧预留出红黄绿按钮的位置；
     里头的可点元素显式还原为 no-drag。浏览器模式下不挂这两条规则。 */
  body[data-app="desktop"] .topbar { -webkit-app-region: drag; app-region: drag; padding-left: 84px; }
  body[data-app="desktop"] .topbar button,
  body[data-app="desktop"] .topbar input,
  body[data-app="desktop"] .topbar .ssh-chip { -webkit-app-region: no-drag; app-region: no-drag; }
  /* 全屏时 macOS 收起红黄绿，padding 还原成正常 */
  body[data-app="desktop"]:fullscreen .topbar { padding-left: 20px; }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand .logo {
    width: 28px; height: 28px; border-radius: 7px;
    background: var(--accent-soft); color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 12px; letter-spacing: -0.4px;
    flex-shrink: 0;
  }
  .brand h1 {
    font-size: 13.5px; font-weight: 600; margin: 0;
    letter-spacing: -0.1px; color: var(--text); white-space: nowrap;
  }
  .topbar-stats { display: flex; gap: 14px; font-size: 12px; }
  .topbar-stats .stat {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--text-muted);
  }
  .topbar-stats .stat .dot {
    width: 6px; height: 6px; border-radius: 999px; background: var(--text-subtle);
  }
  .topbar-stats .stat.running .dot { background: var(--success); }
  .topbar-stats .stat.unreachable .dot { background: var(--danger); }
  .topbar-stats .stat b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .topbar-actions { margin-left: auto; display: flex; gap: 6px; align-items: center; }

  /* ---------- 按钮（全部自定义；明确 hover / active / focus / disabled） ---------- */
  .btn {
    -webkit-appearance: none; appearance: none;
    font: inherit;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.35;
    white-space: nowrap;
    color: var(--text);
    background: var(--surface);
    transition: background .12s ease, border-color .12s ease, color .12s ease;
    user-select: none;
  }
  .btn:focus { outline: none; }
  .btn:focus-visible { box-shadow: 0 0 0 3px var(--focus-ring); }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn-primary {
    background: var(--accent); color: var(--accent-text);
    border-color: var(--accent);
  }
  .btn-primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
  .btn-primary:active:not(:disabled) { background: var(--accent-hover); }
  .btn-ghost {
    background: var(--surface);
    color: var(--text);
    border-color: var(--border);
  }
  .btn-ghost:hover:not(:disabled) { background: var(--surface-2); border-color: var(--border-strong); }
  .btn-ghost:active:not(:disabled) { background: var(--surface-3); }
  .btn-subtle {
    background: transparent;
    color: var(--text-muted);
    border-color: transparent;
    padding: 6px 9px;
  }
  .btn-subtle:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
  .btn-subtle:active:not(:disabled) { background: var(--surface-3); }
  .btn-danger {
    background: transparent; color: var(--text-muted);
    border-color: transparent; padding: 6px 9px;
  }
  .btn-danger:hover:not(:disabled) { background: var(--danger-soft); color: var(--danger); }
  .btn-icon {
    width: 30px; height: 30px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; color: var(--text-muted); border-color: transparent;
  }
  .btn-icon:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
  .btn-icon svg { width: 14px; height: 14px; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }

  /* ---------- 容器 ---------- */
  .container { max-width: 1280px; margin: 0 auto; padding: 24px 20px 60px; }

  /* ---------- 关键指标卡 ---------- */
  .metrics {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
    margin-bottom: 28px;
  }
  .metric {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    display: flex; flex-direction: column; gap: 4px;
    min-width: 0;
  }
  .metric .label {
    font-size: 11px; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.5px; font-weight: 500;
  }
  .metric .value {
    font-size: 22px; font-weight: 600; color: var(--text);
    font-variant-numeric: tabular-nums; line-height: 1.2;
  }
  .metric .value .unit { font-size: 13px; color: var(--text-muted); font-weight: 500; margin-left: 3px; }
  .metric .value.warn { color: var(--danger); }
  .metric .value.muted { color: var(--text-muted); }
  .metric .sub { font-size: 11px; color: var(--text-subtle); }

  /* ---------- 分组 ---------- */
  .group { margin-bottom: 24px; }
  .group:last-child { margin-bottom: 0; }
  .group-header {
    display: flex; align-items: center; gap: 10px;
    padding: 0 4px 10px;
  }
  .group-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--text-subtle); }
  .group[data-status='running'] .group-dot { background: var(--success); }
  .group[data-status='unreachable'] .group-dot { background: var(--danger); }
  .group[data-status='stopped'] .group-dot { background: var(--text-subtle); }
  .group-title {
    font-size: 12px; font-weight: 600; color: var(--text);
    letter-spacing: 0.3px;
  }
  .group-count {
    font-size: 11px; color: var(--text-muted);
    background: var(--surface-2);
    border: 1px solid var(--border);
    padding: 1px 8px; border-radius: 999px;
    font-weight: 500; font-variant-numeric: tabular-nums;
  }

  /* ---------- 数据表 ---------- */
  .table-wrap {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .table-scroll { overflow-x: auto; }
  table.data {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 13px;
    min-width: 760px;
  }
  table.data th {
    text-align: left;
    font-size: 11px;
    font-weight: 500;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.4px;
    padding: 8px 14px;
    background: var(--surface-2);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    height: 34px;
  }
  table.data td {
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
    height: 38px;
    color: var(--text);
  }
  table.data tbody tr:last-child > td { border-bottom: none; }
  table.data tbody tr.data-row:hover { background: var(--surface-2); }
  table.data tbody tr.detail-row > td {
    background: var(--surface-2);
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }
  table.data .col-chevron { width: 24px; padding-left: 14px; padding-right: 0; }
  table.data .col-name { font-weight: 600; color: var(--text); white-space: nowrap; min-width: 140px; }
  table.data .col-url { color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; max-width: 220px; width: 220px; }
  table.data .col-url .url-text { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  table.data .col-ssh { white-space: nowrap; }
  table.data .col-gpu { min-width: 180px; }
  table.data .col-pid { color: var(--text-subtle); font-variant-numeric: tabular-nums; font-size: 12px; width: 60px; }
  table.data .col-actions { text-align: right; white-space: nowrap; width: 1%; }
  table.data .col-actions .btn { margin-left: 3px; }

  /* 状态徽标 */
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 500;
    padding: 1px 8px; border-radius: 999px;
    background: var(--surface-2); color: var(--text-muted);
    border: 1px solid var(--border);
    line-height: 1.5;
  }
  .pill.running { background: var(--success-soft); color: var(--success); border-color: transparent; }
  .pill.unreachable { background: var(--danger-soft); color: var(--danger); border-color: transparent; cursor: help; }
  .pill.stopped { background: var(--surface-2); color: var(--text-muted); }

  .name-cell { display: inline-flex; align-items: center; gap: 8px; }

  /* 展开 chevron */
  .chev {
    width: 18px; height: 18px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 4px;
    background: transparent; color: var(--text-muted);
    border: none; cursor: pointer; padding: 0;
    transition: background .12s, transform .12s, color .12s;
  }
  .chev:hover { background: var(--surface-3); color: var(--text); }
  .chev svg { width: 12px; height: 12px; transition: transform .15s; }
  .chev.open svg { transform: rotate(90deg); }

  /* SSH 复制 chip */
  .ssh-chip {
    display: inline-flex; align-items: center; gap: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 8px;
    color: var(--text);
    cursor: pointer;
    transition: background .12s, border-color .12s, color .12s;
    line-height: 1.5;
  }
  .ssh-chip:hover { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent); }
  .ssh-chip.ready { background: var(--accent-soft); border-color: var(--accent-border); color: var(--accent); }
  .ssh-chip.disabled { opacity: 0.5; cursor: not-allowed; }
  .ssh-chip.disabled:hover { background: var(--surface-2); border-color: var(--border); color: var(--text-muted); }
  .ssh-chip .copy-hint { font-size: 10.5px; color: var(--text-subtle); font-family: inherit; }
  .ssh-chip:hover .copy-hint, .ssh-chip.ready .copy-hint { color: inherit; opacity: 0.75; }

  /* GPU 概要 */
  .gpu-info { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-muted); flex-wrap: wrap; }
  .gpu-info .gpu-model { color: var(--text); font-weight: 500; }
  .gpu-info .metric-inline { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; }
  .gpu-info .metric-inline b { color: var(--text); font-weight: 500; }
  .gpu-info-dim { color: var(--text-subtle); font-size: 12px; }

  .bar { width: 36px; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; flex-shrink: 0; }
  .bar > i { display: block; height: 100%; background: var(--accent); transition: width .2s; }
  .bar.warn > i { background: var(--warning); }
  .bar.hot > i { background: var(--danger); }

  /* 展开后的 GPU 明细 */
  .detail-panel { display: flex; flex-direction: column; gap: 12px; }
  .detail-meta {
    display: flex; flex-wrap: wrap; gap: 16px;
    font-size: 12px; color: var(--text-muted);
  }
  .detail-meta b { color: var(--text); font-weight: 500; }
  table.gpu-detail {
    border-collapse: collapse;
    font-size: 12px;
    color: var(--text);
    width: auto;
  }
  table.gpu-detail th, table.gpu-detail td {
    text-align: left;
    padding: 5px 18px 5px 0;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    height: auto;
  }
  table.gpu-detail th {
    color: var(--text-muted); font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.4px;
    background: transparent;
  }
  table.gpu-detail tr:last-child td { border-bottom: none; }
  table.gpu-detail td .metric-inline { display: inline-flex; align-items: center; gap: 6px; }

  .detail-error {
    font-size: 12px; color: var(--text-muted);
    background: var(--surface); border: 1px dashed var(--border);
    padding: 8px 12px; border-radius: 6px;
  }

  /* 空态 */
  .empty {
    padding: 48px 20px; text-align: center;
    color: var(--text-muted);
    background: var(--surface);
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .empty .title { font-size: 14px; color: var(--text); font-weight: 500; margin-bottom: 6px; }

  /* ---------- 模态框 ---------- */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: var(--overlay);
    display: flex; align-items: center; justify-content: center;
    z-index: 100; padding: 20px;
    animation: fadeIn .15s ease-out;
  }
  .modal-backdrop[hidden] { display: none; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    width: 100%; max-width: 540px; max-height: 90vh;
    overflow: hidden;
    display: flex; flex-direction: column;
    box-shadow: 0 12px 40px rgba(0,0,0,.18);
  }
  .modal-large { max-width: 760px; }
  .modal-header {
    display: flex; align-items: center;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
  }
  .modal-header h2 { font-size: 14px; margin: 0; font-weight: 600; color: var(--text); }
  .modal-header .btn-icon { margin-left: auto; }
  .modal-body { padding: 18px; overflow: auto; }
  .modal-footer {
    padding: 12px 18px;
    border-top: 1px solid var(--border);
    display: flex; justify-content: flex-end; gap: 8px;
    background: var(--surface);
  }

  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
  .field:last-child { margin-bottom: 0; }
  .field label { font-size: 11.5px; font-weight: 500; color: var(--text-muted); }
  .field .hint { font-size: 11px; color: var(--text-subtle); }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .form-grid .field { margin-bottom: 0; }

  input[type="text"], input[type="number"], input[type="password"] {
    font: inherit;
    font-size: 13px;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    outline: none;
    transition: border-color .12s, box-shadow .12s;
    width: 100%;
  }
  input[type="text"]:focus, input[type="number"]:focus, input[type="password"]:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  input[type="text"]::placeholder, input[type="number"]::placeholder, input[type="password"]::placeholder { color: var(--text-subtle); }
  .check-row {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--text-muted);
    margin: 2px 0 12px; user-select: none;
  }
  .check-row input { margin: 0; }
  .field[hidden] { display: none; }

  pre.log-view {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11.5px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
    max-height: 60vh;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ---------- toast ---------- */
  #toast {
    position: fixed; left: 50%; bottom: 24px;
    transform: translateX(-50%) translateY(8px);
    background: var(--text); color: var(--bg);
    padding: 9px 16px; border-radius: 8px;
    font-size: 12.5px; opacity: 0; pointer-events: none;
    transition: opacity .18s, transform .18s;
    z-index: 200; max-width: 80%;
    white-space: pre-wrap;
    box-shadow: 0 8px 24px rgba(0,0,0,.18);
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.err { background: var(--danger); color: #fff; }

  .signoff {
    text-align: center; margin-top: 32px;
    font-size: 11px; color: var(--text-subtle);
    letter-spacing: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    opacity: .4; transition: opacity .25s;
  }
  .signoff:hover { opacity: .8; }
  .signoff a { color: inherit; text-decoration: none; }

  /* ---------- 响应式 ---------- */
  @media (max-width: 960px) {
    .metrics { grid-template-columns: repeat(2, 1fr); }
    .topbar-stats { display: none; }
  }
  @media (max-width: 720px) {
    .container { padding: 16px 12px 40px; }
    .topbar { padding: 0 12px; gap: 10px; }
    .form-grid { grid-template-columns: 1fr; }
    table.data .col-url { display: none; }
  }
  @media (max-width: 560px) {
    .metrics { grid-template-columns: 1fr 1fr; gap: 8px; }
    .metric { padding: 12px 14px; }
    .metric .value { font-size: 18px; }
  }
</style>
</head>
<body>
<header class="topbar">
  <div class="brand">
    <div class="logo">RT</div>
    <h1>rtunnel</h1>
  </div>
  <div class="topbar-stats" id="topbar-stats"></div>
  <div class="topbar-actions">
    <button class="btn btn-primary btn-sm" id="open-new">+ 新建隧道</button>
    <button class="btn btn-icon" id="theme-toggle" title="切换主题" aria-label="切换主题"></button>
    <button class="btn btn-ghost btn-sm" id="quit" title="关闭管理器（已运行的隧道不受影响）">退出</button>
  </div>
</header>

<main class="container">
  <section class="metrics" id="metrics"></section>
  <section id="groups"></section>
  <footer class="signoff" title="rtunnel 管理器 · by SII-ljh"><a href="https://github.com/SII-ljh" target="_blank" rel="noopener">· ljh ·</a></footer>
</main>

<!-- 模态：新建 / 编辑 -->
<div class="modal-backdrop" id="modal-form" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-form-title">
    <header class="modal-header">
      <h2 id="modal-form-title">新建隧道</h2>
      <button class="btn btn-icon" data-close aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>
    <div class="modal-body">
      <div class="field">
        <label for="m-name">名称（可选）</label>
        <input id="m-name" type="text" placeholder="my-server">
      </div>
      <div class="field">
        <label for="m-url">远程 URL</label>
        <input id="m-url" type="text" placeholder="https://...sii.edu.cn/.../proxy/47230/">
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="m-user">用户名</label>
          <input id="m-user" type="text" placeholder="root" value="root">
        </div>
        <div class="field">
          <label for="m-port">本地端口</label>
          <input id="m-port" type="number" placeholder="4444" min="1" max="65535">
        </div>
      </div>
      <div class="field">
        <label for="m-args">额外参数（可选）</label>
        <input id="m-args" type="text" placeholder="--secure">
        <div class="hint">启动前会先直连探测目标 URL；rtunnel 子进程将剔除代理变量直连运行。</div>
      </div>
      <div class="field">
        <label for="m-rtunnel-command">隧道命令（可选）</label>
        <input id="m-rtunnel-command" type="text" placeholder="/opt/homebrew/bin/rtunnel 或 wstunnel">
        <div class="hint">留空时自动搜索 rtunnel；填 wstunnel 时会自动转换为 -t 127.0.0.1:本地端口:127.0.0.1:22 URL。</div>
      </div>
      <label class="check-row">
        <input id="m-use-sudo" type="checkbox">
        使用 sudo 启动这个隧道命令
      </label>
      <label class="check-row">
        <input id="m-skip-direct-check" type="checkbox">
        跳过启动前直连校验
      </label>
    </div>
    <footer class="modal-footer">
      <button class="btn btn-ghost btn-sm" data-close>取消</button>
      <button class="btn btn-primary btn-sm" id="m-submit">添加</button>
      <button class="btn btn-primary btn-sm" id="m-submit-restart" hidden>保存并重启</button>
    </footer>
  </div>
</div>

<!-- 模态：日志 -->
<div class="modal-backdrop" id="modal-log" hidden>
  <div class="modal modal-large" role="dialog" aria-modal="true" aria-labelledby="modal-log-title">
    <header class="modal-header">
      <h2 id="modal-log-title">日志</h2>
      <button class="btn btn-icon" data-close aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>
    <div class="modal-body">
      <pre class="log-view" id="log-content">(加载中…)</pre>
    </div>
    <footer class="modal-footer">
      <button class="btn btn-ghost btn-sm" data-close>关闭</button>
    </footer>
  </div>
</div>

<!-- 模态：sudo 密码 -->
<div class="modal-backdrop" id="modal-sudo" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-sudo-title">
    <header class="modal-header">
      <h2 id="modal-sudo-title">sudo 密码</h2>
      <button class="btn btn-icon" data-close aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </header>
    <div class="modal-body">
      <div class="field">
        <label for="sudo-password">sudo/root 密码</label>
        <input id="sudo-password" type="password" autocomplete="current-password" placeholder="不会保存">
        <div class="hint">用于本次启动或重启 sudo rtunnel；请求完成后前端会清空输入框。</div>
      </div>
    </div>
    <footer class="modal-footer">
      <button class="btn btn-ghost btn-sm" data-close>取消</button>
      <button class="btn btn-primary btn-sm" id="sudo-submit">继续</button>
    </footer>
  </div>
</div>

<div id="toast"></div>

<script>
'use strict';

// ---------- 主题 ----------
const THEME_KEY = 'rt-theme';
const SVG_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const SVG_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>';
const SVG_CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.innerHTML = theme === 'dark' ? SVG_SUN : SVG_MOON;
    btn.title = theme === 'dark' ? '切换到浅色' : '切换到深色';
  }
}
function initTheme() {
  let theme;
  try { theme = localStorage.getItem(THEME_KEY); } catch (_) {}
  if (!theme) theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  setTheme(theme);
}

// Electron 装在 UA 里能识别（包含 "Electron"）。装上 data-app 让 CSS 给顶栏开
// drag region + 左侧 padding；浏览器模式下不挂这些规则，避免无意义的留白。
function initAppMode() {
  if (/Electron\\//i.test(navigator.userAgent)) {
    document.body.setAttribute('data-app', 'desktop');
  }
}

// ---------- 工具 ----------
const $ = (sel, root) => (root || document).querySelector(sel);
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, isErr ? 6000 : 2500);
}
async function api(url, opts) {
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---------- 状态 ----------
const state = {
  tunnels: [],
  expanded: new Set(),  // 展开 GPU 明细的 id
};
let modalMode = null;    // null | 'create' | { mode: 'edit', id }
let sudoAction = null;   // null | { id, act }

// ---------- 数据加工：过滤 / 分组 / 排序 ----------
// 过滤无关 GPU：memTotal=0 / null（CPU-only 或 nvidia-smi 返回异常）
function validGpus(gpus) {
  return (gpus || []).filter((x) => x && x.memTotal != null && x.memTotal > 0);
}
function gpuShortName(name) {
  return String(name || '').replace(/^NVIDIA\\s+/i, '').trim() || 'GPU';
}
function gpuSummary(gpus) {
  const valid = validGpus(gpus);
  if (!valid.length) return null;
  const names = valid.map((x) => gpuShortName(x.name));
  const model = names.every((n) => n === names[0]) ? names[0] : 'GPU';
  const memUsed = valid.reduce((s, x) => s + (x.memUsed || 0), 0);
  const memTotal = valid.reduce((s, x) => s + (x.memTotal || 0), 0);
  const memPct = memTotal ? Math.round((memUsed / memTotal) * 100) : null;
  const utils = valid.map((x) => x.util).filter((v) => v != null);
  const avgUtil = utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null;
  return { count: valid.length, model, memUsed, memTotal, memPct, avgUtil, valid };
}
function groupTunnels(tunnels) {
  const g = { unreachable: [], running: [], stopped: [] };
  for (const t of tunnels) {
    if (t.status === 'running' && t.reachable === false) g.unreachable.push(t);
    else if (t.status === 'running') g.running.push(t);
    else g.stopped.push(t);
  }
  // 运行中：按 GPU 平均利用率倒序、然后显存占用倒序
  g.running.sort((a, b) => {
    const sa = gpuSummary(a.gpu && a.gpu.gpus) || {};
    const sb = gpuSummary(b.gpu && b.gpu.gpus) || {};
    const ua = sa.avgUtil == null ? -1 : sa.avgUtil;
    const ub = sb.avgUtil == null ? -1 : sb.avgUtil;
    if (ub !== ua) return ub - ua;
    const ma = sa.memPct == null ? -1 : sa.memPct;
    const mb = sb.memPct == null ? -1 : sb.memPct;
    if (mb !== ma) return mb - ma;
    return (a.name || '').localeCompare(b.name || '');
  });
  g.unreachable.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  g.stopped.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return [
    { key: 'unreachable', label: '已断开', items: g.unreachable },
    { key: 'running',     label: '运行中', items: g.running },
    { key: 'stopped',     label: '已停止', items: g.stopped },
  ].filter((grp) => grp.items.length > 0);
}
function computeMetrics(tunnels) {
  const total = tunnels.length;
  const running = tunnels.filter((t) => t.status === 'running' && t.reachable !== false).length;
  const unreachable = tunnels.filter((t) => t.status === 'running' && t.reachable === false).length;
  const stopped = tunnels.filter((t) => t.status !== 'running').length;
  let utils = [], memUsed = 0, memTotal = 0;
  for (const t of tunnels) {
    if (t.status !== 'running' || !t.gpu) continue;
    for (const g of validGpus(t.gpu.gpus)) {
      if (g.util != null) utils.push(g.util);
      memUsed += g.memUsed || 0;
      memTotal += g.memTotal || 0;
    }
  }
  const gpuAvg = utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null;
  const gpuMem = memTotal ? Math.round(memUsed / memTotal * 100) : null;
  return { total, running, unreachable, stopped, gpuAvg, gpuMem, gpuCardCount: utils.length };
}

// ---------- 渲染 ----------
function renderTopbarStats(m) {
  const wrap = $('#topbar-stats');
  const parts = [
    \`<span class="stat"><span class="dot"></span><b>\${m.total}</b>隧道</span>\`,
    \`<span class="stat running"><span class="dot"></span><b>\${m.running}</b>运行</span>\`,
  ];
  if (m.unreachable > 0) parts.push(\`<span class="stat unreachable"><span class="dot"></span><b>\${m.unreachable}</b>已断开</span>\`);
  wrap.innerHTML = parts.join('');
}
function renderMetrics(m) {
  const cards = [
    { label: '隧道总数', value: m.total, cls: '' },
    { label: '运行中',   value: m.running, cls: m.running > 0 ? '' : 'muted' },
    { label: '已断开',   value: m.unreachable, cls: m.unreachable > 0 ? 'warn' : 'muted' },
  ];
  // GPU 利用率均值——仅当存在有效 GPU 时展示
  if (m.gpuCardCount > 0) {
    cards.push({
      label: 'GPU 平均利用率',
      value: m.gpuAvg + '<span class="unit">%</span>',
      cls: '',
      sub: m.gpuCardCount + ' 张卡 · 显存 ' + (m.gpuMem == null ? '—' : m.gpuMem + '%'),
    });
  } else {
    cards.push({ label: '已停止', value: m.stopped, cls: m.stopped > 0 ? '' : 'muted' });
  }
  $('#metrics').innerHTML = cards.map((c) => \`
    <div class="metric">
      <span class="label">\${esc(c.label)}</span>
      <span class="value \${c.cls}">\${c.value}</span>
      \${c.sub ? \`<span class="sub">\${esc(c.sub)}</span>\` : ''}
    </div>
  \`).join('');
}

function meterHtml(pct, hot) {
  if (pct == null) return '';
  const w = Math.max(0, Math.min(100, pct));
  let cls = '';
  if (hot && w >= 85) cls = ' hot';
  else if (hot && w >= 65) cls = ' warn';
  return \`<span class="bar\${cls}"><i style="width:\${w}%"></i></span>\`;
}

function gpuCellHtml(t) {
  const g = t.gpu;
  if (!g) return '<span class="gpu-info-dim">—</span>';
  const s = gpuSummary(g.gpus);
  if (!s) {
    if (g.error) return '<span class="gpu-info-dim" title="' + esc(g.error) + '">无 GPU 数据</span>';
    return '<span class="gpu-info-dim">—</span>';
  }
  const parts = [];
  parts.push(\`<span class="gpu-model">\${s.count}× \${esc(s.model)}</span>\`);
  if (s.avgUtil != null) {
    parts.push(\`<span class="metric-inline">利用率 <b>\${s.avgUtil}%</b>\${meterHtml(s.avgUtil, false)}</span>\`);
  }
  if (s.memPct != null) {
    parts.push(\`<span class="metric-inline">显存 <b>\${s.memPct}%</b>\${meterHtml(s.memPct, true)}</span>\`);
  }
  return \`<span class="gpu-info">\${parts.join('')}</span>\`;
}

function actionsHtml(t) {
  const running = t.status === 'running';
  const unreachable = running && t.reachable === false;
  const parts = [];
  if (unreachable) {
    parts.push(\`<button class="btn btn-primary btn-sm" data-act="restart" data-id="\${t.id}">重启</button>\`);
    parts.push(\`<button class="btn btn-ghost btn-sm" data-act="stop" data-id="\${t.id}">停止</button>\`);
  } else if (running) {
    parts.push(\`<button class="btn btn-ghost btn-sm" data-act="stop" data-id="\${t.id}">停止</button>\`);
  } else {
    parts.push(\`<button class="btn btn-primary btn-sm" data-act="start" data-id="\${t.id}">启动</button>\`);
  }
  parts.push(\`<button class="btn btn-subtle btn-sm" data-act="edit" data-id="\${t.id}">编辑</button>\`);
  parts.push(\`<button class="btn btn-subtle btn-sm" data-act="log" data-id="\${t.id}">日志</button>\`);
  parts.push(\`<button class="btn btn-danger btn-sm" data-act="del" data-id="\${t.id}" data-name="\${esc(t.name)}">删除</button>\`);
  return parts.join('');
}

function statusPill(t) {
  const running = t.status === 'running';
  if (running && t.reachable === false) {
    return \`<span class="pill unreachable" title="\${esc(t.checkReason || 'SSH 探测失败：远程服务器可能已关机')}">已断开</span>\`;
  }
  if (running) return '<span class="pill running">运行中</span>';
  return '<span class="pill stopped">已停止</span>';
}

function sshChipHtml(t) {
  const ssh = 'ssh -p ' + t.port + ' ' + (t.user || 'root') + '@127.0.0.1';
  const running = t.status === 'running';
  const ready = running && t.reachable !== false;
  const cls = ready ? 'ssh-chip ready' : (running ? 'ssh-chip disabled' : 'ssh-chip disabled');
  const hint = ready ? '复制' : (running ? '不可达' : '未运行');
  return \`<span class="\${cls}" data-cmd="\${esc(ssh)}" title="\${ready ? '点击复制 ssh 命令' : '隧道未运行或不可达'}">\${esc(ssh)}<span class="copy-hint">\${hint}</span></span>\`;
}

function detailRowHtml(t) {
  const g = t.gpu;
  const s = g ? gpuSummary(g.gpus) : null;
  const meta = [];
  if (t.pid) meta.push(\`<span>PID <b>\${t.pid}</b></span>\`);
  if (t.startedAt) meta.push(\`<span>启动于 <b>\${esc(new Date(t.startedAt).toLocaleString('zh-CN'))}</b></span>\`);
  if (t.checkedAt) meta.push(\`<span>探测于 <b>\${esc(new Date(t.checkedAt).toLocaleString('zh-CN'))}</b></span>\`);
  if (t.args) meta.push(\`<span>参数 <b>\${esc(t.args)}</b></span>\`);
  if (t.rtunnelCommand) meta.push(\`<span>命令 <b>\${esc(t.rtunnelCommand)}</b></span>\`);
  if (t.useSudo) meta.push(\`<span><b>sudo</b> 启动</span>\`);
  if (t.skipDirectCheck) meta.push(\`<span><b>跳过</b> 直连校验</span>\`);
  let body = '';
  if (s && s.valid.length) {
    const gb = (mib) => (mib == null ? '—' : (mib / 1024).toFixed(1));
    const rows = s.valid.map((x) => {
      const memPct = (x.memUsed != null && x.memTotal) ? Math.round((x.memUsed / x.memTotal) * 100) : null;
      return \`<tr>
        <td>\${x.index == null ? '—' : x.index}</td>
        <td>\${esc(gpuShortName(x.name))}</td>
        <td><span class="metric-inline">\${x.util == null ? '—' : x.util + '%'}\${meterHtml(x.util, false)}</span></td>
        <td><span class="metric-inline">\${gb(x.memUsed)} / \${gb(x.memTotal)} GB\${meterHtml(memPct, true)}</span></td>
        <td>\${x.temp == null ? '—' : x.temp + '℃'}</td>
        <td>\${x.power == null ? '—' : Math.round(x.power) + ' W'}</td>
      </tr>\`;
    }).join('');
    body = \`<table class="gpu-detail">
      <thead><tr><th>#</th><th>型号</th><th>利用率</th><th>显存</th><th>温度</th><th>功耗</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>\`;
  } else if (g && g.error) {
    body = \`<div class="detail-error">GPU 信息不可用：\${esc(g.error)}</div>\`;
  } else if (t.status === 'running') {
    body = \`<div class="detail-error">尚未获取 GPU 数据（节点无 nvidia-smi 或未上报）</div>\`;
  } else if (t.checkReason) {
    body = \`<div class="detail-error">\${esc(t.checkReason)}</div>\`;
  } else {
    body = \`<div class="detail-error">无更多信息</div>\`;
  }
  return \`<div class="detail-panel">
    \${meta.length ? \`<div class="detail-meta">\${meta.join('')}</div>\` : ''}
    \${body}
  </div>\`;
}

function groupTableHtml(group) {
  const cols = 7;
  const rows = group.items.map((t) => {
    const open = state.expanded.has(t.id);
    const detail = open ? \`<tr class="detail-row"><td colspan="\${cols}">\${detailRowHtml(t)}</td></tr>\` : '';
    return \`<tr class="data-row" data-id="\${t.id}">
      <td class="col-chevron"><button class="chev \${open ? 'open' : ''}" data-act="toggle" data-id="\${t.id}" aria-label="\${open ? '收起' : '展开'}">\${SVG_CHEV}</button></td>
      <td class="col-name"><span class="name-cell">\${esc(t.name)} \${statusPill(t)}</span></td>
      <td class="col-url"><span class="url-text" title="\${esc(t.url)}">\${esc(t.url)}</span></td>
      <td class="col-ssh">\${sshChipHtml(t)}</td>
      <td class="col-gpu">\${gpuCellHtml(t)}</td>
      <td class="col-pid">\${t.pid ? esc(String(t.pid)) : '—'}</td>
      <td class="col-actions">\${actionsHtml(t)}</td>
    </tr>\${detail}\`;
  }).join('');
  return \`<div class="group" data-status="\${group.key}">
    <header class="group-header">
      <span class="group-dot"></span>
      <span class="group-title">\${esc(group.label)}</span>
      <span class="group-count">\${group.items.length}</span>
    </header>
    <div class="table-wrap"><div class="table-scroll"><table class="data">
      <thead><tr>
        <th class="col-chevron"></th>
        <th>名称</th>
        <th>远程地址</th>
        <th>SSH</th>
        <th>GPU 使用</th>
        <th>PID</th>
        <th></th>
      </tr></thead>
      <tbody>\${rows}</tbody>
    </table></div></div>
  </div>\`;
}

function render() {
  const m = computeMetrics(state.tunnels);
  renderTopbarStats(m);
  renderMetrics(m);
  const groups = groupTunnels(state.tunnels);
  const root = $('#groups');
  if (!groups.length) {
    root.innerHTML = \`<div class="empty">
      <div class="title">还没有任何隧道</div>
      <div>点击右上角「+ 新建隧道」开始添加。</div>
    </div>\`;
    return;
  }
  root.innerHTML = groups.map(groupTableHtml).join('');
}

// ---------- 数据刷新 ----------
async function refresh() {
  try {
    const data = await api('/api/tunnels');
    state.tunnels = data.tunnels;
    render();
  } catch (e) { /* 静默重试 */ }
}

// ---------- 模态：表单 ----------
function openFormModal(mode, tunnel) {
  modalMode = mode === 'edit' ? { mode: 'edit', id: tunnel.id, running: tunnel.status === 'running' } : 'create';
  $('#modal-form-title').textContent = mode === 'edit' ? '编辑隧道' : '新建隧道';
  $('#m-name').value = tunnel ? (tunnel.name || '') : '';
  $('#m-url').value  = tunnel ? (tunnel.url || '') : '';
  $('#m-user').value = tunnel ? (tunnel.user || 'root') : 'root';
  $('#m-port').value = tunnel ? (tunnel.port || '') : '';
  $('#m-args').value = tunnel ? (tunnel.args || '') : '';
  $('#m-rtunnel-command').value = tunnel ? (tunnel.rtunnelCommand || '') : '';
  $('#m-use-sudo').checked = !!(tunnel && tunnel.useSudo);
  $('#m-skip-direct-check').checked = !!(tunnel && tunnel.skipDirectCheck);
  $('#m-submit').textContent = mode === 'edit' ? '保存' : '添加';
  const restartBtn = $('#m-submit-restart');
  if (mode === 'edit' && tunnel.status === 'running') {
    restartBtn.hidden = false;
  } else {
    restartBtn.hidden = true;
  }
  $('#modal-form').hidden = false;
  setTimeout(() => $('#m-url').focus(), 30);
}
function closeFormModal() {
  $('#modal-form').hidden = true;
  modalMode = null;
}
async function submitForm(opts) {
  const body = {
    name: $('#m-name').value,
    url: $('#m-url').value,
    user: $('#m-user').value,
    port: $('#m-port').value,
    args: $('#m-args').value,
    rtunnelCommand: $('#m-rtunnel-command').value,
    useSudo: $('#m-use-sudo').checked,
    skipDirectCheck: $('#m-skip-direct-check').checked,
  };
  if (!body.url.trim()) return toast('请填写远程 URL', true);
  if (!body.port) return toast('请填写本地端口', true);
  try {
    if (modalMode === 'create') {
      await api('/api/tunnels', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      toast('已添加');
    } else if (modalMode && modalMode.mode === 'edit') {
      const id = modalMode.id;
      const saved = await api('/api/tunnels/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (opts && opts.restart) {
        if (body.useSudo) {
          closeFormModal();
          refresh();
          openSudoPasswordModal(saved.tunnel, 'restart');
          return;
        }
        await runTunnelAction(id, 'restart');
        toast('已保存并用新配置重启');
      } else {
        toast('已保存');
      }
    }
    closeFormModal();
    refresh();
  } catch (e) { toast(e.message, true); }
}

async function runTunnelAction(id, act, sudoPassword) {
  const opts = { method: 'POST' };
  if (act === 'start' || act === 'restart' || sudoPassword) {
    opts.headers = {'Content-Type':'application/json'};
    opts.body = JSON.stringify(sudoPassword ? { sudoPassword } : {});
  }
  return api('/api/tunnels/' + id + '/' + act, opts);
}

function openSudoPasswordModal(t, act) {
  sudoAction = { id: t.id, act };
  $('#modal-sudo-title').textContent = (act === 'restart' ? '重启' : '启动') + ' · ' + t.name;
  $('#sudo-password').value = '';
  $('#sudo-submit').textContent = act === 'restart' ? '重启' : '启动';
  $('#modal-sudo').hidden = false;
  setTimeout(() => $('#sudo-password').focus(), 30);
}
function closeSudoPasswordModal() {
  $('#modal-sudo').hidden = true;
  $('#sudo-password').value = '';
  sudoAction = null;
}

// ---------- 模态：日志 ----------
async function openLogModal(t) {
  $('#modal-log-title').textContent = '日志 · ' + t.name;
  $('#log-content').textContent = '加载中…';
  $('#modal-log').hidden = false;
  try {
    const data = await api('/api/tunnels/' + t.id + '/log');
    $('#log-content').textContent = data.log && data.log.trim() ? data.log : '(无日志)';
  } catch (e) {
    $('#log-content').textContent = '加载失败：' + e.message;
  }
}
function closeLogModal() { $('#modal-log').hidden = true; }

// ---------- 事件 ----------
document.addEventListener('click', async (ev) => {
  // 模态背景关闭 / 关闭按钮
  if (ev.target.matches('.modal-backdrop')) {
    if (ev.target.id === 'modal-form') closeFormModal();
    if (ev.target.id === 'modal-log') closeLogModal();
    if (ev.target.id === 'modal-sudo') closeSudoPasswordModal();
    return;
  }
  if (ev.target.closest('[data-close]')) {
    const backdrop = ev.target.closest('.modal-backdrop');
    if (backdrop && backdrop.id === 'modal-form') closeFormModal();
    if (backdrop && backdrop.id === 'modal-log') closeLogModal();
    if (backdrop && backdrop.id === 'modal-sudo') closeSudoPasswordModal();
    return;
  }

  // SSH 复制
  const sshEl = ev.target.closest('.ssh-chip:not(.disabled)');
  if (sshEl) {
    try { await navigator.clipboard.writeText(sshEl.dataset.cmd); toast('已复制：' + sshEl.dataset.cmd); }
    catch (_) { toast('复制失败，请手动选择', true); }
    return;
  }

  // 行操作按钮
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id, name } = btn.dataset;

  if (act === 'toggle') {
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    render();
    return;
  }
  if (act === 'edit') {
    const t = state.tunnels.find((x) => x.id === id);
    if (t) openFormModal('edit', t);
    return;
  }
  if (act === 'log') {
    const t = state.tunnels.find((x) => x.id === id);
    if (t) openLogModal(t);
    return;
  }
  if (act === 'del') {
    if (!confirm('删除隧道「' + name + '」？若在运行会先停止。')) return;
    btn.disabled = true;
    try { await api('/api/tunnels/' + id, { method: 'DELETE' }); toast('已删除'); refresh(); }
    catch (e) { toast(e.message, true); btn.disabled = false; }
    return;
  }
  if (act === 'start' || act === 'stop' || act === 'restart') {
    btn.disabled = true;
    try {
      const t = state.tunnels.find((x) => x.id === id);
      if (t && t.useSudo && (act === 'start' || act === 'restart')) {
        btn.disabled = false;
        openSudoPasswordModal(t, act);
        return;
      }
      await runTunnelAction(id, act);
      toast(act === 'start' ? '已启动' : act === 'stop' ? '已停止' : '已重启');
      refresh();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
    return;
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!$('#modal-form').hidden) closeFormModal();
    if (!$('#modal-log').hidden) closeLogModal();
    if (!$('#modal-sudo').hidden) closeSudoPasswordModal();
  }
});

$('#open-new').addEventListener('click', () => openFormModal('create', null));
$('#m-submit').addEventListener('click', () => submitForm());
$('#m-submit-restart').addEventListener('click', () => submitForm({ restart: true }));
$('#sudo-submit').addEventListener('click', async () => {
  if (!sudoAction) return;
  const pwd = $('#sudo-password').value;
  if (!pwd) return toast('请填写 sudo/root 密码', true);
  const { id, act } = sudoAction;
  $('#sudo-submit').disabled = true;
  try {
    await runTunnelAction(id, act, pwd);
    toast(act === 'restart' ? '已重启' : '已启动');
    closeSudoPasswordModal();
    refresh();
  } catch (e) {
    toast(e.message, true);
  } finally {
    $('#sudo-submit').disabled = false;
  }
});
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  setTheme(cur === 'dark' ? 'light' : 'dark');
});

$('#quit').addEventListener('click', async () => {
  if (!confirm('退出管理器？\\n将关闭后台进程（释放 7070 端口）。已运行的隧道是独立进程，不受影响，会继续在后台运行。')) return;
  clearInterval(refreshTimer);
  try { await api('/api/shutdown', { method: 'POST' }); } catch (_) {}
  document.body.innerHTML = '<div style="max-width:560px;margin:120px auto;text-align:center;color:var(--text-muted);font:14px/1.6 -apple-system,sans-serif;padding:20px;"><div style="font-size:16px;color:var(--text);font-weight:600;margin-bottom:10px;">管理器已关闭</div>7070 端口已释放，可以安全关掉此标签页。<br><span style="font-size:12px;color:var(--text-subtle);">已运行的隧道仍在后台运行；需要时重新运行 <code>node server.js</code> 即可再次接管。</span></div>';
});

// ---------- 启动 ----------
initAppMode();
initTheme();
refresh();
const refreshTimer = setInterval(refresh, 3000);
</script>
</body>
</html>`;

// ---------- 启动 ----------
// 抽成函数：Electron 主进程可 require() 之后调用 startServer()，
// CLI 直接运行时由文件底部的 `if (require.main === module)` 自动启动。
function startServer(opts) {
  opts = opts || {};
  ensureDirs();
  migrateLegacy();          // 首次运行时把旧版单文件配置拆成 SHARED_CONFIG + RUNTIME_FILE
  reconcile(loadTunnels()); // 启动即接管已有进程的真实状态

  // 后台周期性探测「运行中」隧道的远程可达性（检测远程关机/断网）
  runHealthChecks();
  setInterval(runHealthChecks, 15000);

  // 后台周期性查询「运行中」隧道节点的 GPU 使用情况（SSH + nvidia-smi）
  runGpuChecks();
  setInterval(runGpuChecks, 15000);

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${WEB_PORT} 已被占用。可能管理器已在运行，或用 RT_MANAGER_PORT 换个端口。`);
      } else {
        console.error('服务器错误:', err.message);
      }
      reject(err);
    });
    server.listen(WEB_PORT, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${WEB_PORT}`;
      console.log(`rtunnel 管理器已启动: ${url}`);
      console.log(`共享配置: ${SHARED_CONFIG}`);
      console.log(`本机状态: ${RUNTIME_FILE}`);
      // Electron 模式下不要自动打开系统浏览器（Electron 会用自己的 BrowserWindow）。
      if (process.platform === 'darwin' && !opts.skipAutoOpen && !process.env.RT_NO_AUTOOPEN) {
        execFile('open', [url], () => {});
      }
      resolve({ url, port: WEB_PORT });
    });
  });
}

if (require.main === module) {
  startServer().catch(() => process.exit(1));
}

module.exports = { startServer, WEB_PORT };
