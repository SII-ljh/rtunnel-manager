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
//     只存"共享字段"——id / name / url / port / user / args。
//     在 A 机加一条隧道，B 机自动也能看到。
//   - RUNTIME_FILE:  本机 Library 下，按 id 存 { pid, status, startedAt }。
//     pid 是机器本地编号，绝不能跨设备共享，否则 reconcile() 会把对方机器
//     还活着的隧道误判为 stopped 并写回，下次启动就撞 EADDRINUSE。
const SHARED_CONFIG = path.join(__dirname, 'tunnels.json');
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
function childEnvWithoutProxy() {
  const env = Object.assign({}, process.env);
  for (const k of PROXY_ENV_KEYS) delete env[k];
  return env;
}

function startTunnel(t) {
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

    const extra = (t.args || '').trim().length ? t.args.trim().split(/\s+/) : [];
    const args = [t.url, String(t.port), ...extra];

    let child;
    try {
      child = spawn('rtunnel', args, {
        detached: true,
        stdio: ['ignore', out, out],
        env: childEnvWithoutProxy(),
        cwd: os.homedir(),
      });
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
    try { process.kill(t.pid, 'SIGTERM'); } catch (_) {}
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
        if (!url) return sendJson(res, 400, { error: 'url 不能为空' });
        if (!port || port < 1 || port > 65535) return sendJson(res, 400, { error: '端口无效（1-65535）' });
        t.url = url;
        t.port = port;
        t.name = (body.name || '').trim() || `tunnel-${port}`;
        t.user = (body.user || '').trim() || 'root';
        t.args = (body.args || '').trim();
        saveTunnels(tunnels);
        return sendJson(res, 200, { tunnel: publicView([t])[0] });
      }

      if (method === 'POST' && action === 'stop') {
        stopTunnel(t);
        saveTunnels(tunnels);
        return sendJson(res, 200, { tunnel: publicView([t])[0] });
      }

      if (method === 'POST' && (action === 'start' || action === 'restart')) {
        if (action === 'restart') stopTunnel(t);
        if (t.status === 'running' && isAlive(t.pid)) {
          return sendJson(res, 200, { tunnel: publicView([t])[0] });
        }
        const gate = await directConnectionGate(t.url);
        if (!gate.ok) {
          saveTunnels(tunnels);
          return sendJson(res, 409, { error: `直连校验未通过：${gate.reason}` });
        }
        const result = await startTunnel(t);
        saveTunnels(tunnels);
        if (!result.ok) return sendJson(res, 500, { error: result.reason });
        // 启动门刚确认过远程网关可达，乐观初始化为"运行中、可达"；
        // 2s 后做一次真正的端到端 SSH 探测，远程若已关机会很快翻成「已断开」。
        health.set(t.id, { reachable: true, checkedAt: new Date().toISOString(), reason: null });
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
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="author" content="SII-ljh">
<meta name="generator" content="rtunnel-manager · ljh">
<title>rtunnel 管理器</title>
<!-- crafted by SII-ljh · https://github.com/SII-ljh -->
<style>
  :root {
    --bg: #f7f8fa; --card: #ffffff; --line: #e8eaed; --text: #1f2329;
    --muted: #8a8f99; --accent: #2563eb; --accent-soft: #eff4ff;
    --green: #16a34a; --green-soft: #e9f7ee; --red: #dc2626; --red-soft: #fdeded;
    --shadow: 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 32px 20px 60px; }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 24px; }
  header h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: .2px; }
  header .sub { color: var(--muted); font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); }
  .add { padding: 18px; margin-bottom: 22px; }
  .add h2 { font-size: 14px; margin: 0 0 14px; color: var(--muted); font-weight: 600; }
  .grid { display: grid; grid-template-columns: 1.1fr 4.4fr 0.9fr 0.8fr 1fr auto; gap: 10px; align-items: end; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
  input[type=text], input[type=number] {
    width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 8px;
    font-size: 13px; background: #fcfcfd; color: var(--text); outline: none; transition: border-color .15s, box-shadow .15s;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: #fff; }
  button { font: inherit; cursor: pointer; border: none; border-radius: 8px; padding: 9px 14px; font-size: 13px; font-weight: 500; transition: background .15s, opacity .15s; }
  button:disabled { opacity: .5; cursor: default; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: #1d4ed8; }
  .btn-ghost { background: transparent; border: 1px solid var(--line); color: var(--text); padding: 6px 12px; }
  .btn-ghost:hover { background: #f3f4f6; }
  .btn-start { background: var(--green-soft); color: var(--green); padding: 6px 12px; }
  .btn-start:hover { background: #d9f0e1; }
  .btn-stop { background: #fff3e6; color: #d97706; padding: 6px 12px; }
  .btn-stop:hover { background: #ffe9cf; }
  .btn-del { background: transparent; color: var(--muted); padding: 6px 10px; }
  .btn-del:hover { background: var(--red-soft); color: var(--red); }
  .btn-edit { background: transparent; border: 1px solid var(--line); color: var(--text); padding: 6px 12px; }
  .btn-edit:hover { background: #f3f4f6; }
  .btn-quit { margin-left: auto; background: transparent; border: 1px solid var(--line); color: var(--muted); padding: 7px 14px; align-self: center; }
  .btn-quit:hover { background: var(--red-soft); border-color: #f3c0c0; color: var(--red); }
  .row.editing { background: #fbfcfe; }
  .edit-grid { display: grid; grid-template-columns: 1.1fr 4.4fr 0.9fr 0.8fr 1fr; gap: 10px; align-items: end; }
  @media (max-width: 720px) { .edit-grid { grid-template-columns: 1fr; } }
  .list { padding: 6px; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 14px; align-items: center; padding: 14px 14px; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: none; }
  .row .info { min-width: 0; }
  .row .name { font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .row .url { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 3px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 20px; font-weight: 600; }
  .badge.running { background: var(--green-soft); color: var(--green); }
  .badge.stopped { background: #f1f2f4; color: var(--muted); }
  .badge.unreachable { background: var(--red-soft); color: var(--red); cursor: help; }
  .ssh { margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #334155; background: #f6f7f9; border: 1px solid var(--line); border-radius: 7px; padding: 6px 10px; display: inline-flex; align-items: center; gap: 10px; cursor: pointer; transition: background .15s, border-color .15s; }
  .ssh:hover { background: #eef1f5; }
  .ssh .copy { font-size: 11px; font-weight: 600; }
  /* 运行中的隧道：ssh 指令醒目可复制 */
  .ssh.ready { background: var(--accent-soft); border-color: #c7dafe; color: #1e40af; }
  .ssh.ready:hover { background: #e3edff; }
  .ssh.ready .copy { color: var(--accent); }
  .ssh.off { opacity: .65; }
  .ssh.off .copy { color: var(--muted); }
  /* GPU 行内概览 */
  .gpu-sum { margin-top: 8px; display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: #3730a3; background: #f1f0fe; border: 1px solid #e0ddfb; border-radius: 7px; padding: 5px 10px; cursor: pointer; transition: background .15s; }
  .gpu-sum:hover { background: #e8e6fd; }
  .gpu-sum .gpu-icon { font-size: 12px; }
  .gpu-sum .gpu-toggle { color: var(--muted); font-size: 11px; font-weight: 600; margin-left: 2px; }
  .gpu-err { margin-top: 8px; font-size: 12px; color: var(--muted); }
  /* GPU 明细表 */
  .gpu-table { margin-top: 8px; border-collapse: collapse; font-size: 12px; width: 100%; max-width: 560px; }
  .gpu-table th { text-align: left; font-weight: 600; color: var(--muted); padding: 4px 10px 4px 0; border-bottom: 1px solid var(--line); }
  .gpu-table td { padding: 5px 10px 5px 0; border-bottom: 1px solid #f1f2f4; vertical-align: middle; white-space: nowrap; }
  .gpu-table tr:last-child td { border-bottom: none; }
  .gpu-meter { display: inline-block; vertical-align: middle; width: 56px; height: 6px; border-radius: 4px; background: #ececf5; margin-left: 7px; overflow: hidden; }
  .gpu-meter > i { display: block; height: 100%; background: var(--accent); }
  .gpu-meter.hot > i { background: var(--red); }
  .actions { display: flex; gap: 6px; align-items: center; }
  .empty { text-align: center; color: var(--muted); padding: 40px 0; }
  #toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); max-width: 80%; background: #1f2329; color: #fff; padding: 11px 16px; border-radius: 10px; font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.18); opacity: 0; pointer-events: none; transition: opacity .25s, transform .25s; white-space: pre-wrap; }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(-4px); }
  #toast.err { background: #b91c1c; }
  .hint { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .signoff { text-align: center; margin-top: 36px; font-size: 11px; color: var(--muted); letter-spacing: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; opacity: .42; user-select: none; transition: opacity .25s; }
  .signoff:hover { opacity: .85; }
  .signoff a { color: inherit; text-decoration: none; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } .row { grid-template-columns: 1fr; } .actions { justify-content: flex-start; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>rtunnel 管理器</h1>
    <span class="sub">运行 / 关闭 / 管理你的 SSH 隧道</span>
    <button class="btn-quit" id="quit" title="关闭管理器（已运行的隧道不受影响）">退出管理器</button>
  </header>

  <div class="card add">
    <h2>新建隧道</h2>
    <div class="grid">
      <div class="field"><label>名称（可选）</label><input id="f-name" type="text" placeholder="my-server"></div>
      <div class="field"><label>远程 URL</label><input id="f-url" type="text" placeholder="https://...sii.edu.cn/.../proxy/47230/"></div>
      <div class="field"><label>用户名</label><input id="f-user" type="text" placeholder="root" value="root"></div>
      <div class="field"><label>本地端口</label><input id="f-port" type="number" placeholder="4444" min="1" max="65535"></div>
      <div class="field"><label>额外参数（可选）</label><input id="f-args" type="text" placeholder="--secure"></div>
      <div class="field"><button class="btn-primary" id="f-add">添加</button></div>
    </div>
    <div class="hint">rtunnel 始终以直连方式运行（自动剔除代理变量，不影响你 shell 的代理）；启动前会直连探测目标 URL，连得上才放行。</div>
  </div>

  <div class="card list" id="list"></div>

  <footer class="signoff" title="rtunnel 管理器 · by SII-ljh"><a href="https://github.com/SII-ljh" target="_blank" rel="noopener">· ljh ·</a></footer>
</div>
<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let toastTimer = null;
let editingId = null;        // 正在编辑的隧道 id（编辑期间暂停自动刷新覆盖）
let lastTunnels = [];        // 最近一次的隧道数据（取消编辑时用来重绘）
const gpuExpanded = new Set(); // 已展开 GPU 明细的隧道 id（前端态，定时刷新不丢）
function toast(msg, isErr) {
  const el = $('toast');
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

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// 去掉型号里冗长的前缀/后缀，留个好认的短名：
// "NVIDIA A100-SXM4-40GB" -> "A100-SXM4-40GB"，"Tesla V100" -> "Tesla V100"
function gpuShortName(name) { return String(name || '').replace(/^NVIDIA\\s+/i, '').trim() || 'GPU'; }

// 从一组卡算出行内汇总：卡数、统一型号（不统一则记 GPU）、总显存占用率、平均利用率。
function gpuSummary(gpus) {
  const count = gpus.length;
  const names = gpus.map((x) => gpuShortName(x.name));
  const model = names.every((n) => n === names[0]) ? names[0] : 'GPU';
  const memUsed = gpus.reduce((s, x) => s + (x.memUsed || 0), 0);
  const memTotal = gpus.reduce((s, x) => s + (x.memTotal || 0), 0);
  const memPct = memTotal ? Math.round((memUsed / memTotal) * 100) : null;
  const utils = gpus.map((x) => x.util).filter((v) => v != null);
  const avgUtil = utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null;
  return { count, model, memPct, avgUtil };
}

// 一个 0-100 的小进度条；>=85% 标红。
function meter(pct, hot) {
  if (pct == null) return '';
  const w = Math.max(0, Math.min(100, pct));
  return '<span class="gpu-meter'+(hot && w >= 85 ? ' hot' : '')+'"><i style="width:'+w+'%"></i></span>';
}

// 单块卡的明细表。
function gpuDetailHtml(gpus) {
  const gb = (mib) => (mib == null ? '—' : (mib / 1024).toFixed(1));
  const rows = gpus.map((x) => {
    const memPct = (x.memUsed != null && x.memTotal) ? Math.round((x.memUsed / x.memTotal) * 100) : null;
    return \`<tr>
      <td>\${x.index == null ? '—' : x.index}</td>
      <td>\${esc(gpuShortName(x.name))}</td>
      <td>\${x.util == null ? '—' : x.util + '%'}\${meter(x.util, false)}</td>
      <td>\${gb(x.memUsed)}/\${gb(x.memTotal)} GB\${meter(memPct, true)}</td>
      <td>\${x.temp == null ? '—' : x.temp + '℃'}</td>
      <td>\${x.power == null ? '—' : Math.round(x.power) + 'W'}</td>
    </tr>\`;
  }).join('');
  return \`<table class="gpu-table">
    <thead><tr><th>#</th><th>型号</th><th>利用率</th><th>显存</th><th>温度</th><th>功耗</th></tr></thead>
    <tbody>\${rows}</tbody>
  </table>\`;
}

// 隧道行里的 GPU 区块：运行中且查到卡 → 概览行（可点开明细）；查询出错则静默不显示。
function gpuBlockHtml(t) {
  const g = t.gpu;
  if (!g || !g.gpus || !g.gpus.length) return '';   // 未查 / 非运行 / 无 GPU / 出错：不打扰
  const s = gpuSummary(g.gpus);
  const expanded = gpuExpanded.has(t.id);
  const parts = [];
  parts.push(s.count + '× ' + esc(s.model));
  if (s.memPct != null) parts.push('显存 ' + s.memPct + '%');
  if (s.avgUtil != null) parts.push('利用率 ' + s.avgUtil + '%');
  return \`<div class="gpu-sum" data-gpu-id="\${t.id}" title="点击\${expanded ? '收起' : '展开'}每块卡明细">
      <span class="gpu-icon">🎮</span>\${parts.join(' · ')}
      <span class="gpu-toggle">\${expanded ? '收起' : '展开'}</span>
    </div>\${expanded ? gpuDetailHtml(g.gpus) : ''}\`;
}

function render(tunnels) {
  const list = $('list');
  if (!tunnels.length) {
    list.innerHTML = '<div class="empty">还没有隧道，在上面添加一个吧</div>';
    return;
  }
  list.innerHTML = tunnels.map((t) => {
    const running = t.status === 'running';
    if (t.id === editingId) return editRowHtml(t, running);
    const ssh = 'ssh -p ' + t.port + ' ' + (t.user || 'root') + '@127.0.0.1';
    // 运行中但远程探测失败 → 远程不可达（远程关机 / 断网 / 后端下线）
    const unreachable = running && t.reachable === false;
    const badge = unreachable
      ? '<span class="badge unreachable" title="'+esc(t.checkReason||'SSH 探测失败：远程服务器可能已关机')+'">已断开</span>'
      : '<span class="badge '+(running?'running':'stopped')+'">'+(running?'运行中':'已停止')+'</span>';
    return \`
    <div class="row">
      <div class="info">
        <div class="name">\${esc(t.name)} \${badge}\${t.pid?'<span class="sub" style="color:var(--muted);font-size:11px">pid '+t.pid+'</span>':''}</div>
        <div class="url" title="\${esc(t.url)}">\${esc(t.url)}\${t.args?'  ·  '+esc(t.args):''}</div>
        <div class="ssh \${running&&!unreachable?'ready':'off'}" data-cmd="\${esc(ssh)}" title="点击复制 ssh 指令">\${esc(ssh)} <span class="copy">\${unreachable?'已断开':(running?'点击复制':'未运行')}</span></div>
        \${gpuBlockHtml(t)}
      </div>
      <div class="actions">
        \${running
          ? '<button class="btn-stop" data-act="stop" data-id="'+t.id+'">停止</button>'
          : '<button class="btn-start" data-act="start" data-id="'+t.id+'">启动</button>'}
        <button class="btn-edit" data-act="edit" data-id="\${t.id}">编辑</button>
        <button class="btn-ghost" data-act="log" data-id="\${t.id}">日志</button>
        <button class="btn-del" data-act="del" data-id="\${t.id}" data-name="\${esc(t.name)}">删除</button>
      </div>
    </div>\`;
  }).join('');
}

// 行内编辑表单：预填当前值，提供「保存」/（运行中再加）「保存并重启」/「取消」。
function editRowHtml(t, running) {
  return \`
    <div class="row editing">
      <div class="edit-grid">
        <div class="field"><label>名称</label><input class="e-name" type="text" value="\${esc(t.name)}"></div>
        <div class="field"><label>远程 URL</label><input class="e-url" type="text" value="\${esc(t.url)}"></div>
        <div class="field"><label>用户名</label><input class="e-user" type="text" value="\${esc(t.user||'root')}"></div>
        <div class="field"><label>本地端口</label><input class="e-port" type="number" min="1" max="65535" value="\${esc(t.port)}"></div>
        <div class="field"><label>额外参数</label><input class="e-args" type="text" value="\${esc(t.args||'')}"></div>
      </div>
      <div class="actions">
        <button class="btn-primary" data-act="save" data-id="\${t.id}">保存</button>
        \${running ? '<button class="btn-start" data-act="save-restart" data-id="'+t.id+'">保存并重启</button>' : ''}
        <button class="btn-ghost" data-act="cancel" data-id="\${t.id}">取消</button>
      </div>
    </div>\`;
}

async function refresh() {
  try {
    const data = await api('/api/tunnels');
    lastTunnels = data.tunnels;
    if (editingId) return;            // 编辑中：保留表单，不被定时刷新覆盖
    render(data.tunnels);
  } catch (e) { /* 静默，下一轮重试 */ }
}

$('f-add').addEventListener('click', async () => {
  const body = {
    name: $('f-name').value,
    url: $('f-url').value,
    user: $('f-user').value,
    port: $('f-port').value,
    args: $('f-args').value,
  };
  if (!body.url.trim()) return toast('请填写远程 URL', true);
  if (!body.port) return toast('请填写本地端口', true);
  try {
    await api('/api/tunnels', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    $('f-name').value = ''; $('f-url').value = ''; $('f-user').value = 'root'; $('f-port').value = ''; $('f-args').value = '';
    toast('已添加');
    refresh();
  } catch (e) { toast(e.message, true); }
});

$('list').addEventListener('click', async (ev) => {
  // 点击 GPU 概览行：展开/收起该隧道的每块卡明细（纯前端态，不发请求）
  const gpuEl = ev.target.closest('.gpu-sum');
  if (gpuEl) {
    const gid = gpuEl.dataset.gpuId;
    if (gpuExpanded.has(gid)) gpuExpanded.delete(gid); else gpuExpanded.add(gid);
    render(lastTunnels);
    return;
  }
  const sshEl = ev.target.closest('.ssh');
  if (sshEl) {
    try { await navigator.clipboard.writeText(sshEl.dataset.cmd); toast('已复制: ' + sshEl.dataset.cmd); }
    catch (_) { toast('复制失败，请手动选择', true); }
    return;
  }
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id, name } = btn.dataset;

  // 进入编辑：切换该行为表单（不发请求）
  if (act === 'edit') { editingId = id; render(lastTunnels); return; }
  // 取消编辑：还原显示
  if (act === 'cancel') { editingId = null; render(lastTunnels); return; }

  // 保存 / 保存并重启：读取表单值，PUT 更新配置
  if (act === 'save' || act === 'save-restart') {
    const row = btn.closest('.row.editing');
    const body = {
      name: row.querySelector('.e-name').value,
      url: row.querySelector('.e-url').value,
      user: row.querySelector('.e-user').value,
      port: row.querySelector('.e-port').value,
      args: row.querySelector('.e-args').value,
    };
    if (!body.url.trim()) return toast('请填写远程 URL', true);
    if (!body.port) return toast('请填写本地端口', true);
    btn.disabled = true;
    try {
      await api('/api/tunnels/'+id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (act === 'save-restart') {
        await api('/api/tunnels/'+id+'/restart', {method:'POST'});
        toast('已保存并用新配置重启');
      } else {
        toast('已保存');
      }
      editingId = null;
      refresh();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
    return;
  }

  btn.disabled = true;
  try {
    if (act === 'start') { await api('/api/tunnels/'+id+'/start', {method:'POST'}); toast('已启动'); }
    else if (act === 'stop') { await api('/api/tunnels/'+id+'/stop', {method:'POST'}); toast('已停止'); }
    else if (act === 'del') {
      if (!confirm('删除隧道「'+name+'」？若在运行会先停止。')) { btn.disabled = false; return; }
      await api('/api/tunnels/'+id, {method:'DELETE'}); toast('已删除');
    } else if (act === 'log') {
      const data = await api('/api/tunnels/'+id+'/log');
      alert(data.log || '(无日志)');
    }
    refresh();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; }
});

$('quit').addEventListener('click', async () => {
  if (!confirm('退出管理器？\\n将关闭后台进程（释放 7070 端口）。已运行的隧道是独立进程，不受影响，会继续在后台运行。')) return;
  clearInterval(refreshTimer);
  try {
    await api('/api/shutdown', { method: 'POST' });
  } catch (_) { /* 进程可能在响应前就退出了，忽略 */ }
  document.querySelector('.wrap').innerHTML =
    '<div class="empty" style="padding:80px 0">管理器后台已关闭（7070 端口已释放），可以安全关掉此标签页。<br><span style="font-size:12px">已运行的隧道仍在后台运行；需要时重新运行 node server.js 即可再次接管。</span></div>';
});

refresh();
const refreshTimer = setInterval(refresh, 3000);
</script>
</body>
</html>`;

// ---------- 启动 ----------
ensureDirs();
migrateLegacy();          // 首次运行时把旧版单文件配置拆成 SHARED_CONFIG + RUNTIME_FILE
reconcile(loadTunnels()); // 启动即接管已有进程的真实状态

// 后台周期性探测「运行中」隧道的远程可达性（检测远程关机/断网）
runHealthChecks();
setInterval(runHealthChecks, 15000);

// 后台周期性查询「运行中」隧道节点的 GPU 使用情况（SSH + nvidia-smi）
runGpuChecks();
setInterval(runGpuChecks, 15000);

server.listen(WEB_PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${WEB_PORT}`;
  console.log(`rtunnel 管理器已启动: ${url}`);
  console.log(`共享配置: ${SHARED_CONFIG}`);
  console.log(`本机状态: ${RUNTIME_FILE}`);
  // 尽力自动打开浏览器（仅 macOS，失败忽略）
  if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${WEB_PORT} 已被占用。可能管理器已在运行，或用 RT_MANAGER_PORT 换个端口。`);
  } else {
    console.error('服务器错误:', err.message);
  }
  process.exit(1);
});
