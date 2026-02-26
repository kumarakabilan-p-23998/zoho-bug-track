'use strict';
/**
 * logger.js — Structured JSON logging system for Zoho Bug Tracker.
 *
 * Features:
 *   - Structured JSON log entries (timestamp, level, category, message, data)
 *   - Session-based log files: logs/<session-id>.jsonl  (one JSON per line)
 *   - Daily rotated combined log: logs/YYYY-MM-DD.jsonl
 *   - Log levels: DEBUG, INFO, WARN, ERROR, FATAL
 *   - Categories: SYSTEM, AUTH, BUG, ANALYZE, AI_PROMPT, AI_RESPONSE, PATCH, AGENT, REPRO, API
 *   - Automatic console mirror with colour + prefix
 *   - Stored in ~/Documents/.zoho-bug-track-logs/
 *   - Session management (start/end with summary)
 *   - Query API: search logs by date, level, category, bugId, sessionId
 *   - Node 8 compatible. Zero dependencies.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');

// ── Constants ────────────────────────────────────────────

var LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
var LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
var LEVEL_COLORS = {
  DEBUG: '\x1b[90m',   // gray
  INFO:  '\x1b[36m',   // cyan
  WARN:  '\x1b[33m',   // yellow
  ERROR: '\x1b[31m',   // red
  FATAL: '\x1b[35m'    // magenta
};
var RESET = '\x1b[0m';
var BOLD  = '\x1b[1m';

var CATEGORIES = [
  'SYSTEM',       // Server start/stop, config changes
  'AUTH',         // Login, logout, OAuth
  'BUG',          // Bug list, detail fetches
  'ANALYZE',      // Full analysis pipeline (steps 1-6)
  'AI_PROMPT',    // Full prompt text sent to AI
  'AI_RESPONSE',  // AI response text, usage, timing
  'PATCH',        // Preview, apply, revert, backup, merge strategy
  'AGENT',        // Agent proxy calls (health, scan, template ctx)
  'REPRO',        // Playwright reproduction (layer 2, scripts, results)
  'API'           // Generic API request/response
];

// ── Log directory (~/Documents/.zoho-bug-track-logs/) ────

function getLogRoot() {
  var home = os.homedir();
  // Windows: ~/Documents, Mac/Linux: ~/Documents
  var docs = path.join(home, 'Documents');
  if (!fs.existsSync(docs)) docs = home;
  return path.join(docs, '.zoho-bug-track-logs');
}

/**
 * Recursively create a directory path (Node 8 compatible).
 */
function mkdirpSync(dirPath) {
  var parts = path.resolve(dirPath).split(path.sep);
  var current = '';
  for (var i = 0; i < parts.length; i++) {
    current = current ? path.join(current, parts[i]) : parts[i] + path.sep;
    if (current === path.sep || current.match(/^[A-Z]:\\$/i)) continue;
    try { fs.mkdirSync(current); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

// ── Bug Title Registry ────────────────────────────────────
// Maps bugId → title so we can name folders with human-readable slugs.

var _bugTitles = {};

/**
 * Register a bug title for use in folder naming.
 * Call this when bug details are fetched.
 */
function registerBug(bugId, title) {
  if (bugId && title) {
    _bugTitles[String(bugId)] = String(title);
  }
}

/**
 * Convert a string to a filesystem-safe slug.
 * "Sidebar not rendering properly!" → "sidebar-not-rendering-properly"
 */
function slugify(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

/**
 * Create a human-readable timestamp for file names.
 * Returns "2026-02-26_13-30-01"
 */
function readableTimestamp() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
}

/**
 * Find an existing bug folder in a directory by bugId.
 * Handles both exact match ("334688...") and slug match ("334688..._sidebar-...").
 */
function _findBugFolder(baseDir, bugId) {
  if (!fs.existsSync(baseDir)) return null;
  // Exact match first
  var exact = path.join(baseDir, bugId);
  if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) return exact;
  // Prefix match: folder starts with bugId_
  try {
    var dirs = fs.readdirSync(baseDir);
    for (var i = 0; i < dirs.length; i++) {
      if (dirs[i].indexOf(bugId + '_') === 0) {
        var candidate = path.join(baseDir, dirs[i]);
        try {
          if (fs.statSync(candidate).isDirectory()) return candidate;
        } catch (e) { /* skip */ }
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Resolve the actual bug folder path for reading.
 * Checks new "bugs/" dir first, then falls back to old "prompts/" dir.
 */
function _resolveBugDir(bugId) {
  var bugsDir = path.join(_logRoot || getLogRoot(), 'bugs');
  var found = _findBugFolder(bugsDir, bugId);
  if (found) return found;
  // Backward compat: check old 'prompts/' dir
  var oldDir = path.join(_logRoot || getLogRoot(), 'prompts', bugId);
  if (fs.existsSync(oldDir)) return oldDir;
  return null;
}

// ── Logger State ─────────────────────────────────────────

var _logRoot       = null;  // Resolved on first use
var _minLevel      = LEVELS.DEBUG;
var _consoleOutput = true;
var _sessionId     = null;
var _sessionFile   = null;  // Write stream for session log
var _dailyFile     = null;  // Write stream for daily log
var _dailyDate     = null;  // 'YYYY-MM-DD' for current daily file
var _sessionStats  = null;  // Counters per category/level
var _initialized   = false;

// ── Initialization ───────────────────────────────────────

function ensureInit() {
  if (_initialized) return;
  _logRoot = getLogRoot();
  mkdirpSync(_logRoot);
  _initialized = true;
}

/**
 * Generate a short unique session ID.
 */
function generateSessionId() {
  var now = new Date();
  return now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
    + '_' + pad2(now.getHours()) + '-' + pad2(now.getMinutes()) + '-' + pad2(now.getSeconds());
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function getDateStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function getTimestamp() {
  return new Date().toISOString();
}

// ── File Streams ─────────────────────────────────────────

function getSessionStream() {
  if (!_sessionId) return null;
  if (!_sessionFile) {
    ensureInit();
    var sessDir = path.join(_logRoot, 'sessions');
    mkdirpSync(sessDir);
    var filePath = path.join(sessDir, _sessionId + '.jsonl');
    _sessionFile = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' });
  }
  return _sessionFile;
}

function getDailyStream() {
  var today = getDateStr();
  if (_dailyDate !== today || !_dailyFile) {
    // Close old stream if date rolled over
    if (_dailyFile && _dailyDate !== today) {
      try { _dailyFile.end(); } catch (e) { /* ignore */ }
      _dailyFile = null;
    }
    ensureInit();
    var dailyDir = path.join(_logRoot, 'daily');
    mkdirpSync(dailyDir);
    var filePath = path.join(dailyDir, today + '.jsonl');
    _dailyFile = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' });
    _dailyDate = today;
  }
  return _dailyFile;
}

// ── Core Log Writer ──────────────────────────────────────

/**
 * Write a structured log entry.
 *
 * @param {string} level    - DEBUG|INFO|WARN|ERROR|FATAL
 * @param {string} category - SYSTEM|AUTH|BUG|ANALYZE|AI_PROMPT|AI_RESPONSE|PATCH|AGENT|REPRO|API
 * @param {string} message  - Human-readable message
 * @param {object} [data]   - Arbitrary structured data (bugId, duration, model, etc.)
 */
function log(level, category, message, data) {
  var levelNum = LEVELS[level];
  if (levelNum === undefined) levelNum = LEVELS.INFO;
  if (levelNum < _minLevel) return;

  var entry = {
    ts: getTimestamp(),
    level: level,
    cat: category || 'SYSTEM',
    msg: message || '',
    sid: _sessionId || null
  };

  // Attach data fields (flatten common ones to top level of entry)
  if (data) {
    if (data.bugId)    entry.bugId    = data.bugId;
    if (data.userId)   entry.userId   = data.userId;
    if (data.model)    entry.model    = data.model;
    if (data.duration) entry.duration = data.duration;
    if (data.error)    entry.error    = data.error;
    // Everything in data goes into 'd' for full context
    entry.d = data;
  }

  var jsonLine = JSON.stringify(entry) + '\n';

  // Write to session log
  var sessStream = getSessionStream();
  if (sessStream) {
    try { sessStream.write(jsonLine); } catch (e) { /* */ }
  }

  // Write to daily log
  var dailyStream = getDailyStream();
  if (dailyStream) {
    try { dailyStream.write(jsonLine); } catch (e) { /* */ }
  }

  // Update session stats
  if (_sessionStats) {
    _sessionStats.total = (_sessionStats.total || 0) + 1;
    _sessionStats[level] = (_sessionStats[level] || 0) + 1;
    _sessionStats['_cat_' + category] = (_sessionStats['_cat_' + category] || 0) + 1;
  }

  // Console mirror
  if (_consoleOutput) {
    var color = LEVEL_COLORS[level] || '';
    var catTag = '[' + (category || 'SYS').substring(0, 8) + ']';
    var prefix = color + BOLD + level.substring(0, 4) + RESET + ' ' + color + catTag + RESET;
    var consoleMsg = prefix + ' ' + message;
    if (data && data.error) consoleMsg += ' | error=' + data.error;
    if (data && data.duration) consoleMsg += ' | ' + data.duration + 'ms';

    if (levelNum >= LEVELS.ERROR) {
      console.error(consoleMsg);
    } else if (levelNum >= LEVELS.WARN) {
      console.warn(consoleMsg);
    } else {
      console.log(consoleMsg);
    }
  }
}

// ── Convenience methods ──────────────────────────────────

function debug(category, message, data) { log('DEBUG', category, message, data); }
function info(category, message, data)  { log('INFO',  category, message, data); }
function warn(category, message, data)  { log('WARN',  category, message, data); }
function error(category, message, data) { log('ERROR', category, message, data); }
function fatal(category, message, data) { log('FATAL', category, message, data); }

// ── Session Management ───────────────────────────────────

/**
 * Start a new logging session. Returns the session ID.
 * Call this when the server starts or a major workflow begins.
 */
function startSession(metadata) {
  ensureInit();
  _sessionId = generateSessionId();
  _sessionStats = { total: 0, startedAt: getTimestamp() };

  // Close any previous session file
  if (_sessionFile) {
    try { _sessionFile.end(); } catch (e) { /* */ }
    _sessionFile = null;
  }

  info('SYSTEM', 'Session started', Object.assign({}, metadata || {}, {
    sessionId: _sessionId,
    logRoot: _logRoot,
    pid: process.pid,
    nodeVersion: process.version,
    platform: os.platform(),
    hostname: os.hostname()
  }));

  return _sessionId;
}

/**
 * End the current session and write summary.
 */
function endSession() {
  if (!_sessionId) return;

  _sessionStats.endedAt = getTimestamp();
  if (_sessionStats.startedAt) {
    var start = new Date(_sessionStats.startedAt).getTime();
    var end = new Date(_sessionStats.endedAt).getTime();
    _sessionStats.durationMs = end - start;
  }

  info('SYSTEM', 'Session ended', { summary: _sessionStats });

  // Flush streams
  if (_sessionFile) {
    try { _sessionFile.end(); } catch (e) { /* */ }
    _sessionFile = null;
  }
  if (_dailyFile) {
    try { _dailyFile.end(); } catch (e) { /* */ }
    _dailyFile = null;
  }

  _sessionId = null;
  _sessionStats = null;
}

// ── Analysis Pipeline Logger ─────────────────────────────
// Structured helpers for the analyze→fix→apply pipeline.

/**
 * Log the start of a bug analysis.
 */
function analyzeStart(bugId, userId, opts) {
  info('ANALYZE', 'Analysis started', Object.assign({
    bugId: bugId,
    userId: userId,
    step: '1/6',
    phase: 'start'
  }, opts || {}));
}

/**
 * Log bug details being fetched.
 */
function bugFetched(bugId, bugData, durationMs) {
  // Register the bug title for use in folder naming
  if (bugData && bugData.title) {
    registerBug(bugId, bugData.title);
  }

  info('ANALYZE', 'Bug details fetched', {
    bugId: bugId,
    step: '2/6',
    phase: 'bug-fetch',
    duration: durationMs,
    title: (bugData.title || '').substring(0, 120),
    status: bugData.status,
    severity: bugData.severity,
    module: bugData.module || '',
    attachments: bugData.attachmentCount || 0,
    comments: bugData.commentCount || 0
  });
}

/**
 * Log route auto-detection result.
 */
function routeDetected(bugId, route, method, score) {
  info('ANALYZE', 'Route detected', {
    bugId: bugId,
    phase: 'route-detect',
    route: route || '(none)',
    method: method || '',
    score: score || 0
  });
}

/**
 * Log code scanning completion.
 */
function codeScanComplete(bugId, result, durationMs, agentUrl) {
  info('ANALYZE', 'Code scan complete', {
    bugId: bugId,
    step: '3/6',
    phase: 'code-scan',
    duration: durationMs,
    relevantFiles: result.relevantFiles ? result.relevantFiles.length : 0,
    codeMatches: result.codeMatches ? result.codeMatches.length : 0,
    fileContents: result.fileContents ? result.fileContents.length : 0,
    promptLength: (result.prompt || '').length,
    via: agentUrl ? 'agent' : 'local'
  });
}

/**
 * Log the full AI prompt being sent. This is the key log the user requested.
 */
function aiPromptSent(bugId, prompt, opts) {
  var data = {
    bugId: bugId,
    step: '5/6',
    phase: 'ai-prompt',
    promptLength: prompt.length,
    promptPreview: prompt.substring(0, 500),
    model: (opts || {}).model || '',
    provider: (opts || {}).provider || '',
    hasImages: (opts || {}).imageCount > 0,
    imageCount: (opts || {}).imageCount || 0
  };

  // Log a summary to daily/session
  info('AI_PROMPT', 'AI prompt sent', data);

  // Also write the FULL prompt to a dedicated prompt log file
  _writePromptFile(bugId, 'analyze', prompt, opts);
}

/**
 * Log AI response received.
 */
function aiResponseReceived(bugId, result, durationMs, opts) {
  var data = {
    bugId: bugId,
    step: '6/6',
    phase: 'ai-response',
    duration: durationMs,
    model: result.model || '',
    responseLength: (result.text || '').length,
    responsePreview: (result.text || '').substring(0, 300),
    usage: result.usage || {},
    finishReason: result.finishReason || result.stopReason || '',
    provider: (opts || {}).provider || ''
  };

  info('AI_RESPONSE', 'AI response received', data);

  // Write full response to prompt log file
  _writeResponseFile(bugId, 'analyze', result.text, result);
}

/**
 * Log AI error.
 */
function aiError(bugId, errorMsg, opts) {
  error('AI_RESPONSE', 'AI request failed', {
    bugId: bugId,
    error: errorMsg,
    model: (opts || {}).model || '',
    provider: (opts || {}).provider || ''
  });
}

/**
 * Log interaction steps prompt (Layer 2).
 */
function interactionPromptSent(bugId, prompt, opts) {
  info('AI_PROMPT', 'Interaction steps prompt sent', {
    bugId: bugId,
    phase: 'interaction-steps',
    promptLength: prompt.length,
    promptPreview: prompt.substring(0, 300),
    model: (opts || {}).model || '',
    provider: (opts || {}).provider || ''
  });

  _writePromptFile(bugId, 'interaction', prompt, opts);
}

/**
 * Log reproduction attempt.
 */
function reproAttempt(bugId, result) {
  var level = (result && result.bugConfirmed) ? 'WARN' : 'INFO';
  log(level, 'REPRO', 'Reproduction attempt', {
    bugId: bugId,
    phase: 'repro',
    attempted: !!(result && result.attempted),
    bugConfirmed: !!(result && result.bugConfirmed),
    status: result ? result.status : 'skipped',
    assertionsPassed: result ? result.assertionsPassed : 0,
    assertionsFailed: result ? result.assertionsFailed : 0,
    screenshots: result && result.screenshotFile ? 1 : 0,
    steps: result && result.steps ? result.steps.length : 0
  });
}

/**
 * Log patch/apply operations.
 */
function patchOperation(op, filePath, result) {
  var level = result.error ? 'ERROR' : 'INFO';
  log(level, 'PATCH', 'Patch ' + op, {
    operation: op,
    file: filePath,
    strategy: result.strategy || '',
    hunksApplied: result.hunksApplied || 0,
    hunksTotal: result.hunksTotal || 0,
    backupPath: result.backupPath || '',
    error: result.error || null,
    duration: result.duration || 0
  });
}

/**
 * Log API request (generic).
 */
function apiRequest(method, endpoint, userId, durationMs, statusCode) {
  debug('API', method + ' ' + endpoint, {
    userId: userId,
    duration: durationMs,
    status: statusCode
  });
}

/**
 * Log authentication events.
 */
function authEvent(action, userId, details) {
  info('AUTH', action, Object.assign({ userId: userId }, details || {}));
}

// ── Full Prompt/Response File Storage ────────────────────
// Separate files per bug per analysis run with full content.

function _getPromptDir(bugId) {
  ensureInit();
  var bid = String(bugId);
  var bugsDir = path.join(_logRoot, 'bugs');
  mkdirpSync(bugsDir);

  // Check if a folder already exists for this bug
  var existing = _findBugFolder(bugsDir, bid);
  if (existing) return existing;

  // Create new folder: "<bugId>_<title-slug>" or just "<bugId>"
  var title = _bugTitles[bid] || '';
  var slug = slugify(title);
  var folderName = slug ? bid + '_' + slug : bid;
  var dir = path.join(bugsDir, folderName);
  mkdirpSync(dir);
  return dir;
}

function _writePromptFile(bugId, type, prompt, opts) {
  try {
    var dir = _getPromptDir(bugId);
    var ts = readableTimestamp();
    var fileName = 'prompt_' + type + '_' + ts + '.txt';
    var bugTitle = _bugTitles[String(bugId)] || '';
    var header = '# ' + type.toUpperCase() + ' PROMPT\n'
      + '# Bug ID: ' + bugId + '\n'
      + (bugTitle ? '# Bug Title: ' + bugTitle + '\n' : '')
      + '# Model: ' + ((opts || {}).model || 'unknown') + '\n'
      + '# Provider: ' + ((opts || {}).provider || 'unknown') + '\n'
      + '# Timestamp: ' + new Date().toISOString() + '\n'
      + '# Length: ' + prompt.length + ' chars\n'
      + '# Session: ' + (_sessionId || 'none') + '\n'
      + '#─────────────────────────────────────────\n\n';
    fs.writeFileSync(path.join(dir, fileName), header + prompt, 'utf-8');
  } catch (e) {
    // Don't let logging failures break the app
    console.error('[logger] Failed to write prompt file:', e.message);
  }
}

function _writeResponseFile(bugId, type, responseText, result) {
  try {
    var dir = _getPromptDir(bugId);
    var ts = readableTimestamp();
    var fileName = 'response_' + type + '_' + ts + '.txt';
    var bugTitle = _bugTitles[String(bugId)] || '';
    var header = '# ' + type.toUpperCase() + ' RESPONSE\n'
      + '# Bug ID: ' + bugId + '\n'
      + (bugTitle ? '# Bug Title: ' + bugTitle + '\n' : '')
      + '# Model: ' + (result.model || 'unknown') + '\n'
      + '# Usage: ' + JSON.stringify(result.usage || {}) + '\n'
      + '# Finish: ' + (result.finishReason || result.stopReason || '') + '\n'
      + '# Timestamp: ' + new Date().toISOString() + '\n'
      + '# Length: ' + (responseText || '').length + ' chars\n'
      + '# Session: ' + (_sessionId || 'none') + '\n'
      + '#─────────────────────────────────────────\n\n';
    fs.writeFileSync(path.join(dir, fileName), header + (responseText || ''), 'utf-8');
  } catch (e) {
    console.error('[logger] Failed to write response file:', e.message);
  }
}

// ── Log Query API ────────────────────────────────────────
// Read and filter logs for the frontend viewer.

/**
 * List available log files.
 * @returns {{ sessions: Array, dailyLogs: Array }}
 */
function listLogs() {
  ensureInit();
  var result = { sessions: [], dailyLogs: [], promptLogs: [] };

  // Sessions
  var sessDir = path.join(_logRoot, 'sessions');
  if (fs.existsSync(sessDir)) {
    result.sessions = fs.readdirSync(sessDir)
      .filter(function (f) { return f.endsWith('.jsonl'); })
      .map(function (f) {
        var stat = fs.statSync(path.join(sessDir, f));
        return {
          id: f.replace('.jsonl', ''),
          file: f,
          size: stat.size,
          modified: stat.mtime.toISOString()
        };
      })
      .sort(function (a, b) { return b.modified.localeCompare(a.modified); });
  }

  // Daily logs
  var dailyDir = path.join(_logRoot, 'daily');
  if (fs.existsSync(dailyDir)) {
    result.dailyLogs = fs.readdirSync(dailyDir)
      .filter(function (f) { return f.endsWith('.jsonl'); })
      .map(function (f) {
        var stat = fs.statSync(path.join(dailyDir, f));
        return {
          date: f.replace('.jsonl', ''),
          file: f,
          size: stat.size,
          modified: stat.mtime.toISOString()
        };
      })
      .sort(function (a, b) { return b.date.localeCompare(a.date); });
  }

  // Bug prompt / response files
  var bugsDir = path.join(_logRoot, 'bugs');
  if (fs.existsSync(bugsDir)) {
    result.promptLogs = fs.readdirSync(bugsDir)
      .filter(function (f) {
        try { return fs.statSync(path.join(bugsDir, f)).isDirectory(); }
        catch (e) { return false; }
      })
      .map(function (folderName) {
        var bugDir = path.join(bugsDir, folderName);
        var files = fs.readdirSync(bugDir);
        // Extract bugId from folder name ("<bugId>_<slug>" or just "<bugId>")
        var underscoreIdx = folderName.indexOf('_');
        var bugId = underscoreIdx > 0 ? folderName.substring(0, underscoreIdx) : folderName;
        var titleSlug = underscoreIdx > 0 ? folderName.substring(underscoreIdx + 1) : '';
        return {
          bugId: bugId,
          folder: folderName,
          title: _bugTitles[bugId] || titleSlug.replace(/-/g, ' ') || '',
          files: files.length,
          prompts: files.filter(function (f) { return f.indexOf('prompt_') === 0; }).length,
          responses: files.filter(function (f) { return f.indexOf('response_') === 0; }).length
        };
      })
      .sort(function (a, b) { return b.bugId.localeCompare(a.bugId); });
  }

  // Backward compat: also check old 'prompts/' dir
  var oldPromptDir = path.join(_logRoot, 'prompts');
  if (fs.existsSync(oldPromptDir)) {
    var existingBugIds = {};
    result.promptLogs.forEach(function (p) { existingBugIds[p.bugId] = true; });
    fs.readdirSync(oldPromptDir)
      .filter(function (f) {
        try { return fs.statSync(path.join(oldPromptDir, f)).isDirectory() && !existingBugIds[f]; }
        catch (e) { return false; }
      })
      .forEach(function (bugId) {
        var bugDir = path.join(oldPromptDir, bugId);
        var files = fs.readdirSync(bugDir);
        result.promptLogs.push({
          bugId: bugId,
          folder: bugId,
          title: _bugTitles[bugId] || '',
          files: files.length,
          prompts: files.filter(function (f) { return f.indexOf('_prompt_') !== -1 || f.indexOf('prompt_') === 0; }).length,
          responses: files.filter(function (f) { return f.indexOf('_response_') !== -1 || f.indexOf('response_') === 0; }).length
        });
      });
  }

  result.logRoot = _logRoot;
  result.currentSession = _sessionId;
  return result;
}

/**
 * Read log entries from a file with optional filters.
 *
 * @param {string} type   - 'session' or 'daily'
 * @param {string} id     - Session ID or date string (YYYY-MM-DD)
 * @param {object} [filters] - { level, category, bugId, search, limit, offset }
 * @returns {{ entries: Array, total: number, filtered: number }}
 */
function queryLogs(type, id, filters) {
  ensureInit();
  filters = filters || {};

  var filePath;
  if (type === 'session') {
    filePath = path.join(_logRoot, 'sessions', id + '.jsonl');
  } else {
    filePath = path.join(_logRoot, 'daily', id + '.jsonl');
  }

  if (!fs.existsSync(filePath)) {
    return { entries: [], total: 0, filtered: 0, error: 'Log file not found' };
  }

  var content = fs.readFileSync(filePath, 'utf-8');
  var lines = content.split('\n').filter(function (l) { return l.trim().length > 0; });
  var total = lines.length;

  // Parse all entries
  var entries = [];
  for (var i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch (e) { /* skip malformed lines */ }
  }

  // Apply filters
  if (filters.level) {
    var minLevel = LEVELS[filters.level.toUpperCase()] || 0;
    entries = entries.filter(function (e) {
      return (LEVELS[e.level] || 0) >= minLevel;
    });
  }
  if (filters.category) {
    var cat = filters.category.toUpperCase();
    entries = entries.filter(function (e) { return e.cat === cat; });
  }
  if (filters.bugId) {
    var bid = String(filters.bugId);
    entries = entries.filter(function (e) { return e.bugId === bid; });
  }
  if (filters.search) {
    var searchLower = filters.search.toLowerCase();
    entries = entries.filter(function (e) {
      return (e.msg || '').toLowerCase().indexOf(searchLower) !== -1 ||
        JSON.stringify(e.d || {}).toLowerCase().indexOf(searchLower) !== -1;
    });
  }

  var filtered = entries.length;

  // Pagination
  var offset = parseInt(filters.offset, 10) || 0;
  var limit = parseInt(filters.limit, 10) || 200;
  entries = entries.slice(offset, offset + limit);

  return { entries: entries, total: total, filtered: filtered, offset: offset, limit: limit };
}

/**
 * Read a full prompt/response file for a bug.
 * @param {string} bugId
 * @param {string} fileName
 * @returns {string|null}
 */
function readPromptFile(bugId, fileName) {
  ensureInit();
  var dir = _resolveBugDir(String(bugId));
  if (!dir) return null;
  var filePath = path.join(dir, fileName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * List all prompt/response files for a bug.
 */
function listPromptFiles(bugId) {
  ensureInit();
  var dir = _resolveBugDir(String(bugId));
  if (!dir) return [];
  return fs.readdirSync(dir).map(function (f) {
    var stat = fs.statSync(path.join(dir, f));
    // Parse timestamp from new format "prompt_analyze_2026-02-26_13-30-01.txt"
    // or old format "analyze_prompt_1772093001725.txt"
    var tsMatch = f.match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})/);
    var ts;
    if (tsMatch) {
      // New readable format
      ts = tsMatch[1].replace(/_/, 'T').replace(/-/g, function (m, offset) {
        return offset > 9 ? ':' : m;  // Only replace dashes in time part
      });
      // Actually just format it nicely
      ts = tsMatch[1];  // Keep as-is for display
    } else {
      // Old epoch format
      var epochMatch = f.match(/_(\d{13,})\./);
      ts = epochMatch ? new Date(parseInt(epochMatch[1], 10)).toISOString() : stat.mtime.toISOString();
    }

    // Determine type and label
    var isPrompt = f.indexOf('prompt_') === 0 || f.indexOf('_prompt_') !== -1;
    var isResponse = f.indexOf('response_') === 0 || f.indexOf('_response_') !== -1;
    var type = isPrompt ? 'prompt' : (isResponse ? 'response' : 'other');

    // Generate human-readable label
    var label = f.replace(/\.txt$/, '');
    if (isPrompt) label = '📤 ' + label.replace(/^prompt_/, '').replace(/_\d{4}.*/, '');
    if (isResponse) label = '📥 ' + label.replace(/^response_/, '').replace(/_\d{4}.*/, '');

    return {
      name: f,
      label: label,
      type: type,
      size: stat.size,
      timestamp: ts
    };
  }).sort(function (a, b) { return a.name.localeCompare(b.name); });
}

// ── Configuration ────────────────────────────────────────

/**
 * Set minimum log level.  'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL'
 */
function setLevel(level) {
  if (LEVELS[level] !== undefined) _minLevel = LEVELS[level];
}

/**
 * Enable/disable console output (still logs to files).
 */
function setConsoleOutput(enabled) {
  _consoleOutput = !!enabled;
}

/**
 * Get current session ID.
 */
function getSessionId() {
  return _sessionId;
}

/**
 * Get log root path.
 */
function getLogRoot() {
  var home = os.homedir();
  var docs = path.join(home, 'Documents');
  if (!fs.existsSync(docs)) docs = home;
  return path.join(docs, '.zoho-bug-track-logs');
}

/**
 * Get session stats.
 */
function getSessionStats() {
  return _sessionStats || {};
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  // Core
  log: log,
  debug: debug,
  info: info,
  warn: warn,
  error: error,
  fatal: fatal,

  // Session
  startSession: startSession,
  endSession: endSession,
  getSessionId: getSessionId,
  getSessionStats: getSessionStats,

  // Pipeline helpers
  analyzeStart: analyzeStart,
  bugFetched: bugFetched,
  routeDetected: routeDetected,
  codeScanComplete: codeScanComplete,
  aiPromptSent: aiPromptSent,
  aiResponseReceived: aiResponseReceived,
  aiError: aiError,
  interactionPromptSent: interactionPromptSent,
  reproAttempt: reproAttempt,
  patchOperation: patchOperation,
  apiRequest: apiRequest,
  authEvent: authEvent,

  // Query
  listLogs: listLogs,
  queryLogs: queryLogs,
  readPromptFile: readPromptFile,
  listPromptFiles: listPromptFiles,
  registerBug: registerBug,

  // Config
  setLevel: setLevel,
  setConsoleOutput: setConsoleOutput,
  getLogRoot: getLogRoot,

  // Constants
  LEVELS: LEVELS,
  LEVEL_NAMES: LEVEL_NAMES,
  CATEGORIES: CATEGORIES
};
