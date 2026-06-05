'use strict';

// Electron 主进程：启动内置 HTTP 服务（来自 server.js），再用 BrowserWindow 加载它。
// 双击 .app 启动；窗口关闭即退出，整个进程一并清理。

// 关闭 server.js 在 macOS 上的「自动调用 open 打开默认浏览器」行为，
// 否则 Electron 自己的窗口 + 系统浏览器会一起弹出来。
process.env.RT_NO_AUTOOPEN = '1';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, Menu, shell, nativeImage } = require('electron');

// 打包态下 __dirname 是 asar 内的只读路径；server.js 默认会往同目录写 tunnels.json，
// 在这里把它重定向到用户可写的 Application Support。CLI 直接跑 server.js 时不影响。
if (app.isPackaged && !process.env.RT_SHARED_CONFIG) {
  const dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'rtunnel-manager');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
  process.env.RT_SHARED_CONFIG = path.join(dataDir, 'tunnels.json');
}

const { startServer, WEB_PORT } = require('./server.js');

// 关掉硬件加速可以避免少数花屏机器在打开窗口时闪烁；
// 对一个管理面板来说不需要 GPU 合成。
app.disableHardwareAcceleration();

let mainWindow = null;
let serverReady = null;

async function ensureServer() {
  if (serverReady) return serverReady;
  serverReady = startServer({ skipAutoOpen: true })
    .then(() => waitForPort(WEB_PORT, 5000));
  return serverReady;
}

function waitForPort(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = require('http').get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('server start timeout'));
        setTimeout(tick, 80);
      });
    };
    tick();
  });
}

function createWindow() {
  // 高分辨率应用图标走 .app bundle 里的 .icns（由 electron-builder 安置到正确位置）。
  // BrowserWindow 不再额外设 icon —— 否则有些平台会用低分辨率的 icon 字段覆盖 dock 图标。
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 500,
    backgroundColor: '#fafbfc',
    titleBarStyle: 'hiddenInset',
    title: 'rtunnel',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${WEB_PORT}/`);

  // 站外链接（footer 上的 GitHub 链接等）走系统浏览器，别在应用窗口里换页。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (ev, url) => {
    const target = new URL(url);
    if (target.host !== `127.0.0.1:${WEB_PORT}`) {
      ev.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  // 给到 macOS 标准菜单 + 几个常用快捷键（复制 / 粘贴 / 关闭窗口）。
  // 不放「刷新间隔」这种低价值控件 —— 跟前端顶栏原则一致。
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: '退出 rtunnel' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  try {
    await ensureServer();
  } catch (e) {
    const { dialog } = require('electron');
    dialog.showErrorBox('启动失败', '内置 HTTP 服务无法启动：' + e.message);
    app.quit();
    return;
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS 默认按惯例应保留 Dock 图标到用户 ⌘Q，但管理器是工具型 app，
  // 关掉窗口就让它整体退出更直观（也确保 server 释放端口）。
  app.quit();
});
