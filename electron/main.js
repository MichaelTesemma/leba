// Electron main process — Leba Desktop App
const { app, BrowserWindow, session, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const isDev = require("electron-is-dev");

let serverProcess = null;
let mainWindow = null;
let serverPort = null;

// ── Start the Express server as a child process ──
function startServer() {
  return new Promise((resolve, reject) => {
    let serverScript;
    let serverCwd;

    if (isDev) {
      // Dev: run server.ts via tsx from project root
      serverScript = path.join(__dirname, "..", "server.ts");
      serverCwd = path.join(__dirname, "..");
    } else {
      // Prod: run bundled server.js from extraResources/dist/
      serverScript = path.join(process.resourcesPath, "dist", "server.js");
      serverCwd = path.join(process.resourcesPath, "dist");
    }

    // Ensure .env exists in production
    if (!isDev) {
      const envPath = path.join(serverCwd, ".env");
      if (!fs.existsSync(envPath)) {
        const examplePath = path.join(process.resourcesPath, "dist", ".env.example");
        if (fs.existsSync(examplePath)) {
          fs.copyFileSync(examplePath, envPath);
          console.log(`[Main] Created default .env at ${envPath}`);
        }
      }
    }

    const env = { ...process.env };

    const cmd = isDev ? "npx" : "node";
    const args = isDev
      ? ["tsx", "--env-file=.env", serverScript]
      : [serverScript];

    serverProcess = spawn(cmd, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: serverCwd,
      shell: false,
    });

    serverProcess.stdout.on("data", (data) => {
      const line = data.toString();
      console.log(`[Server] ${line.trim()}`);

      // Extract port from the startup message
      const match = line.match(/http:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|localhost):(\d+)/);
      if (match) {
        serverPort = match[1];
        resolve(serverPort);
      }
    });

    serverProcess.stderr.on("data", (data) => {
      console.error(`[Server ERR] ${data.toString().trim()}`);
    });

    serverProcess.on("error", (err) => {
      console.error("[Server] Failed to start:", err);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      console.log(`[Server] Exited with code ${code}`);
      serverProcess = null;
    });

    // Safety timeout
    setTimeout(() => {
      if (!serverPort) reject(new Error("Server startup timed out"));
    }, 30000);
  });
}

// ── Create the browser window ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: "Leba",
    backgroundColor: "#03070e",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
  });

  // Relax CSP for local dev server
  if (isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' http: https: data: blob:;",
          ],
        },
      });
    });
  }

  const url = isDev
    ? "http://localhost:5173"
    : `http://127.0.0.1:${serverPort}`;

  mainWindow.loadURL(url);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Open DevTools in dev mode
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

// ── App lifecycle ──
app.whenReady().then(async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error("[Main] Failed to start:", err);
    if (!isDev) {
      dialog.showErrorBox(
        "Leba — Startup Error",
        `The application could not start.\n\n${err.message}\n\nPlease check your .env file and try again.`
      );
    }
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
});
