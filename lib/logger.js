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
  var ts = now.getFullYear().toString() +
    pad2(now.getMonth() + 1) +
    pad2(now.getDate()) + '_' +
    pad2(now.getHours()) +
    pad2(now.getMinutes()) +
    pad2(now.getSeconds());
  var rand = Math.random().toString(36).substring(2, 6);
  return ts + '_' + rand;
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
  var dir = path.join(_logRoot, 'prompts', String(bugId));
  mkdirpSync(dir);
  return dir;
}

function _writePromptFile(bugId, type, prompt, opts) {
  try {
    var dir = _getPromptDir(bugId);
    var ts = Date.now();
    var fileName = type + '_prompt_' + ts + '.txt';
    var header = '# ' + type.toUpperCase() + ' PROMPT\n'
      + '# Bug ID: ' + bugId + '\n'
      + '# Model: ' + ((opts || {}).model || 'unknown') + '\n'
      + '# Provider: ' + ((opts || {}).provider || 'unknown') + '\n'
      + '# Timestamp: ' + new Date(ts).toISOString() + '\n'
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
    var ts = Date.now();
    var fileName = type + '_response_' + ts + '.txt';
    var header = '# ' + type.toUpperCase() + ' RESPONSE\n'
      + '# Bug ID: ' + bugId + '\n'
      + '# Model: ' + (result.model || 'unknown') + '\n'
      + '# Usage: ' + JSON.stringify(result.usage || {}) + '\n'
      + '# Finish: ' + (result.finishReason || result.stopReason || '') + '\n'
      + '# Timestamp: ' + new Date(ts).toISOString() + '\n'
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

  // Prompt logs
  var promptDir = path.join(_logRoot, 'prompts');
  if (fs.existsSync(promptDir)) {
    result.promptLogs = fs.readdirSync(promptDir)
      .filter(function (f) {
        try { return fs.statSync(path.join(promptDir, f)).isDirectory(); }
        catch (e) { return false; }
      })
      .map(function (bugId) {
        var bugDir = path.join(promptDir, bugId);
        var files = fs.readdirSync(bugDir);
        return {
          bugId: bugId,
          files: files.length,
          prompts: files.filter(function (f) { return f.indexOf('_prompt_') !== -1; }).length,
          responses: files.filter(function (f) { return f.indexOf('_response_') !== -1; }).length
        };
      })
      .sort(function (a, b) { return b.bugId.localeCompare(a.bugId); });
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
  var filePath = path.join(_logRoot, 'prompts', String(bugId), fileName);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * List all prompt/response files for a bug.
 */
function listPromptFiles(bugId) {
  ensureInit();
  var dir = path.join(_logRoot, 'prompts', String(bugId));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(function (f) {
    var stat = fs.statSync(path.join(dir, f));
    var tsMatch = f.match(/_(\d+)\.\w+$/);
    return {
      file: f,
      size: stat.size,
      timestamp: tsMatch ? new Date(parseInt(tsMatch[1], 10)).toISOString() : stat.mtime.toISOString(),
      type: f.indexOf('_prompt_') !== -1 ? 'prompt' : 'response'
    };
  }).sort(function (a, b) { return a.timestamp.localeCompare(b.timestamp); });
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

  // Config
  setLevel: setLevel,
  setConsoleOutput: setConsoleOutput,
  getLogRoot: getLogRoot,

  // Constants
  LEVELS: LEVELS,
  LEVEL_NAMES: LEVEL_NAMES,
  CATEGORIES: CATEGORIES
};
