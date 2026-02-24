'use strict';
/**
 * user-store.js — Per-user config & session persistence.
 *
 * Each logged-in Zoho user gets a JSON file in data/users/<sanitized-id>.json.
 * Sessions are stored in data/sessions.json.
 * Node 8 compatible. Zero dependencies.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var DATA_DIR = path.join(__dirname, '..', 'data');
var USERS_DIR = path.join(DATA_DIR, 'users');
var SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

// ── helpers ──────────────────────────────────────────────

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  } catch (e) {
    // On Node 8, mkdirSync doesn't have {recursive:true}, create parents manually
    var parts = dir.split(path.sep);
    var cur = '';
    for (var i = 0; i < parts.length; i++) {
      cur = cur ? path.join(cur, parts[i]) : parts[i];
      if (cur && !fs.existsSync(cur)) {
        try { fs.mkdirSync(cur); } catch (e2) { /* ignore */ }
      }
    }
  }
}

function readJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return null;
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function sanitizeId(userId) {
  return String(userId).replace(/[^a-zA-Z0-9._@-]/g, '_');
}

// ── sessions ─────────────────────────────────────────────

function loadSessions() {
  return readJSON(SESSIONS_FILE) || {};
}

function saveSessions(sessions) {
  ensureDir(DATA_DIR);
  writeJSON(SESSIONS_FILE, sessions);
}

/**
 * Create a session for a user.  Returns the session token.
 */
function createSession(userId, userInfo) {
  var token = crypto.randomBytes(32).toString('hex');
  var sessions = loadSessions();

  // Purge sessions older than 7 days
  var now = Date.now();
  var SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  Object.keys(sessions).forEach(function (t) {
    if (now - (sessions[t].created || 0) > SEVEN_DAYS) delete sessions[t];
  });

  sessions[token] = {
    userId: userId,
    email: (userInfo && userInfo.email) || '',
    name: (userInfo && userInfo.name) || '',
    created: now
  };
  saveSessions(sessions);
  return token;
}

/**
 * Validate a token.  Returns { userId, email, name } or null.
 */
function validateSession(token) {
  if (!token) return null;
  var sessions = loadSessions();
  var s = sessions[token];
  if (!s) return null;
  var SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - (s.created || 0) > SEVEN_DAYS) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  return { userId: s.userId, email: s.email, name: s.name };
}

function destroySession(token) {
  var sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
}

// ── per-user config ──────────────────────────────────────

function userFilePath(userId) {
  ensureDir(USERS_DIR);
  return path.join(USERS_DIR, sanitizeId(userId) + '.json');
}

/**
 * Default config for a brand-new user.
 */
function defaultConfig(userId) {
  return {
    userId: userId,
    name: '',
    email: '',
    projectDir: '',                        // ← the user sets this (local mode)
    agentUrl: '',                          // ← remote agent URL (shared mode)
    zohoTokens: {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0
    },
    githubToken: '',
    claudeApiKey: '',
    aiModel: 'openai/gpt-4.1',
    defaultAssignee: '',
    zohoZuid: '',
    zohoPortal: 'logmanagementcloud',
    zohoProjectId: '334688000000017255',
    fileExtensions: ['.js', '.hbs', '.css', '.java', '.json', '.xml'],
    excludeDirs: ['node_modules', '.git', 'bower_components', 'dist', 'tmp', 'vendor', 'third-party'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Find an existing user JSON that matches by name or ZUID.
 * Used to inherit settings when a new fallback user ID is generated.
 * Skips the given userId (the current new user).
 */
function findExistingUser(skipUserId, matchName) {
  ensureDir(USERS_DIR);
  try {
    var files = fs.readdirSync(USERS_DIR);
    var bestMatch = null;
    var bestTime = 0;
    for (var i = 0; i < files.length; i++) {
      if (files[i].indexOf('.json') === -1) continue;
      var data = readJSON(path.join(USERS_DIR, files[i]));
      if (!data || data.userId === skipUserId) continue;
      // Must have settings configured (projectDir or agentUrl)
      if (!data.projectDir && !data.agentUrl) continue;
      // Match by name or defaultAssignee
      var nameMatch = matchName && matchName !== 'Zoho User' &&
        (data.name === matchName || data.defaultAssignee === matchName);
      if (nameMatch) {
        // Prefer the most recently updated one
        var updatedAt = data.updatedAt ? new Date(data.updatedAt).getTime() : 0;
        if (updatedAt > bestTime) {
          bestMatch = data;
          bestTime = updatedAt;
        }
      }
    }
    return bestMatch;
  } catch (e) {
    return null;
  }
}

function getUser(userId) {
  var data = readJSON(userFilePath(userId));
  return data || defaultConfig(userId);
}

function saveUser(userId, partial) {
  var existing = getUser(userId);
  Object.keys(partial).forEach(function (key) {
    if (key === 'zohoTokens' && typeof partial[key] === 'object') {
      existing.zohoTokens = existing.zohoTokens || {};
      Object.keys(partial.zohoTokens).forEach(function (tk) {
        existing.zohoTokens[tk] = partial.zohoTokens[tk];
      });
    } else {
      existing[key] = partial[key];
    }
  });
  existing.updatedAt = new Date().toISOString();
  writeJSON(userFilePath(userId), existing);
  return existing;
}

/**
 * Return user config without sensitive tokens (for API responses).
 */
function getUserPublic(userId) {
  var u = getUser(userId);
  return {
    userId: u.userId,
    name: u.name,
    email: u.email,
    projectDir: u.projectDir,
    agentUrl: u.agentUrl || '',
    defaultAssignee: u.defaultAssignee || '',
    zohoZuid: u.zohoZuid || '',
    zohoPortal: u.zohoPortal,
    zohoProjectId: u.zohoProjectId,
    fileExtensions: u.fileExtensions,
    excludeDirs: u.excludeDirs,
    hasGithubToken: Boolean(u.githubToken),
    hasClaudeKey: Boolean(u.claudeApiKey),
    aiModel: u.aiModel || 'claude-opus-4-6',
    devServerUrl: u.devServerUrl || '',
    testUsername: u.testUsername || '',
    hasTestPassword: Boolean(u.testPassword),
    hasTokens: Boolean(u.zohoTokens && u.zohoTokens.refreshToken),
    configured: Boolean(u.projectDir || u.agentUrl),
    createdAt: u.createdAt,
    updatedAt: u.updatedAt
  };
}

module.exports = {
  createSession: createSession,
  validateSession: validateSession,
  destroySession: destroySession,
  getUser: getUser,
  findExistingUser: findExistingUser,
  saveUser: saveUser,
  getUserPublic: getUserPublic
};
