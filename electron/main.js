"use strict";

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");

const isDev = !app.isPackaged;
const PORT = 3001;
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");

// ── 설정 파일 ────────────────────────────────────────────────────────────────

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
  catch { return {}; }
}

function saveConfig(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ── 서버 경로 ────────────────────────────────────────────────────────────────

function getServerScript() {
  return isDev
    ? path.join(__dirname, "..", ".next", "standalone", "server.js")
    : path.join(process.resourcesPath, "standalone", "server.js");
}

function getServerCwd() {
  return isDev
    ? path.join(__dirname, "..", ".next", "standalone")
    : path.join(process.resourcesPath, "standalone");
}

// ── 서버 실행 ────────────────────────────────────────────────────────────────

let serverChild = null;

function startServer(apiKey) {
  const { utilityProcess } = require("electron");
  serverChild = utilityProcess.fork(getServerScript(), [], {
    cwd: getServerCwd(),
    env: {
      ...process.env,
      GOOGLE_AI_API_KEY: apiKey,
      PORT: String(PORT),
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
    },
  });
  serverChild.on("exit", (code) => {
    if (code !== 0) console.error("[server] 비정상 종료:", code);
  });
}

function waitForServer(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const req = http.get(`http://127.0.0.1:${PORT}`, () => resolve());
      req.on("error", () => {
        if (Date.now() > deadline) { reject(new Error("서버 시작 시간 초과")); return; }
        setTimeout(check, 600);
      });
      req.setTimeout(1000, () => { req.destroy(); });
    };
    setTimeout(check, 800);
  });
}

// ── 창 ──────────────────────────────────────────────────────────────────────

async function createSetupWindow() {
  const win = new BrowserWindow({
    width: 500,
    height: 380,
    resizable: false,
    center: true,
    title: "Clip Extractor — 초기 설정",
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  await win.loadFile(path.join(__dirname, "setup.html"));
  return win;
}

async function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 380,
    height: 220,
    resizable: false,
    center: true,
    frame: false,
    backgroundColor: "#f8fafc",
    webPreferences: { nodeIntegration: false },
  });
  win.loadURL(
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!DOCTYPE html><html><head><meta charset="UTF-8">
      <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
          background:#f8fafc;display:flex;flex-direction:column;
          align-items:center;justify-content:center;height:100vh;gap:16px;
          -webkit-app-region:drag}
        .logo{font-size:32px}
        h2{font-size:15px;font-weight:700;color:#0f172a}
        p{font-size:12px;color:#94a3b8}
        .dot{display:inline-block;width:6px;height:6px;border-radius:50%;
          background:#3b82f6;animation:blink 1.2s infinite}
        .dot:nth-child(2){animation-delay:.2s}
        .dot:nth-child(3){animation-delay:.4s}
        @keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}
      </style></head><body>
      <div class="logo">🎬</div>
      <h2>Clip Extractor</h2>
      <p>서버 시작 중&nbsp;<span class="dot"></span><span class="dot"></span><span class="dot"></span></p>
    </body></html>`)
  );
  return win;
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1224,
    height: 840,
    minWidth: 816,
    minHeight: 600,
    center: true,
    title: "Clip Extractor",
    backgroundColor: "#f8fafc",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.setMenu(null);
  win.loadURL(`http://127.0.0.1:${PORT}`);

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // 파일 다운로드 시 네이티브 저장 다이얼로그 표시
  win.webContents.session.on("will-download", (event, item) => {
    const { dialog } = require("electron");
    const filename = item.getFilename();
    const ext = path.extname(filename).slice(1) || "*";

    const savePath = dialog.showSaveDialogSync(win, {
      title: "클립 저장",
      defaultPath: path.join(app.getPath("downloads"), filename),
      filters: [{ name: ext.toUpperCase() + " 파일", extensions: [ext] }],
    });

    if (savePath) {
      item.setSavePath(savePath);
    } else {
      item.cancel();
    }
  });

  win.on("closed", () => app.quit());
  return win;
}

// ── 앱 시작 ──────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  const config = readConfig();

  if (!config.apiKey) {
    // API 키 없음 → 설정 화면
    const setupWin = await createSetupWindow();

    ipcMain.once("submit-api-key", async (_, apiKey) => {
      const key = (apiKey || "").trim();
      if (!key) { app.quit(); return; }

      saveConfig({ apiKey: key });
      setupWin.removeAllListeners("close");
      setupWin.close();

      const loading = await createLoadingWindow();
      startServer(key);
      await waitForServer().catch(() => {});
      loading.close();
      createMainWindow();
    });

    // 설정 창 닫기 = 앱 종료
    setupWin.on("close", () => app.quit());

    ipcMain.once("cancel-setup", () => app.quit());
    ipcMain.on("open-external", (_, url) => shell.openExternal(url));

  } else {
    // API 키 있음 → 바로 시작
    const loading = await createLoadingWindow();
    startServer(config.apiKey);
    await waitForServer().catch(() => {});
    loading.close();
    createMainWindow();
  }
});

app.on("will-quit", () => {
  if (serverChild) serverChild.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
