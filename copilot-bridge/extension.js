/* ─────────────────────────────────────────────────────────────────────────────
 *  Copilot AI Bridge — VS Code Extension
 *  Starts a lightweight HTTP server on port 3001 that proxies requests
 *  to VS Code's Language Model API (vscode.lm), giving external tools
 *  access to any Copilot-licensed model (Claude Opus, GPT-4o, etc.).
 * ───────────────────────────────────────────────────────────────────────────── */

const vscode = require('vscode');
const http   = require('http');

const PORT = 3001;
let server = null;
let statusBarItem = null;

/* ── Activation ──────────────────────────────────────────────────────────── */

function activate(context) {
  // Status-bar indicator
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'copilotBridge.toggle';
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotBridge.start',  () => startServer()),
    vscode.commands.registerCommand('copilotBridge.stop',   () => stopServer()),
    vscode.commands.registerCommand('copilotBridge.toggle', () => {
      if (server) { stopServer(); } else { startServer(); }
    })
  );

  // Auto-start on activation
  startServer();
}

/* ── Model Discovery ─────────────────────────────────────────────────────── */

async function getAvailableModels() {
  try {
    const models = await vscode.lm.selectChatModels({});
    return models.map(m => ({
      id:             m.id,
      family:         m.family,
      name:           m.name || m.family,
      vendor:         m.vendor || '',
      maxInputTokens: m.maxInputTokens
    }));
  } catch {
    return [];
  }
}

/* ── Analyze Handler ─────────────────────────────────────────────────────── */

async function handleAnalyze(body) {
  const modelFamily = body.modelFamily || 'claude-opus-4';
  const prompt      = body.prompt      || '';

  if (!prompt) { throw new Error('No prompt provided'); }

  // 1. Try exact family match
  let models = await vscode.lm.selectChatModels({ family: modelFamily });

  // 2. Fuzzy fallback — search across all available models
  if (!models.length) {
    const all = await vscode.lm.selectChatModels({});
    const needle = modelFamily.toLowerCase();
    models = all.filter(m =>
      (m.family || '').toLowerCase().includes(needle) ||
      (m.id     || '').toLowerCase().includes(needle)
    );
  }

  if (!models.length) {
    const available = await getAvailableModels();
    throw new Error(
      'Model family "' + modelFamily + '" not available in Copilot. ' +
      'Available: ' + (available.map(m => m.family).join(', ') || 'none — is Copilot Chat installed?')
    );
  }

  const model    = models[0];
  const messages  = [vscode.LanguageModelChatMessage.User(prompt)];

  // Cancellation token with 2-minute timeout
  const cts = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cts.cancel(), 120000);

  try {
    const response = await model.sendRequest(messages, {}, cts.token);
    let text = '';
    for await (const chunk of response.text) { text += chunk; }
    return {
      text:   text,
      model:  model.name || model.family || model.id,
      family: model.family,
      usage:  {}
    };
  } finally {
    clearTimeout(timer);
    cts.dispose();
  }
}

/* ── HTTP Server ─────────────────────────────────────────────────────────── */

function startServer() {
  if (server) { updateStatus(true); return; }

  server = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── GET /health ─────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/health') {
      getAvailableModels().then(models => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: 'Copilot AI Bridge', port: PORT, models: models }));
      }).catch(err => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: 'Copilot AI Bridge', port: PORT, models: [], error: err.message }));
      });
      return;
    }

    // ── POST /analyze ───────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/analyze') {
      let bodyStr = '';
      req.on('data', c => bodyStr += c);
      req.on('end', () => {
        let body;
        try { body = JSON.parse(bodyStr); } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        handleAnalyze(body).then(result => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    updateStatus(true);
    vscode.window.showInformationMessage('Copilot AI Bridge running on port ' + PORT);
  });

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      vscode.window.showWarningMessage('Copilot Bridge: Port ' + PORT + ' already in use — another instance may be running.');
      updateStatus(true); // Assume it's running
    } else {
      vscode.window.showErrorMessage('Copilot Bridge error: ' + err.message);
      updateStatus(false);
    }
    server = null;
  });
}

function stopServer() {
  if (server) {
    server.close();
    server = null;
    updateStatus(false);
    vscode.window.showInformationMessage('Copilot AI Bridge stopped');
  }
}

/* ── Status Bar ──────────────────────────────────────────────────────────── */

function updateStatus(running) {
  if (!statusBarItem) { return; }
  if (running) {
    statusBarItem.text      = '$(zap) Copilot Bridge';
    statusBarItem.tooltip   = 'Copilot AI Bridge running on port ' + PORT + ' — click to stop';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text      = '$(circle-slash) Copilot Bridge';
    statusBarItem.tooltip   = 'Copilot AI Bridge stopped — click to start';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

/* ── Deactivation ────────────────────────────────────────────────────────── */

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };
