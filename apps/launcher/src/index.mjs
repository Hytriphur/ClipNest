import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRootDefault = path.resolve(__dirname, '../../..');

const host = process.env.LAUNCHER_HOST || '127.0.0.1';
const port = Number(process.env.LAUNCHER_PORT || 5180);
const token = String(process.env.LAUNCHER_TOKEN || '').trim();
const serverUrl = process.env.CLIPNEST_SERVER_URL || 'http://127.0.0.1:5174';
const webUrl = process.env.CLIPNEST_WEB_URL || 'http://127.0.0.1:5173';
const repoRoot = process.env.CLIPNEST_REPO_ROOT || repoRootDefault;
const serverTaskName = process.env.CLIPNEST_SERVER_TASK || 'ClipNest Server';
const webTaskName = process.env.CLIPNEST_WEB_TASK || 'ClipNest Web';
const serverProxy = process.env.CLIPNEST_SERVER_PROXY || 'http://127.0.0.1:7890';

function parsePort(input, fallbackPort) {
  try {
    const u = new URL(input);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return fallbackPort;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-clipnest-token');
  res.end(JSON.stringify(payload));
}

function isAuthorized(req) {
  if (!token) return true;
  const incoming = req.headers['x-clipnest-token'];
  return typeof incoming === 'string' && incoming.trim() === token;
}

function runPowerShell(command) {
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk ?? '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk ?? '');
    });
    child.on('error', (error) => {
      resolve({ ok: false, code: -1, stdout, stderr, error: String(error) });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

async function probeHealth(url, timeoutMs = 2000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctl.signal });
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntilHealthy(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await probeHealth(url, 1500);
    if (status.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startByTask(taskName) {
  const command = `$ErrorActionPreference='Stop'; Start-ScheduledTask -TaskName ${shellQuote(taskName)}; 'ok'`;
  return runPowerShell(command);
}

function spawnScript(scriptPath, extraArgs = []) {
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `script not found: ${scriptPath}` };
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath, ...extraArgs];
  try {
    const child = spawn('powershell.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function stopPortProcess(targetPort) {
  const command =
    `$ErrorActionPreference='SilentlyContinue'; ` +
    `$ids=@(Get-NetTCPConnection -State Listen -LocalPort ${targetPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); ` +
    `foreach($id in $ids){ try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {} }; ` +
    `($ids -join ',')`;
  return runPowerShell(command);
}

async function startServer() {
  const health = await probeHealth(`${serverUrl}/api/health`);
  if (health.ok) {
    return { ok: true, running: true, action: 'already_running' };
  }

  const taskStart = await startByTask(serverTaskName);
  let method = 'scheduled_task';
  if (!taskStart.ok) {
    const scriptPath = path.join(repoRoot, 'scripts', 'clipnest-run-server.ps1');
    const scriptStart = spawnScript(scriptPath, [
      '-RepoRoot',
      repoRoot,
      '-Proxy',
      serverProxy,
      '-Port',
      String(parsePort(serverUrl, 5174)),
    ]);
    method = 'script_fallback';
    if (!scriptStart.ok) {
      return {
        ok: false,
        action: method,
        error: scriptStart.error || taskStart.stderr || taskStart.stdout || 'start failed',
      };
    }
  }

  const ready = await waitUntilHealthy(`${serverUrl}/api/health`, 25000);
  return {
    ok: ready,
    action: method,
    running: ready,
    error: ready ? undefined : 'service did not become healthy in time',
  };
}

async function restartServer() {
  await stopPortProcess(parsePort(serverUrl, 5174));
  return startServer();
}

async function startWeb() {
  const health = await probeHealth(webUrl);
  if (health.ok) {
    return { ok: true, running: true, action: 'already_running' };
  }

  const taskStart = await startByTask(webTaskName);
  let method = 'scheduled_task';
  if (!taskStart.ok) {
    const scriptPath = path.join(repoRoot, 'scripts', 'clipnest-run-web.ps1');
    const scriptStart = spawnScript(scriptPath, [
      '-RepoRoot',
      repoRoot,
      '-WebPort',
      String(parsePort(webUrl, 5173)),
    ]);
    method = 'script_fallback';
    if (!scriptStart.ok) {
      return {
        ok: false,
        action: method,
        error: scriptStart.error || taskStart.stderr || taskStart.stdout || 'start failed',
      };
    }
  }

  const ready = await waitUntilHealthy(webUrl, 15000);
  return {
    ok: ready,
    action: method,
    running: ready,
    error: ready ? undefined : 'web did not become ready in time',
  };
}

async function restartWeb() {
  await stopPortProcess(parsePort(webUrl, 5173));
  return startWeb();
}

const server = createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${host}:${port}`);
  const pathname = reqUrl.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'clipnest-launcher',
      now: nowIso(),
      host,
      port,
      serverUrl,
      webUrl,
      authRequired: Boolean(token),
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/server/status') {
    const status = await probeHealth(`${serverUrl}/api/health`);
    sendJson(res, 200, {
      ok: true,
      running: status.ok,
      statusCode: status.status ?? null,
      error: status.error,
      url: serverUrl,
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/web/status') {
    const status = await probeHealth(webUrl);
    sendJson(res, 200, {
      ok: true,
      running: status.ok,
      statusCode: status.status ?? null,
      error: status.error,
      url: webUrl,
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/server/start') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const out = await startServer();
    sendJson(res, out.ok ? 200 : 500, out);
    return;
  }

  if (method === 'POST' && pathname === '/api/server/restart') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const out = await restartServer();
    sendJson(res, out.ok ? 200 : 500, out);
    return;
  }

  if (method === 'POST' && pathname === '/api/web/start') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const out = await startWeb();
    sendJson(res, out.ok ? 200 : 500, out);
    return;
  }

  if (method === 'POST' && pathname === '/api/web/restart') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const out = await restartWeb();
    sendJson(res, out.ok ? 200 : 500, out);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, host, () => {
  console.log(`[launcher] listening on http://${host}:${port}`);
  console.log(`[launcher] repo: ${repoRoot}`);
  console.log(`[launcher] server target: ${serverUrl}`);
  console.log(`[launcher] web target: ${webUrl}`);
  if (token) {
    console.log('[launcher] token auth: enabled');
  } else {
    console.log('[launcher] token auth: disabled');
  }
});
