'use strict';
/**
 * server.js — Zero-dependency HTTP server for Zoho Bug Tracker.
 *
 * Endpoints:
 *   GET  /                     → SPA (public/index.html)
 *   GET  /auth/login           → redirect to Zoho OAuth
 *   GET  /auth/callback        → handle OAuth callback, create session
 *   POST /auth/logout          → destroy session
 *
 *   GET  /api/me               → current user public config
 *   POST /api/settings         → update user config (projectDir etc.)
 *   GET  /api/project-stats    → stats about configured project dir
 *
 *   GET  /api/bugs             → list bugs (with query filters)
 *   GET  /api/bugs/:id         → bug details + attachments + comments
 *   GET  /api/bugs/:id/analyze → full analysis + fix prompt
 *   GET  /api/milestones       → list milestones (for filter dropdown)
 *
 *   GET  /api/search           → search files in user's project
 *   GET  /api/grep             → grep code in user's project
 *   GET  /api/read-file        → read a file from user's project
 *
 * Node 8 compatible. Zero dependencies.
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var urlModule = require('url');

var envConfig = require('./lib/env-config');
var userStore = require('./lib/user-store');
var zohoAuth = require('./lib/zoho-auth');
var zohoClient = require('./lib/zoho-client');
var bugService = require('./lib/bug-service');
var codeAnalyzer = require('./lib/code-analyzer');
var fixPrompt = require('./lib/fix-prompt');
var agentProxy = require('./lib/agent-proxy');
var patchUtils = require('./lib/patch-utils');
var logger = require('./lib/logger');

var PORT = envConfig.PORT;
var PUBLIC_DIR = path.join(__dirname, 'public');

// ── In-memory analysis cache (bugId → analysis state) ────
// Stores the result of /analyze so /fix can pick it up with user instructions.
// Entries expire after 30 minutes.
var _analysisCache = {};
var ANALYSIS_CACHE_TTL = 30 * 60 * 1000; // 30 min

function cacheAnalysis(bugId, userId, data) {
  _analysisCache[bugId + ':' + userId] = {
    data: data,
    createdAt: Date.now()
  };
  // Prune old entries
  var keys = Object.keys(_analysisCache);
  for (var i = 0; i < keys.length; i++) {
    if (Date.now() - _analysisCache[keys[i]].createdAt > ANALYSIS_CACHE_TTL) {
      delete _analysisCache[keys[i]];
    }
  }
}

function getCachedAnalysis(bugId, userId) {
  var entry = _analysisCache[bugId + ':' + userId];
  if (!entry) return null;
  if (Date.now() - entry.createdAt > ANALYSIS_CACHE_TTL) {
    delete _analysisCache[bugId + ':' + userId];
    return null;
  }
  return entry.data;
}

/**
 * Validate and fix step selectors against known data-auto-ids.
 * Strips invented data-auto-id selectors and falls back to CSS/text alternatives.
 */
function validateStepSelectors(steps, knownIds) {
  if (!steps || !knownIds || knownIds.length === 0) return steps;
  var idSet = {};
  for (var ki = 0; ki < knownIds.length; ki++) {
    idSet[knownIds[ki]] = true;
  }
  var autoIdRegex = /\[data-auto-id=["']([^"']+)["']\]/;
  for (var si = 0; si < steps.length; si++) {
    var step = steps[si];
    if (!step || !step.selector) continue;

    // Check primary selector
    var primaryMatch = step.selector.match(autoIdRegex);
    if (primaryMatch && !idSet[primaryMatch[1]]) {
      console.log('[Repro] ⚠️ Step ' + (si + 1) + ': INVENTED data-auto-id "' + primaryMatch[1] + '" — replacing with fallback');
      // Move to fallback
      if (step.fallbackSelectors && step.fallbackSelectors.length > 0) {
        // Find first fallback that isn't an invented data-auto-id
        var replaced = false;
        for (var fi = 0; fi < step.fallbackSelectors.length; fi++) {
          var fbMatch = step.fallbackSelectors[fi].match(autoIdRegex);
          if (!fbMatch || idSet[fbMatch[1]]) {
            step.selector = step.fallbackSelectors[fi];
            step.fallbackSelectors.splice(fi, 1);
            replaced = true;
            console.log('[Repro]   → Replaced with: ' + step.selector);
            break;
          }
        }
        if (!replaced) {
          step.selector = step.fallbackSelectors[0];
          step.fallbackSelectors.splice(0, 1);
          console.log('[Repro]   → Replaced with first fallback: ' + step.selector);
        }
      }
    }

    // Also clean invented data-auto-ids from fallbackSelectors
    if (step.fallbackSelectors) {
      step.fallbackSelectors = step.fallbackSelectors.filter(function (fb) {
        var fbm = fb.match(autoIdRegex);
        if (fbm && !idSet[fbm[1]]) {
          console.log('[Repro]   Removing invented fallback: ' + fb);
          return false;
        }
        return true;
      });
    }
  }
  return steps;
}

// ── helpers ──────────────────────────────────────────────

var MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJSON(res, statusCode, data) {
  var body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function send401(res) {
  sendJSON(res, 401, { error: 'Not authenticated. Please login.' });
}

function send400(res, msg) {
  sendJSON(res, 400, { error: msg || 'Bad request' });
}

function send500(res, msg) {
  sendJSON(res, 500, { error: msg || 'Internal server error' });
}

function serveStatic(res, filePath) {
  var ext = path.extname(filePath).toLowerCase();
  var mime = MIME_TYPES[ext] || 'application/octet-stream';
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function readBody(req, callback) {
  var body = '';
  req.on('data', function (chunk) { body += chunk; });
  req.on('end', function () {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (e) {
      callback(new Error('Invalid JSON body'));
    }
  });
}

/**
 * Extract session token from Cookie header.
 */
function getSessionToken(req) {
  var cookie = req.headers.cookie || '';
  var match = cookie.match(/session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Authenticate request. Returns user info or null.
 */
function authenticate(req) {
  var token = getSessionToken(req);
  return userStore.validateSession(token);
}

function setCookie(res, name, value, maxAge) {
  var cookie = name + '=' + value + '; Path=/; HttpOnly; SameSite=Lax';
  if (maxAge) cookie += '; Max-Age=' + maxAge;
  // Get existing Set-Cookie headers if any
  var existing = res.getHeader('Set-Cookie') || [];
  if (typeof existing === 'string') existing = [existing];
  existing.push(cookie);
  res.setHeader('Set-Cookie', existing);
}

// ── route handler ────────────────────────────────────────

function handleRequest(req, res) {
  var parsed = urlModule.parse(req.url, true);
  var pathname = parsed.pathname;
  var query = parsed.query;
  var method = req.method;

  // ── Auth routes ──

  if (pathname === '/auth/login' && method === 'GET') {
    var authUrl = zohoAuth.getAuthUrl();
    res.writeHead(302, { 'Location': authUrl });
    res.end();
    return;
  }

  if (pathname === '/oauth/callback' && method === 'GET') {
    var code = query.code;
    var error = query.error;

    if (error) {
      res.writeHead(302, { 'Location': '/?error=' + encodeURIComponent(error) });
      res.end();
      return;
    }
    if (!code) {
      res.writeHead(302, { 'Location': '/?error=missing_code' });
      res.end();
      return;
    }

    // Exchange code for tokens
    console.log('OAuth callback received, exchanging code...');
    logger.info('AUTH', 'OAuth callback received, exchanging code');
    zohoAuth.exchangeCode(code, function (err, tokenData) {
      if (err) {
        console.error('TOKEN EXCHANGE FAILED:', err.message);
        logger.error('AUTH', 'Token exchange failed', { error: err.message });
        res.writeHead(302, { 'Location': '/?error=' + encodeURIComponent(err.message) });
        res.end();
        return;
      }
      console.log('Token exchange successful, got access_token and refresh_token:', Boolean(tokenData.refresh_token));

      var accessToken = tokenData.access_token;
      var refreshToken = tokenData.refresh_token;
      var expiresIn = (tokenData.expires_in || 3600) * 1000;

      // Fetch user identity — use portal users API, fallback to token hash
      zohoAuth.fetchUserProfile(accessToken, function (profErr, profileData) {
        var userId, userName, userEmail;

        if (!profErr && profileData && profileData.users && profileData.users.length > 0) {
          // Got users list from portal — use first user as identity
          // (In most cases, the token owner is part of the portal users)
          var firstUser = profileData.users[0];
          userId = firstUser.zuid || firstUser.email || ('user_' + Date.now());
          userName = firstUser.name || '';
          userEmail = firstUser.email || '';
          console.log('Logged in as:', userName, '(' + userEmail + ') ID:', userId);
          logger.authEvent('login', userId, { name: userName, email: userEmail });
        } else {
          // Fallback: generate a stable ID from the refresh token (which stays constant for a given OAuth grant)
          console.log('Profile fetch failed, using fallback ID. Error:', profErr ? profErr.message : 'no data');
          var crypto = require('crypto');
          userId = 'user_' + crypto.createHash('md5').update(refreshToken || accessToken).digest('hex').substring(0, 12);
          userName = 'Zoho User';
          userEmail = '';
        }

        // Save user tokens
        var existingUser = userStore.getUser(userId);
        var saveData = {
          userId: userId,
          name: userName,
          email: userEmail,
          zohoTokens: {
            accessToken: accessToken,
            refreshToken: refreshToken,
            expiresAt: Date.now() + expiresIn - 60000
          }
        };
        // Auto-set defaultAssignee from login name if not already configured
        if (!existingUser.defaultAssignee && userName && userName !== 'Zoho User') {
          saveData.defaultAssignee = userName;
          console.log('Auto-set defaultAssignee to:', userName);
        }
        userStore.saveUser(userId, saveData);

        // ── Try to restore settings from the local agent ──
        // The agent persists settings across token refreshes and userId changes.
        // This is the primary restoration method — more reliable than findExistingUser.
        function restoreFromAgentThenContinue() {
          // Try known agent URLs: existing user's agentUrl, or default localhost:4000
          var freshUser0 = userStore.getUser(userId);
          var agentUrlsToTry = [];
          if (freshUser0.agentUrl) agentUrlsToTry.push(freshUser0.agentUrl);
          agentUrlsToTry.push('http://localhost:4000');
          // Deduplicate
          var unique = [];
          var seen = {};
          agentUrlsToTry.forEach(function (u) { if (!seen[u]) { seen[u] = true; unique.push(u); } });

          function tryNextAgent(idx) {
            if (idx >= unique.length) {
              // No agent responded — fall back to findExistingUser
              return fallbackInheritThenFinish();
            }
            var tryUrl = unique[idx];
            console.log('[login] Trying to restore settings from agent:', tryUrl);
            agentProxy.loadSettings(tryUrl).then(function (agentData) {
              if (agentData && agentData.settings && Object.keys(agentData.settings).length > 0) {
                var s = agentData.settings;
                console.log('[login] ✅ Settings restored from agent! Fields:', Object.keys(s).length);
                var restore = {};
                // Restore all settings except zohoTokens (we have fresh tokens from OAuth)
                if (s.agentUrl) restore.agentUrl = s.agentUrl;
                if (s.zohoPortal) restore.zohoPortal = s.zohoPortal;
                if (s.zohoProjectId) restore.zohoProjectId = s.zohoProjectId;
                if (s.defaultAssignee) restore.defaultAssignee = s.defaultAssignee;
                if (s.zohoZuid) restore.zohoZuid = s.zohoZuid;
                if (s.githubToken) restore.githubToken = s.githubToken;
                if (s.claudeApiKey) restore.claudeApiKey = s.claudeApiKey;
                if (s.aiModel) restore.aiModel = s.aiModel;
                if (s.fileExtensions) restore.fileExtensions = s.fileExtensions;
                if (s.excludeDirs) restore.excludeDirs = s.excludeDirs;
                if (s.devServerUrl) restore.devServerUrl = s.devServerUrl;
                if (s.testUsername) restore.testUsername = s.testUsername;
                if (s.testPassword) restore.testPassword = s.testPassword;
                if (s.name && !userName || userName === 'Zoho User') restore.name = s.name;
                if (s.email && !userEmail) restore.email = s.email;

                if (Object.keys(restore).length > 0) {
                  userStore.saveUser(userId, restore);
                  console.log('[login] Restored:', Object.keys(restore).join(', '));
                }

                // Also update the agent with fresh tokens so it stays in sync
                agentProxy.saveSettings(tryUrl, {
                  zohoTokens: {
                    accessToken: accessToken,
                    refreshToken: refreshToken,
                    expiresAt: Date.now() + expiresIn - 60000
                  },
                  name: userName || s.name || '',
                  email: userEmail || s.email || ''
                }).catch(function (e) { /* ignore */ });

                return finishLogin();
              }
              // Agent had no settings — try next
              tryNextAgent(idx + 1);
            }).catch(function (err) {
              console.log('[login] Agent', tryUrl, 'not available:', err.message);
              tryNextAgent(idx + 1);
            });
          }

          tryNextAgent(0);
        }

        // Fallback: inherit from a previous user file (old method)
        function fallbackInheritThenFinish() {
          var freshUser = userStore.getUser(userId);
          if (!freshUser.projectDir && !freshUser.agentUrl) {
            var donor = userStore.findExistingUser(userId, userName);
            if (donor) {
              console.log('Inheriting settings from previous user:', donor.userId, '->', userId);
              var inherit = {};
              if (donor.projectDir) inherit.projectDir = donor.projectDir;
              if (donor.agentUrl) inherit.agentUrl = donor.agentUrl;
              if (donor.zohoPortal) inherit.zohoPortal = donor.zohoPortal;
              if (donor.zohoProjectId) inherit.zohoProjectId = donor.zohoProjectId;
              if (donor.defaultAssignee) inherit.defaultAssignee = donor.defaultAssignee;
              if (donor.githubToken) inherit.githubToken = donor.githubToken;
              if (donor.claudeApiKey) inherit.claudeApiKey = donor.claudeApiKey;
              if (donor.aiModel) inherit.aiModel = donor.aiModel;
              if (donor.fileExtensions) inherit.fileExtensions = donor.fileExtensions;
              if (donor.excludeDirs) inherit.excludeDirs = donor.excludeDirs;
              if (donor.zohoZuid) inherit.zohoZuid = donor.zohoZuid;
              if (Object.keys(inherit).length > 0) {
                userStore.saveUser(userId, inherit);
              }
            }
          }
          finishLogin();
        }

        function finishLogin() {

        // Create session
        var sessionToken = userStore.createSession(userId, { name: userName, email: userEmail });
        console.log('Session created for', userId, '- token:', sessionToken.substring(0, 8) + '...');

        // Set cookie and redirect to home page
        var cookieVal = 'session=' + sessionToken + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (7 * 24 * 60 * 60);
        res.writeHead(302, {
          'Location': '/',
          'Set-Cookie': cookieVal,
          'Cache-Control': 'no-store'
        });
        res.end();

        // ── Background: auto-detect user identity from /mybugs/ ──
        // /mybugs/ returns bugs assigned to the token owner.
        // The first bug's assignee_name gives us the real user name.
        // This works even when profile API fails.
        (function () {
          var updatedUser = userStore.getUser(userId);
          if (updatedUser.defaultAssignee && updatedUser.defaultAssignee !== 'Zoho User') {
            console.log('User already has defaultAssignee:', updatedUser.defaultAssignee);
            return; // already configured
          }
          var portal = updatedUser.zohoPortal || 'logmanagementcloud';
          var myBugsUrl = 'https://projectsapi.zoho.in/restapi/portal/' + portal +
            '/mybugs/?index=0&range=5';
          zohoClient.zohoGet(userId, myBugsUrl, function (mbErr, mbData) {
            if (mbErr) {
              console.log('Background /mybugs/ identity detect failed:', mbErr.message);
              return;
            }
            var myBugs = (mbData && mbData.bugs) || [];
            if (myBugs.length === 0) return;
            // Find the most common assignee_name — that's the login user
            var counts = {};
            myBugs.forEach(function (b) {
              if (b.assignee_name) {
                counts[b.assignee_name] = (counts[b.assignee_name] || 0) + 1;
              }
            });
            var bestName = '';
            var bestCount = 0;
            Object.keys(counts).forEach(function (n) {
              if (counts[n] > bestCount) {
                bestCount = counts[n];
                bestName = n;
              }
            });
            if (bestName) {
              console.log('Auto-detected login user from /mybugs/:', bestName);
              var detectUpdates = { defaultAssignee: bestName, name: bestName };
              // Also try to grab ZUID from the bug data
              for (var i = 0; i < myBugs.length; i++) {
                if (myBugs[i].assignee_name === bestName && myBugs[i].assignee_id) {
                  detectUpdates.zohoZuid = String(myBugs[i].assignee_id);
                  console.log('Auto-detected ZUID from /mybugs/:', detectUpdates.zohoZuid);
                  break;
                }
              }
              userStore.saveUser(userId, detectUpdates);

              // Sync updated identity to agent
              var currentForSync = userStore.getUser(userId);
              if (currentForSync.agentUrl) {
                agentProxy.saveSettings(currentForSync.agentUrl, {
                  defaultAssignee: bestName,
                  name: bestName,
                  zohoZuid: detectUpdates.zohoZuid || ''
                }).catch(function (e) { /* ignore */ });
              }

              // Now that we know the real name, inherit settings if still unconfigured
              var currentUser = userStore.getUser(userId);
              if (!currentUser.projectDir && !currentUser.agentUrl) {
                var donor2 = userStore.findExistingUser(userId, bestName);
                if (donor2) {
                  console.log('Background: inheriting settings from', donor2.userId);
                  var inherit2 = {};
                  ['projectDir', 'agentUrl', 'zohoPortal', 'zohoProjectId', 'githubToken',
                   'claudeApiKey', 'aiModel', 'fileExtensions', 'excludeDirs'].forEach(function (k) {
                    if (donor2[k]) inherit2[k] = donor2[k];
                  });
                  if (Object.keys(inherit2).length > 0) {
                    userStore.saveUser(userId, inherit2);
                  }
                }
              }
            }
          });
        })();

        } // end finishLogin

        // Kick off the restore chain: agent → findExistingUser → finishLogin
        restoreFromAgentThenContinue();

      });
    });
    return;
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    var token = getSessionToken(req);
    if (token) userStore.destroySession(token);
    setCookie(res, 'session', '', 0);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // ── API routes (require auth) ──

  if (pathname.indexOf('/api/') === 0) {
    var session = authenticate(req);
    if (!session) {
      console.log('AUTH FAILED for', pathname, '- cookie header:', (req.headers.cookie || '(none)').substring(0, 40));
      return send401(res);
    }

    var userId = session.userId;

    // GET /api/me
    if (pathname === '/api/me' && method === 'GET') {
      sendJSON(res, 200, userStore.getUserPublic(userId));
      return;
    }

    // POST /api/settings
    if (pathname === '/api/settings' && method === 'POST') {
      readBody(req, function (err, body) {
        if (err) return send400(res, err.message);

        var allowed = {};
        if (body.projectDir !== undefined) allowed.projectDir = String(body.projectDir).trim();
        if (body.agentUrl !== undefined) allowed.agentUrl = String(body.agentUrl).trim().replace(/\/$/, '');
        if (body.zohoPortal !== undefined) allowed.zohoPortal = String(body.zohoPortal).trim();
        if (body.zohoProjectId !== undefined) allowed.zohoProjectId = String(body.zohoProjectId).trim();
        if (body.defaultAssignee !== undefined) allowed.defaultAssignee = String(body.defaultAssignee).trim();
        if (body.fileExtensions !== undefined) allowed.fileExtensions = body.fileExtensions;
        if (body.excludeDirs !== undefined) allowed.excludeDirs = body.excludeDirs;
        if (body.githubToken !== undefined) allowed.githubToken = String(body.githubToken).trim();
        if (body.claudeApiKey !== undefined) allowed.claudeApiKey = String(body.claudeApiKey).trim();
        if (body.aiModel !== undefined) allowed.aiModel = String(body.aiModel).trim();
        if (body.devServerUrl !== undefined) allowed.devServerUrl = String(body.devServerUrl).trim();
        if (body.testUsername !== undefined) allowed.testUsername = String(body.testUsername).trim();
        if (body.testPassword !== undefined) allowed.testPassword = String(body.testPassword).trim();

        // Validate: either agentUrl or projectDir (local) must work
        if (allowed.agentUrl) {
          // Validate agent URL format
          if (!/^https?:\/\/.+/.test(allowed.agentUrl)) {
            return send400(res, 'Invalid Agent URL format. Use http://host:port');
          }
          // Clear projectDir — agent mode
          allowed.projectDir = '';
        } else if (allowed.projectDir && !fs.existsSync(allowed.projectDir)) {
          return send400(res, 'Directory does not exist: ' + allowed.projectDir);
        }

        var updated = userStore.saveUser(userId, allowed);

        // ── Sync settings to agent for persistent local storage ──
        // This ensures settings survive across token refreshes and re-logins
        var savedUser = userStore.getUser(userId);
        if (savedUser.agentUrl) {
          var settingsToSync = {
            agentUrl: savedUser.agentUrl,
            zohoPortal: savedUser.zohoPortal,
            zohoProjectId: savedUser.zohoProjectId,
            defaultAssignee: savedUser.defaultAssignee,
            zohoZuid: savedUser.zohoZuid || '',
            githubToken: savedUser.githubToken,
            claudeApiKey: savedUser.claudeApiKey,
            aiModel: savedUser.aiModel,
            fileExtensions: savedUser.fileExtensions,
            excludeDirs: savedUser.excludeDirs,
            devServerUrl: savedUser.devServerUrl || '',
            testUsername: savedUser.testUsername || '',
            testPassword: savedUser.testPassword || '',
            name: savedUser.name || '',
            email: savedUser.email || '',
            zohoTokens: savedUser.zohoTokens || {}
          };
          agentProxy.saveSettings(savedUser.agentUrl, settingsToSync).then(function () {
            console.log('[settings] ✅ Settings synced to agent at', savedUser.agentUrl);
          }).catch(function (syncErr) {
            console.log('[settings] ⚠️ Failed to sync settings to agent:', syncErr.message);
          });
        }

        sendJSON(res, 200, userStore.getUserPublic(userId));
      });
      return;
    }

    // GET /api/ai-models — return available AI models for the settings dropdown
    if (pathname === '/api/ai-models' && method === 'GET') {
      var githubAIModels = require('./lib/github-ai-client');
      sendJSON(res, 200, { models: githubAIModels.AVAILABLE_MODELS, defaultModel: githubAIModels.DEFAULT_MODEL });
      return;
    }

    // GET /api/discover-models — discover models available for the user's GitHub token
    if (pathname === '/api/discover-models' && method === 'GET') {
      var discUser = userStore.getUser(userId);
      var discClient = require('./lib/github-ai-client');
      if (!discUser.githubToken) {
        return sendJSON(res, 200, { discovered: false, models: discClient.AVAILABLE_MODELS, message: 'Save your GitHub Token first, then discover models.' });
      }
      discClient.discoverModels(discUser.githubToken, function (discErr, discResult) {
        if (discErr) return send500(res, discErr.message);
        sendJSON(res, 200, discResult);
      });
      return;
    }

    // GET /api/copilot-bridge-status — check if Copilot Bridge VS Code extension is running
    if (pathname === '/api/copilot-bridge-status' && method === 'GET') {
      var bridgeClient = require('./lib/copilot-bridge-client');
      bridgeClient.checkHealth(function (bridgeErr, bridgeData) {
        if (bridgeErr) {
          return sendJSON(res, 200, { ok: false, error: bridgeErr.message });
        }
        sendJSON(res, 200, bridgeData);
      });
      return;
    }

    // GET /api/check-agent — proxy health check to avoid CORS issues
    if (pathname === '/api/check-agent' && method === 'GET') {
      var agentUrl = query.url || '';
      if (!agentUrl) return send400(res, 'Missing ?url=');
      agentProxy.checkHealth(agentUrl).then(function (data) {
        sendJSON(res, 200, data);
      }).catch(function (err) {
        sendJSON(res, 502, { error: err.message });
      });
      return;
    }

    // GET /api/project-stats
    if (pathname === '/api/project-stats' && method === 'GET') {
      var user = userStore.getUser(userId);
      if (user.agentUrl) {
        agentProxy.getStats(user.agentUrl).then(function (stats) {
          sendJSON(res, 200, stats);
        }).catch(function (err) {
          send500(res, 'Agent error: ' + err.message);
        });
      } else if (user.projectDir) {
        var stats = codeAnalyzer.getProjectStats(user.projectDir, {
          extensions: user.fileExtensions,
          excludeDirs: user.excludeDirs
        });
        sendJSON(res, 200, stats);
      } else {
        send400(res, 'No project directory or agent configured. Go to Settings.');
      }
      return;
    }

    // Helper: execute bug list query
    function _doBugList(res, uid, filters) {
      bugService.listBugs(uid, filters, function (err, data) {
        if (err) {
          var msg = err.message || '';
          if (msg.indexOf('rate limit') !== -1 || msg.indexOf('THROTTLE') !== -1) {
            return sendJSON(res, 429, { error: msg });
          }
          return send500(res, msg);
        }
        sendJSON(res, 200, data);
      });
    }

    // Helper: execute /mybugs/ query for logged-in user
    function _doMyBugList(res, uid, filters) {
      bugService.listMyBugs(uid, filters, function (err, data) {
        if (err) {
          var msg = err.message || '';
          if (msg.indexOf('rate limit') !== -1 || msg.indexOf('THROTTLE') !== -1) {
            return sendJSON(res, 429, { error: msg });
          }
          return send500(res, msg);
        }

        // Auto-update user's defaultAssignee and name from /mybugs/ response
        if (data.loginUser) {
          var bugUser = userStore.getUser(uid);
          var updates = {};
          // Always sync defaultAssignee to the actual /mybugs/ identity
          if (bugUser.defaultAssignee !== data.loginUser) {
            updates.defaultAssignee = data.loginUser;
          }
          if (!bugUser.name || bugUser.name === 'Zoho User') {
            updates.name = data.loginUser;
          }
          if (Object.keys(updates).length > 0) {
            userStore.saveUser(uid, updates);
            console.log('Auto-updated user identity from /mybugs/:', data.loginUser);
          }
        }

        sendJSON(res, 200, data);
      });
    }

    // GET /api/bugs
    if (pathname === '/api/bugs' && method === 'GET') {
      var bugUser = userStore.getUser(userId);
      var assigneeVal = query.assignee || '';

      // ── "me" or empty assignee → use /mybugs/ endpoint directly ──
      // /mybugs/ returns bugs assigned to the OAuth token owner.
      // No ZUID or assignee name needed — Zoho resolves from the token.
      if (!assigneeVal || assigneeVal.toLowerCase() === 'me') {
        var myFilters = {
          status: query.status || '',
          milestone: query.milestone || '',
          index: query.index || '0',
          range: query.range || '25'
        };
        _doMyBugList(res, userId, myFilters);
        return;
      }

      // ── Specific assignee name → check if it's the logged-in user ──
      var assigneeZuidVal = '';
      if (assigneeVal && bugUser.zohoZuid) {
        var storedName = (bugUser.defaultAssignee || bugUser.name || '').toLowerCase();
        var qName = assigneeVal.toLowerCase();
        if ((storedName && qName === storedName) || (storedName && storedName.indexOf(qName) !== -1)) {
          // It's the logged-in user — use /mybugs/ endpoint
          var myFilters2 = {
            status: query.status || '',
            milestone: query.milestone || '',
            index: query.index || '0',
            range: query.range || '25'
          };
          _doMyBugList(res, userId, myFilters2);
          return;
        }
      }

      // ── Different assignee or no ZUID → project-level bugs API ──
      var filters = {
        status: query.status || '',
        severity: query.severity || '',
        assignee: assigneeVal,
        assigneeZuid: '',
        milestone: query.milestone || '',
        module: query.module || '',
        reporter: query.reporter || '',
        flag: query.flag || '',
        index: query.index || '0',
        range: query.range || '25'
      };

      _doBugList(res, userId, filters);
      return;
    }

    // GET /api/bugs/:id
    var bugMatch = pathname.match(/^\/api\/bugs\/([a-zA-Z0-9_]+)$/);
    if (bugMatch && method === 'GET') {
      bugService.getBugDetails(userId, bugMatch[1], function (err, data) {
        if (err) return send500(res, err.message);
        sendJSON(res, 200, data);
      });
      return;
    }

    // POST /api/bugs/:id/analyze
    var analyzeMatch = pathname.match(/^\/api\/bugs\/([a-zA-Z0-9_]+)\/analyze$/);
    if (analyzeMatch && method === 'POST') {
      var githubAI = require('./lib/github-ai-client');
      var claudeClient = require('./lib/claude-client');
      readBody(req, function (bodyErr, body) {
        var extraDescription = (body && body.extraDescription) ? body.extraDescription : '';
        var targetRoute = (body && body.targetRoute) ? body.targetRoute : '';
        var includeImages = body && body.includeImages !== false; // default true
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[STEP 1/6] 📥 Analyze request received');
        console.log('  Bug ID:', analyzeMatch[1]);
        console.log('  User:', userId);
        console.log('  Extra description:', extraDescription.length, 'chars');
        console.log('  Target route:', targetRoute || '(auto-detect)');
        console.log('  Time:', new Date().toLocaleTimeString());
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        logger.analyzeStart(analyzeMatch[1], userId, {
          extraDescriptionLength: extraDescription.length,
          targetRoute: targetRoute || '(auto-detect)',
          includeImages: includeImages
        });
        console.log('');
        console.log('[STEP 2/6] 🔍 Fetching bug details from Zoho...');
        var _analyzeStart = Date.now();
        bugService.getBugDetails(userId, analyzeMatch[1], function (err, bugData) {
          if (err) { console.error('[STEP 2/6] ❌ getBugDetails FAILED:', err.message); return send500(res, err.message); }
          console.log('[STEP 2/6] ✅ Bug details fetched in', (Date.now() - _analyzeStart) + 'ms');
          console.log('  Title:', (bugData.bug.title || '').substring(0, 80));
          console.log('  Status:', bugData.bug.status, '| Severity:', bugData.bug.severity);
          console.log('  Attachments:', (bugData.attachments || []).length, '| Comments:', (bugData.comments || []).length);
          logger.bugFetched(analyzeMatch[1], {
            title: bugData.bug.title || '',
            status: bugData.bug.status,
            severity: bugData.bug.severity,
            module: bugData.bug.module || '',
            attachmentCount: (bugData.attachments || []).length,
            commentCount: (bugData.comments || []).length
          }, Date.now() - _analyzeStart);

          // Download image attachments for vision analysis (optional, controlled by user toggle)
          var _bugImages = [];
          function proceedAfterImages() {

          var analyzeUser = userStore.getUser(userId);
          // Store parsed structured description for use in interaction steps & fix prompt
          var _parsedDesc = null;

          // ── Server-side auto-detect route when not manually specified ──
          function autoDetectAndContinue() {
            if (targetRoute || !analyzeUser.agentUrl) {
              // Route already specified or no agent — skip auto-detect
              if (targetRoute) console.log('[AUTO-DETECT] ✅ Manual route provided:', targetRoute);
              return continueWithAnalysis();
            }

            console.log('[AUTO-DETECT] 🔍 No route specified — auto-detecting from bug data...');
            var bugModule = bugData.bug.module || '';
            var bugTitle2 = bugData.bug.title || '';
            var bugDesc2 = bugData.bug.description || '';
            // Also check extra description for structured format
            var combinedDesc = bugDesc2 + (extraDescription ? '\n' + extraDescription : '');

            var matchUrl = analyzeUser.agentUrl.replace(/\/+$/, '') +
              '/routes/match?title=' + encodeURIComponent(bugTitle2) +
              '&description=' + encodeURIComponent(combinedDesc.substring(0, 2000)) +
              '&module=' + encodeURIComponent(bugModule);

            var matchReq = require('http').get(matchUrl, function (matchRes) {
              var matchBody = '';
              matchRes.on('data', function (chunk) { matchBody += chunk; });
              matchRes.on('end', function () {
                try {
                  var matchData = JSON.parse(matchBody);
                  if (matchData.matchedRoute) {
                    targetRoute = matchData.matchedRoute;
                    _parsedDesc = matchData.parsedDesc || null;
                    console.log('[AUTO-DETECT] ✅ Route detected:', targetRoute, '(method:', matchData.method + ', score:', matchData.score + ')');
                    logger.routeDetected(analyzeMatch[1], targetRoute, matchData.method, matchData.score);
                  } else {
                    _parsedDesc = matchData.parsedDesc || null;
                    console.log('[AUTO-DETECT] ⚠️ No confident route match found (method:', matchData.method + ', score:', matchData.score + ')');
                  }
                } catch (e) {
                  console.log('[AUTO-DETECT] ⚠️ Parse error:', e.message);
                }
                continueWithAnalysis();
              });
            });
            matchReq.on('error', function (e) {
              console.log('[AUTO-DETECT] ⚠️ Agent unreachable:', e.message, '— continuing without route');
              continueWithAnalysis();
            });
            matchReq.setTimeout(5000, function () { matchReq.abort(); });
          }

          function continueWithAnalysis() {
          var aiModel = analyzeUser.aiModel || 'claude-opus-4-6';
          var devServerUrl = analyzeUser.devServerUrl || '';
          var _templateCtx = null;
          var _componentRegistry = [];

          console.log('');
          console.log('[STEP 3/8] \uD83D\uDCC2 Analysis pipeline:');
          console.log('  Agent:', JSON.stringify(analyzeUser.agentUrl) || '(local mode)');
          console.log('  AI model:', aiModel);
          if (targetRoute) console.log('  Target route:', targetRoute);

          // ================================================================
          //  REPRODUCTION HELPER FUNCTIONS (hoisted — available everywhere)
          // ================================================================

          /**
           * Build enhanced reproduction prompt with 4 layers:
           *  L1: Ember 1.13 rendering knowledge base
           *  L2: Component registry (auto-extracted metadata)
           *  L3: Few-shot HBS-to-Puppeteer examples
           *  L4: Two-phase output format (confidence + plan + steps + questions)
           */
          function buildInteractionStepsPrompt(bugTitle, bugDesc, templateCtx, componentRegistry) {
            var lines = [];

            // ── Layer 1: Ember 1.13 Rendering Knowledge Base ──
            lines.push('You are helping reproduce a bug in an Ember.js 1.13.15 application by generating Puppeteer browser interaction steps.');
            lines.push('');
            lines.push('## CRITICAL: Ember 1.13.15 Rendering Rules');
            lines.push('This app uses Ember 1.13.15 with HTMLBars. Understand how HBS templates render to DOM:');
            lines.push('');
            lines.push('### Component Rendering');
            lines.push('- Each Ember component renders as a wrapper DOM element (default: `<div>`).');
            lines.push('- `tagName: "span"` in component.js \u2192 renders as `<span>` instead of `<div>`.');
            lines.push('- `tagName: ""` \u2192 tagless component, no wrapper element.');
            lines.push('- `classNames: ["foo", "bar"]` \u2192 adds CSS classes `foo bar` to the wrapper element.');
            lines.push('- `classNameBindings: ["isActive:active:inactive", "isOpen"]` \u2192 conditionally adds classes.');
            lines.push('  - `"isActive:active:inactive"` \u2192 if isActive true: class "active", else: "inactive".');
            lines.push('  - `"isOpen"` \u2192 if isOpen true: class "is-open" (dasherized property name).');
            lines.push('- `attributeBindings: ["title", "disabled", "data-id:elementId"]` \u2192 binds properties to DOM attributes.');
            lines.push('');
            lines.push('### Template Elements');
            lines.push('- `{{input value=text placeholder="..."}}` \u2192 `<input class="ember-text-field" ...>`.');
            lines.push('- `{{textarea value=text}}` \u2192 `<textarea class="ember-text-area">`.');
            lines.push('- `<button {{action "doSomething"}}>Text</button>` \u2192 `<button>` with click handler.');
            lines.push('- `{{#link-to "route.name"}}Text{{/link-to}}` \u2192 `<a class="ember-view" href="...">`.');
            lines.push('- `{{my-component prop=val}}` \u2192 check component registry below for DOM element/classes.');
            lines.push('- `{{#each items as |item|}}...{{/each}}` \u2192 multiple DOM nodes, one per item.');
            lines.push('- `{{#if condition}}...{{/if}}` \u2192 conditional rendering (absent if false).');
            lines.push('');
            lines.push('### CSS Selector Strategy (PRIORITY ORDER)');
            lines.push('1. **FIRST CHOICE: data-auto-id** → `[data-auto-id="value"]`. This app places `data-auto-id` on ALL clickable and interactive elements. These are the MOST STABLE selectors. ALWAYS use them when available.');
            lines.push('2. class-based selectors (.my-class) as fallback.');
            lines.push('3. Other data attributes ([data-attr]) as fallback.');
            lines.push('4. Components with classNames → use those exact classes as fallback selectors.');
            lines.push('5. Ember auto-adds .ember-view to all component wrapper elements.');
            lines.push('6. For {{input}} helpers, use .ember-text-field or surrounding component class.');
            lines.push('- AVOID: auto-generated IDs (#ember123) — they change on every render.');
            lines.push('- AVOID: XPath. Use CSS selectors only.');
            lines.push('- When unsure about a selector, raise it in the "questions" field.');
            lines.push('');
            lines.push('**IMPORTANT: When a data-auto-id is available for an element, it MUST be the primary selector.**');
            lines.push('Format: `[data-auto-id="the-value"]`');
            lines.push('Example: `<button data-auto-id="save-btn" class="btn-primary">Save</button>` → selector: `[data-auto-id="save-btn"]`');
            lines.push('');
            lines.push('### 🚫 ABSOLUTE RULE: data-auto-id MUST come from the template');
            lines.push('- You MUST **read the actual `data-auto-id` value from the HBS template code** shown below.');
            lines.push('- The data-auto-id ALLOWLIST section below lists EVERY valid data-auto-id on this page.');
            lines.push('- Do NOT assume, guess, or invent data-auto-id values. If you cannot find a data-auto-id for an element in the templates, that element does NOT have one — use a CSS class selector instead.');
            lines.push('- WRONG: Guessing `[data-auto-id="save-button"]` because the button says "Save".');
            lines.push('- RIGHT: Reading the template and finding `<button data-auto-id="btn-save-record">Save</button>` → `[data-auto-id="btn-save-record"]`.');
            lines.push('- RIGHT: Template has `<button class="save-btn">Save</button>` (no data-auto-id) → use `.save-btn`.');
            lines.push('');
            lines.push('**Scan the HBS templates below VERY CAREFULLY for data-auto-id attributes.**');
            lines.push('Every element with data-auto-id is an interactive element you can target reliably.');
            lines.push('');
            lines.push('### Form & Input Intelligence');
            lines.push('When the page contains forms, you MUST analyze them thoroughly:');
            lines.push('');
            lines.push('1. **Identify ALL form fields** from the HBS templates:');
            lines.push('   - `{{input value=... placeholder="..."}}` → text input');
            lines.push('   - `{{textarea value=...}}` → textarea');
            lines.push('   - `<select>` or `{{#x-select}}` → dropdown');
            lines.push('   - `<input type="checkbox">` or `{{input type="checkbox"}}` → checkbox');
            lines.push('   - `<input type="radio">` → radio button');
            lines.push('   - `{{input type="date"}}`, `{{input type="number"}}` → typed inputs');
            lines.push('');
            lines.push('2. **Determine mandatory fields**: Look for:');
            lines.push('   - `required=true` or `required` attribute in HBS');
            lines.push('   - Validation rules in component JS (e.g., `if (!this.get("fieldName")) { error }`)');
            lines.push('   - CSS classes like `.required`, `.mandatory`, `*` markers in labels');
            lines.push('   - Controller/route `validate()` or `save()` methods that check for empty fields');
            lines.push('');
            lines.push('3. **Generate realistic test data**: For each field generate appropriate values:');
            lines.push('   - Name fields: "bugtrack_test_user"');
            lines.push('   - Email: "bugtrack_test@example.com"');
            lines.push('   - Phone: "1234567890"');
            lines.push('   - Description/text: "Automated test entry for bug reproduction"');
            lines.push('   - Numbers: appropriate range values');
            lines.push('   - Dates: current date or valid date string');
            lines.push('   - Dropdowns: pick the first valid option visible in the template');
            lines.push('   - Prefix ALL created entities/names with "bugtrack_test_"');
            lines.push('');
            lines.push('4. **Know correct vs incorrect input**: If the bug involves validation:');
            lines.push('   - Identify what valid input looks like');
            lines.push('   - Identify what the bug-triggering input looks like');
            lines.push('   - Generate steps that trigger the exact buggy behavior');
            lines.push('');
            lines.push('5. **Ask questions about forms** when:');
            lines.push('   - A field has no placeholder and the expected format is unclear');
            lines.push('   - A dropdown has options loaded dynamically (not in template)');
            lines.push('   - You cannot determine which fields are mandatory');
            lines.push('   - The form submit button or save action is not obvious');
            lines.push('');

            // ── Bug Details ──
            lines.push('## Bug');
            lines.push('Title: ' + (bugTitle || 'Unknown'));
            lines.push('Description: ' + (bugDesc || 'No description'));
            lines.push('');

            // Structured QA data
            if (_parsedDesc) {
              lines.push('## Structured QA Report');
              if (_parsedDesc.page) lines.push('**Page:** ' + _parsedDesc.page);
              if (_parsedDesc.steps && _parsedDesc.steps.length > 0) {
                lines.push('**QA Reproduction Steps:**');
                for (var qi = 0; qi < _parsedDesc.steps.length; qi++) {
                  lines.push((qi + 1) + '. ' + _parsedDesc.steps[qi]);
                }
              }
              if (_parsedDesc.expected) lines.push('**Expected:** ' + _parsedDesc.expected);
              if (_parsedDesc.actual) lines.push('**Actual (bug):** ' + _parsedDesc.actual);
              lines.push('');
            }

            // ── Layer 2: Component Registry ──
            if (componentRegistry && componentRegistry.length > 0) {
              lines.push('## Component Registry (Auto-Extracted from Source)');
              lines.push('These are all components with their rendering metadata:');
              lines.push('');
              lines.push('| Component | Tag | CSS Classes | Key Actions | data-auto-ids |');
              lines.push('|-----------|-----|-------------|-------------|---------------|');
              for (var ci = 0; ci < componentRegistry.length && ci < 100; ci++) {
                var comp = componentRegistry[ci];
                var tag = comp.tagName || 'div';
                var classes = (comp.classNames || []).join(', ') || '\u2014';
                var acts = (comp.actions || []).slice(0, 5).join(', ') || '\u2014';
                var autoIds = (comp.dataAutoIds || []).map(function (a) { return a.id; }).slice(0, 5).join(', ') || '\u2014';
                lines.push('| ' + comp.name + ' | `<' + tag + '>` | ' + classes + ' | ' + acts + ' | ' + autoIds + ' |');
              }
              lines.push('');
              lines.push('Use this registry to determine correct DOM elements and CSS classes for components in the templates.');
              lines.push('');
            }

            // ── data-auto-id ALLOWLIST (extracted from all templates) ──
            var knownAutoIds = [];
            if (templateCtx && templateCtx.dataAutoIds && templateCtx.dataAutoIds.length > 0) {
              lines.push('## ⚠️ STRICT data-auto-id ALLOWLIST (READ THIS FIRST)');
              lines.push('');
              lines.push('The following data-auto-id values were **extracted directly from the HBS source code** for this page.');
              lines.push('These are the ONLY valid data-auto-id values that exist. **You MUST use them exactly as listed.**');
              lines.push('');
              lines.push('### 🚫 ABSOLUTE RULE: NEVER INVENT data-auto-id VALUES');
              lines.push('- Do NOT guess or fabricate data-auto-id values.');
              lines.push('- Do NOT modify, shorten, or change the casing of these IDs.');
              lines.push('- If an element does NOT have a data-auto-id in the list below, use a CSS class selector instead.');
              lines.push('- ONLY use `[data-auto-id="..."]` selectors for IDs that appear in the table below.');
              lines.push('');
              lines.push('### Valid data-auto-id values for this page:');
              lines.push('');
              lines.push('| # | data-auto-id (EXACT) | Selector to use | Element | CSS Classes | Context |');
              lines.push('|---|---------------------|-----------------|---------|-------------|---------|');
              for (var di = 0; di < templateCtx.dataAutoIds.length && di < 80; di++) {
                var dai = templateCtx.dataAutoIds[di];
                var daiSelector = '[data-auto-id="' + dai.id + '"]';
                knownAutoIds.push(dai.id);
                lines.push('| ' + (di + 1) + ' | `' + dai.id + '` | `' + daiSelector + '` | `<' + dai.tag + '>` | ' + (dai.classes || '\u2014') + ' | ' + (dai.text || '\u2014') + ' |');
              }
              lines.push('');
              lines.push('**Total valid data-auto-ids: ' + templateCtx.dataAutoIds.length + '**');
              lines.push('');
              lines.push('For each step, LOOK UP the target element in this table. If you find it, copy the "Selector to use" column EXACTLY.');
              lines.push('If the element is NOT in this table, it does NOT have a data-auto-id — use a CSS class selector instead.');
              lines.push('');
            }

            // ── Template Context ──
            if (templateCtx && templateCtx.template) {
              lines.push('## Page Template (HBS)');
              lines.push('File: ' + templateCtx.template.path);
              lines.push('```hbs');
              var tContent = templateCtx.template.content;
              if (tContent.length > 6000) tContent = tContent.substring(0, 6000) + '\n{{!-- truncated --}}';
              lines.push(tContent);
              lines.push('```');
              lines.push('');
            }

            if (templateCtx && templateCtx.componentTemplates && templateCtx.componentTemplates.length > 0) {
              lines.push('## Component Templates');
              templateCtx.componentTemplates.forEach(function (ct) {
                lines.push('### ' + ct.name);
                // Show data-auto-ids available in this component BEFORE the template
                if (ct.dataAutoIds && ct.dataAutoIds.length > 0) {
                  lines.push('**Available data-auto-ids in this component:** ' + ct.dataAutoIds.map(function (a) {
                    return '`[data-auto-id="' + a.id + '"]` (' + a.tag + (a.text ? ', "' + a.text + '"' : '') + ')';
                  }).join(', '));
                } else {
                  lines.push('**data-auto-ids:** None — use CSS class selectors for elements in this component.');
                }
                lines.push('**Template:** ' + (ct.path || ct.name + '/template.hbs'));
                lines.push('```hbs');
                var cContent = ct.content;
                if (cContent.length > 4000) cContent = cContent.substring(0, 4000) + '\n{{!-- truncated --}}';
                lines.push(cContent);
                lines.push('```');
                if (ct.jsContent) {
                  lines.push('**Component JS:** ' + (ct.jsPath || ct.name + '/component.js'));
                  lines.push('```js');
                  var jsC = ct.jsContent;
                  if (jsC.length > 3000) jsC = jsC.substring(0, 3000) + '\n// ... truncated ...';
                  lines.push(jsC);
                  lines.push('```');
                }
                lines.push('');
              });
            }

            if (templateCtx && templateCtx.routeJS && templateCtx.routeJS.length > 0) {
              lines.push('## Route/Controller JS');
              templateCtx.routeJS.forEach(function (rj) {
                lines.push('### ' + rj.path + ' (' + rj.type + ')');
                lines.push('```js');
                lines.push(rj.content);
                lines.push('```');
                lines.push('');
              });
            }

            // ── Layer 3: Few-Shot Examples ──
            lines.push('## Few-Shot Examples: HBS \u2192 Puppeteer Mapping');
            lines.push('');
            lines.push('### Example 1: Clicking a button with data-auto-id (PREFERRED)');
            lines.push('HBS: `<button data-auto-id="save-record-btn" class="btn-save" {{action "saveRecord"}}>Save</button>`');
            lines.push('Step: `{ "action": "click", "selector": "[data-auto-id=\\"save-record-btn\\"]", "fallbackSelectors": [".btn-save", "button.btn-save"], "textContent": "Save", "description": "Click Save button" }`');
            lines.push('');
            lines.push('### Example 2: Typing into an input with data-auto-id');
            lines.push('HBS: `{{input value=searchQuery placeholder="Search..." class="search-input" data-auto-id="search-field"}}`');
            lines.push('Step: `{ "action": "type", "selector": "[data-auto-id=\\"search-field\\"]", "text": "test query", "fallbackSelectors": [".search-input", "input.ember-text-field.search-input"], "textContent": "Search...", "description": "Type in search" }`');
            lines.push('Note: {{input}} renders as `<input class="ember-text-field search-input">`.');
            lines.push('');
            lines.push('### Example 3: Clicking a component with class-based selectors (no data-auto-id)');
            lines.push('Component JS: `classNames: ["dropdown-trigger", "header-dropdown"]`');
            lines.push('Step: `{ "action": "click", "selector": ".dropdown-trigger", "fallbackSelectors": [".header-dropdown", "div.dropdown-trigger"], "textContent": "Menu", "description": "Open dropdown" }`');
            lines.push('');
            lines.push('### Example 4: Asserting text content');
            lines.push('HBS: `<span data-auto-id="page-title" class="page-title">{{model.title}}</span>`');
            lines.push('Assert: `{ "action": "assert", "selector": "[data-auto-id=\\"page-title\\"]", "attribute": "textContent", "expected": "Wrong Title", "compare": "contains", "fallbackSelectors": [".page-title", "span.page-title"], "textContent": "Wrong Title", "description": "Buggy title text" }`');
            lines.push('');

            // ── Layer 4: Two-Phase Output Format ──
            lines.push('## Task');
            lines.push('Analyze the bug and HBS templates thoroughly to generate a reproduction plan.');
            lines.push('Your job is to be INTERACTIVE — analyze deeply, ask smart questions, and let the user guide you.');
            lines.push('');
            lines.push('Return a JSON object (NOT a plain array) with this structure:');
            lines.push('```json');
            lines.push('{');
            lines.push('  "confidence": "high" | "medium" | "low",');
            lines.push('  "plan": ["Step-by-step description of what the test will do"],');
            lines.push('  "steps": [{ "action": "click", "selector": "...", "description": "..." }],');
            lines.push('  "formAnalysis": {');
            lines.push('    "hasForms": true,');
            lines.push('    "fields": [');
            lines.push('      { "name": "fieldName", "selector": ".field-class", "type": "text|select|checkbox|radio|textarea|date|number", "required": true, "testValue": "bugtrack_test_value", "notes": "why this value" }');
            lines.push('    ],');
            lines.push('    "submitSelector": ".save-btn",');
            lines.push('    "submitAction": "saveRecord"');
            lines.push('  },');
            lines.push('  "questions": [');
            lines.push('    { "id": "q1", "question": "What is X?", "reason": "I need to know because...", "options": ["A", "B"], "affectedSteps": [2, 5] }');
            lines.push('  ],');
            lines.push('  "uncertainSelectors": [');
            lines.push('    { "selector": ".some-class", "reason": "Uncertain because...", "alternatives": [".other-class"] }');
            lines.push('  ]');
            lines.push('}');
            lines.push('```');
            lines.push('');
            lines.push('### Confidence Levels:');
            lines.push('- **high**: All selectors clear from templates/registry, steps straightforward.');
            lines.push('- **medium**: Most selectors identifiable but 1-2 uncertain. Include questions.');
            lines.push('- **low**: Multiple selectors unclear. Ask questions for all uncertain elements.');
            lines.push('');
            lines.push('### CRITICAL: Be Interactive — Ask Smart Questions');
            lines.push('You MUST always generate meaningful questions. The user will review your plan before anything runs.');
            lines.push('');
            lines.push('**Always ask about:**');
            lines.push('- The exact starting page/route: "Is the page at route X the correct starting point?"');
            lines.push('- Any selectors you are not 100% certain about: "Does the button have class `.foo`?"');
            lines.push('- Form fields with unclear mandatory status: "Is the Description field required?"');
            lines.push('- Dynamic content: "What option should I select from the dropdown?"');
            lines.push('- Navigation flow: "After clicking Save, does the page redirect or stay?"');
            lines.push('- Environment state: "Does this page require existing data to be present first?"');
            lines.push('- Bug trigger conditions: "Does this bug happen with any input or specific input?"');
            lines.push('');
            lines.push('**Question quality rules:**');
            lines.push('- Each question should be specific and actionable');
            lines.push('- Provide 2-4 clear options when possible');
            lines.push('- Explain WHY you need the answer (the "reason" field)');
            lines.push('- Reference which step numbers the answer affects ("affectedSteps")');
            lines.push('- Minimum 2 questions, aim for 3-5 per plan');
            lines.push('');
            lines.push('ALWAYS provide best-guess "steps" even if you have questions.');
            lines.push('If the user skips answering, these steps will be used directly.');
            lines.push('');

            // Standard step types
            lines.push('### Available step types:');
            lines.push('Each step MUST include `fallbackSelectors` and `textContent` for self-healing.');
            lines.push('**Primary selector MUST be `[data-auto-id="..."]` when one exists in the template for that element.**');
            lines.push('');
            lines.push('- { "action": "click", "selector": "[data-auto-id=\\"btn-id\\"]", "fallbackSelectors": [".alt-class", "button.other"], "textContent": "visible button text", "description": "why" }');
            lines.push('- { "action": "type", "selector": "[data-auto-id=\\"input-id\\"]", "text": "value to type", "fallbackSelectors": ["input.alt", ".field-class"], "textContent": "placeholder text", "description": "why" }');
            lines.push('- { "action": "waitForSelector", "selector": "[data-auto-id=\\"element-id\\"]", "fallbackSelectors": [".alt"], "description": "why" }');
            lines.push('- { "action": "select", "selector": "[data-auto-id=\\"dropdown-id\\"]", "value": "option-value", "fallbackSelectors": ["select.alt"], "textContent": "dropdown label", "description": "why" }');
            lines.push('- { "action": "hover", "selector": "[data-auto-id=\\"hover-id\\"]", "fallbackSelectors": [".alt"], "textContent": "visible text", "description": "why" }');
            lines.push('- { "action": "wait", "ms": 1000, "description": "why" }');
            lines.push('- { "action": "screenshot", "name": "step_name", "description": "why" }');
            lines.push('- { "action": "assert", "selector": "[data-auto-id=\\"assert-id\\"]", "attribute": "textContent|placeholder|value|class|...", "expected": "BUGGY value", "compare": "equals|contains", "fallbackSelectors": [".alt"], "textContent": "element text", "description": "what" }');
            lines.push('');
            lines.push('### CRITICAL: Self-Healing Fields');
            lines.push('The Puppeteer engine uses self-healing: if the primary selector fails, it tries fallbackSelectors, then searches by textContent.');
            lines.push('');
            lines.push('**Selector priority for EVERY step:**');
            lines.push('1. **Primary selector**: `[data-auto-id="..."]` — if the element has data-auto-id in the template, THIS is the primary selector. Period.');
            lines.push('2. **fallbackSelectors**: Array of 2-4 alternative CSS selectors (by class, by parent+child, by attribute, by tag).');
            lines.push('3. **textContent**: The visible text the element displays (for buttons: the label, for inputs: the placeholder). Last resort.');
            lines.push('');
            lines.push('For EVERY step with a selector, you MUST provide:');
            lines.push('- **selector**: `[data-auto-id="..."]` when available, otherwise best CSS selector.');
            lines.push('- **fallbackSelectors**: Array of 2-4 alternative CSS selectors.');
            lines.push('- **textContent**: The visible text of the element.');
            lines.push('');
            lines.push('Example of good selectors for a Save button with data-auto-id:');
            lines.push('```');
            lines.push('"selector": "[data-auto-id=\\"save-record\\"]",');
            lines.push('"fallbackSelectors": [".btn-save", ".save-button", "button.btn-primary", ".form-actions button"],');
            lines.push('"textContent": "Save"');
            lines.push('```');
            lines.push('');

            // Assert instructions
            lines.push('### CRITICAL: Assert Steps');
            lines.push('Include at least one "assert" step verifying the BUGGY condition.');
            lines.push('The "expected" value = the INCORRECT/BUGGY value from the bug report.');
            if (_parsedDesc && _parsedDesc.actual) {
              lines.push('');
              lines.push('For this bug:');
              lines.push('ACTUAL (buggy): "' + _parsedDesc.actual + '"');
              if (_parsedDesc.expected) lines.push('EXPECTED (correct): "' + _parsedDesc.expected + '"');
              lines.push('Your assert "expected" should match the BUGGY value.');
            }
            lines.push('');

            // Setup-Action-Verify
            lines.push('### Setup-Action-Verify Pattern (for destructive bugs):');
            lines.push('Phase 1 Setup: Create a TEST entity (prefix "bugtrack_test_").');
            lines.push('Phase 2 Action: Perform the bug action on the test entity.');
            lines.push('Phase 3 Verify: Assert the buggy behavior.');
            lines.push('For display issues, skip setup and interact directly.');
            lines.push('');
            lines.push('Keep sequence practical: 5-20 steps. Return ONLY valid JSON, no markdown fences.');
            lines.push('');

            // ── Final Reminder: data-auto-id strictness ──
            if (knownAutoIds.length > 0) {
              lines.push('## ⚠️ FINAL REMINDER: data-auto-id RULES');
              lines.push('Before you output JSON, verify EVERY selector:');
              lines.push('- If your selector uses `[data-auto-id="X"]`, check that X is in this list: ' + knownAutoIds.map(function (id) { return '"' + id + '"'; }).join(', '));
              lines.push('- If X is NOT in that list, it does NOT exist. Replace with a CSS class selector from the template.');
              lines.push('- NEVER assume or guess data-auto-id values. They must come from the actual HBS templates shown above.');
              lines.push('');
            }

            return { prompt: lines.join('\n'), knownAutoIds: knownAutoIds };
          }

          /**
           * Parse AI response into reproduction plan object.
           * Supports both new format (JSON object) and old format (JSON array).
           */
          function parseReproductionPlan(aiText) {
            var empty = { confidence: 'low', plan: [], steps: [], questions: [], uncertainSelectors: [], formAnalysis: null };
            if (!aiText) return empty;
            var cleaned = aiText.trim();
            cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');

            // Try new format: JSON object with confidence/plan/steps/questions
            try {
              var objMatch = cleaned.match(/\{[\s\S]*\}/);
              if (objMatch) {
                var parsed = JSON.parse(objMatch[0]);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  return {
                    confidence: parsed.confidence || 'medium',
                    plan: Array.isArray(parsed.plan) ? parsed.plan : [],
                    steps: Array.isArray(parsed.steps) ? parsed.steps.filter(function (s) {
                      return s && s.action && typeof s.action === 'string';
                    }) : [],
                    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
                    uncertainSelectors: Array.isArray(parsed.uncertainSelectors) ? parsed.uncertainSelectors : [],
                    formAnalysis: parsed.formAnalysis || null
                  };
                }
              }
            } catch (e) {
              console.log('[Repro] JSON object parse failed:', e.message);
            }

            // Fallback: plain JSON array (old format)
            try {
              var arrayMatch = cleaned.match(/\[[\s\S]*\]/);
              if (arrayMatch) {
                var steps = JSON.parse(arrayMatch[0]);
                if (Array.isArray(steps)) {
                  return {
                    confidence: 'medium',
                    plan: [],
                    steps: steps.filter(function (s) { return s && s.action; }),
                    questions: [],
                    uncertainSelectors: [],
                    formAnalysis: null
                  };
                }
              }
            } catch (e2) {
              console.log('[Repro] JSON array fallback failed:', e2.message);
            }

            return empty;
          }

          /**
           * AI fallback chain for reproduction plan generation.
           */
          function tryStepsFallback(stepsPrompt, callback) {
            var isClaude2 = githubAI.isClaudeModel(aiModel);
            var claudeKey2 = analyzeUser.claudeApiKey || '';
            var githubToken2 = analyzeUser.githubToken || '';

            if (isClaude2 && claudeKey2) {
              claudeClient.analyze(claudeKey2, stepsPrompt, { model: aiModel }, function (clErr, clResult) {
                if (!clErr && clResult && clResult.text) {
                  var plan = parseReproductionPlan(clResult.text);
                  console.log('[Repro] \u2705 Anthropic:', plan.steps.length, 'steps, confidence:', plan.confidence);
                  return callback(plan);
                }
                console.log('[Repro] \u26a0\ufe0f Anthropic fallback failed:', clErr ? clErr.message : 'empty');
                callback(null);
              });
            } else if (!isClaude2 && githubToken2) {
              githubAI.analyze(githubToken2, stepsPrompt, { model: aiModel }, function (ghErr, ghResult) {
                if (!ghErr && ghResult && ghResult.text) {
                  var plan = parseReproductionPlan(ghResult.text);
                  console.log('[Repro] \u2705 GitHub Models:', plan.steps.length, 'steps, confidence:', plan.confidence);
                  return callback(plan);
                }
                console.log('[Repro] \u26a0\ufe0f GitHub Models fallback failed:', ghErr ? ghErr.message : 'empty');
                callback(null);
              });
            } else {
              console.log('[Repro] \u26a0\ufe0f No AI fallback available');
              callback(null);
            }
          }

          /**
           * Run a single reproduction attempt: generate script + execute it.
           */
          function runReproduction(steps, label, doneCallback) {
            agentProxy.playwrightGenerate(
              analyzeUser.agentUrl,
              analyzeMatch[1],
              bugData.bug.title || '',
              bugData.bug.description || '',
              devServerUrl,
              analyzeUser.testUsername || '',
              analyzeUser.testPassword || '',
              targetRoute,
              steps
            ).then(function (genResult) {
              console.log('[' + label + '] \u2705 Script generated:', genResult.testFile);
              console.log('[' + label + '] \uD83C\uDFC3 Running reproduction...');
              agentProxy.playwrightRun(analyzeUser.agentUrl, genResult.testFile).then(function (runResult) {
                var bugConfirmed = !!runResult.bugConfirmed;
                var assertions = runResult.assertions || [];
                var navigationOk = runResult.navigationOk !== false;
                var reproduced = bugConfirmed || !runResult.passed;
                var status = 'not-reproduced';
                if (bugConfirmed) { status = 'bug-confirmed'; }
                else if (!navigationOk) { status = 'navigation-failed'; reproduced = false; }
                else if (!runResult.passed) { status = 'test-errors'; }
                else if (assertions.length > 0) { status = 'assertions-passed'; }
                else { status = 'no-assertions'; }
                console.log('[' + label + '] Result: status=' + status + ', passed=' + runResult.passed + ', bugConfirmed=' + bugConfirmed + ', ' + (runResult.duration || 0) + 'ms');
                doneCallback({
                  attempted: true, passed: runResult.passed, reproduced: reproduced,
                  bugConfirmed: bugConfirmed, assertions: assertions, navigationOk: navigationOk,
                  pageUrl: runResult.pageUrl || null, status: status, output: runResult.output,
                  duration: runResult.duration, testFile: genResult.testFile,
                  screenshotFile: runResult.screenshotFile, interactionSteps: steps.length
                });
              }).catch(function (runErr) {
                console.log('[' + label + '] \u26a0\ufe0f Run failed:', runErr.message);
                doneCallback({ attempted: true, passed: false, reproduced: false, error: runErr.message, interactionSteps: steps.length });
              });
            }).catch(function (genErr) {
              console.log('[' + label + '] \u26a0\ufe0f Generate failed:', genErr.message);
              doneCallback({ attempted: false, error: genErr.message });
            });
          }

          /**
           * Attempt reproduction with optional retry on failure.
           */
          function attemptReproduction(reproPlan, callback) {
            if (!analyzeUser.agentUrl) return callback(null);
            var steps = (reproPlan && reproPlan.steps) ? reproPlan.steps : [];
            if (steps.length === 0) return callback(null);

            console.log('');
            console.log('[Repro] \uD83C\uDFAD Attempting reproduction with ' + steps.length + ' steps...');

            runReproduction(steps, 'Repro', function (firstResult) {
              // Check if retry is warranted
              var shouldRetry = firstResult && firstResult.attempted &&
                !firstResult.bugConfirmed &&
                (firstResult.status === 'navigation-failed' || firstResult.status === 'test-errors' || firstResult.status === 'no-assertions') &&
                steps.length > 0;

              if (!shouldRetry) return callback(firstResult);

              // ── Retry: ask AI for corrected steps ──
              console.log('[Repro-retry] \uD83D\uDD04 First attempt was ' + firstResult.status + ' \u2014 asking AI for fix...');
              var retryLines = [];
              retryLines.push('A Puppeteer reproduction test just ran but the result was: ' + firstResult.status);
              retryLines.push('');
              retryLines.push('## Bug');
              retryLines.push('Title: ' + (bugData.bug.title || ''));
              retryLines.push('Description: ' + (bugData.bug.description || '').substring(0, 1500));
              retryLines.push('');
              retryLines.push('## Original Steps (that failed)');
              retryLines.push('```json');
              retryLines.push(JSON.stringify(steps, null, 2));
              retryLines.push('```');
              retryLines.push('');
              retryLines.push('## Test Output');
              retryLines.push('```');
              retryLines.push((firstResult.output || '').substring(0, 3000));
              retryLines.push('```');
              if (firstResult.pageUrl) retryLines.push('Final URL: ' + firstResult.pageUrl);
              retryLines.push('');
              retryLines.push('## Task');
              retryLines.push('Generate CORRECTED interaction steps that fix issues like wrong selectors, missing waits, wrong navigation.');
              retryLines.push('Include at least one "assert" step checking the buggy condition.');
              retryLines.push('Return ONLY a valid JSON array of corrected steps. No markdown fences.');
              var retryPrompt = retryLines.join('\n');

              var copilotBridge3 = require('./lib/copilot-bridge-client');
              copilotBridge3.checkHealth(function (hErr3, hData3) {
                function gotRetrySteps(retrySteps) {
                  if (retrySteps && retrySteps.length > 0) {
                    console.log('[Repro-retry] \u2705 Got ' + retrySteps.length + ' corrected steps \u2014 running...');
                    runReproduction(retrySteps, 'Repro-retry', function (retryResult) {
                      if (retryResult && (retryResult.bugConfirmed || retryResult.status === 'assertions-passed')) {
                        retryResult.retried = true;
                        return callback(retryResult);
                      }
                      firstResult.retryAttempted = true;
                      callback(firstResult);
                    });
                  } else {
                    firstResult.retryAttempted = true;
                    callback(firstResult);
                  }
                }

                function tryRetryFallback2() {
                  var isClaude3 = githubAI.isClaudeModel(aiModel);
                  var claudeKey3 = analyzeUser.claudeApiKey || '';
                  var githubToken3 = analyzeUser.githubToken || '';
                  if (isClaude3 && claudeKey3) {
                    claudeClient.analyze(claudeKey3, retryPrompt, { model: aiModel }, function (e3, r3) {
                      if (!e3 && r3 && r3.text) {
                        var p3 = parseReproductionPlan(r3.text);
                        return gotRetrySteps(p3.steps);
                      }
                      firstResult.retryAttempted = true; callback(firstResult);
                    });
                  } else if (!isClaude3 && githubToken3) {
                    githubAI.analyze(githubToken3, retryPrompt, { model: aiModel }, function (e3, r3) {
                      if (!e3 && r3 && r3.text) {
                        var p3 = parseReproductionPlan(r3.text);
                        return gotRetrySteps(p3.steps);
                      }
                      firstResult.retryAttempted = true; callback(firstResult);
                    });
                  } else {
                    firstResult.retryAttempted = true; callback(firstResult);
                  }
                }

                if (!hErr3 && hData3 && hData3.ok) {
                  copilotBridge3.analyze(retryPrompt, aiModel, function (bErr3, bRes3) {
                    if (!bErr3 && bRes3 && bRes3.text) {
                      var p3 = parseReproductionPlan(bRes3.text);
                      return gotRetrySteps(p3.steps);
                    }
                    tryRetryFallback2();
                  });
                } else {
                  tryRetryFallback2();
                }
              });
            });
          }

          /**
           * Build "Reproduction Evidence" section to inject into AI fix prompt.
           */
          function buildReproductionEvidenceSection(repro) {
            if (!repro || !repro.attempted) return '';
            var lines = [];
            lines.push('## \uD83E\uDDEA Reproduction Evidence (Automated Browser Test)');
            lines.push('');
            lines.push('> Collected by running an automated Puppeteer test against the dev server.');
            lines.push('');
            lines.push('**Status:** ' + repro.status);
            if (repro.bugConfirmed) {
              lines.push('');
              lines.push('\u26a0\ufe0f **BUG CONFIRMED** \u2014 automated test found evidence matching the reported bug.');
              lines.push('Your fix MUST address this confirmed behavior.');
            } else if (repro.status === 'assertions-passed') {
              lines.push('');
              lines.push('\u2705 Assertions ran but buggy condition NOT found. May be intermittent or environment-specific.');
            } else if (repro.status === 'navigation-failed') {
              lines.push('');
              lines.push('\u26a0\ufe0f Navigation to target page failed. Bug may involve routing or access issues.');
            }
            if (repro.pageUrl) lines.push('**Final URL:** `' + repro.pageUrl + '`');
            lines.push('**Duration:** ' + (repro.duration || 0) + 'ms');
            lines.push('');

            if (repro.assertions && repro.assertions.length > 0) {
              lines.push('### Assertion Results');
              lines.push('');
              for (var ai = 0; ai < repro.assertions.length; ai++) {
                var a = repro.assertions[ai];
                var statusTag = a.passed ? '\u2705 PASSED' : '\u274c FAILED';
                if (a.status === 'element-not-found') statusTag = '\u26a0\ufe0f ELEMENT NOT FOUND';
                lines.push((ai + 1) + '. **' + statusTag + '** \u2014 ' + (a.description || 'assertion'));
                if (a.selector) lines.push('   - Selector: `' + a.selector + '`');
                if (a.attribute) lines.push('   - Attribute: `' + a.attribute + '`');
                if (a.expected !== undefined && a.expected !== null) lines.push('   - Expected (buggy): `' + a.expected + '`');
                if (a.actual !== undefined && a.actual !== null) lines.push('   - Actual: `' + a.actual + '`');
              }
              lines.push('');
            }

            if (repro.output) {
              var outLines = repro.output.split('\n').filter(function (l) {
                var t = l.trim();
                return t.length > 0 && t.indexOf('__REPRO_RESULT__') === -1;
              });
              if (outLines.length > 40) { outLines = outLines.slice(0, 40); outLines.push('... (truncated)'); }
              if (outLines.length > 0) {
                lines.push('### Browser Output');
                lines.push('```');
                lines.push(outLines.join('\n'));
                lines.push('```');
                lines.push('');
              }
            }

            return lines.join('\n');
          }

          // ================================================================
          //  respondWithAnalysis — cache results and respond to client
          // ================================================================

          function respondWithAnalysis(result, agentError, reproResult, reproPlan) {
            console.log('');
            console.log('[STEP] \u2705 Analysis pipeline complete');
            console.log('  Files:', result.analysis ? result.analysis.relevantFiles.length : 0);
            console.log('  Prompt:', result.prompt.length, 'chars');
            if (agentError) console.log('  \u26a0\ufe0f Agent error:', agentError);
            if (reproResult) console.log('  Reproduction:', reproResult.status || 'n/a');
            if (reproPlan) console.log('  Plan: confidence=' + reproPlan.confidence + ', questions=' + reproPlan.questions.length);

            logger.codeScanComplete(analyzeMatch[1], {
              relevantFiles: result.analysis ? result.analysis.relevantFiles : [],
              codeMatches: result.analysis ? (result.analysis.codeMatches || []) : [],
              fileContents: result.analysis ? (result.analysis.fileContents || []) : [],
              prompt: result.prompt
            }, Date.now() - _analyzeStart, analyzeUser.agentUrl);

            // Inject reproduction evidence into prompt (for /fix endpoint use)
            if (reproResult && reproResult.attempted) {
              var reproEvidence = buildReproductionEvidenceSection(reproResult);
              if (reproEvidence) {
                var taskMarker = '## What You Must Do';
                var markerIdx = result.prompt.indexOf(taskMarker);
                if (markerIdx > 0) {
                  result.prompt = result.prompt.substring(0, markerIdx) + reproEvidence + '\n' + result.prompt.substring(markerIdx);
                } else {
                  result.prompt = result.prompt + '\n' + reproEvidence;
                }
                console.log('  \uD83D\uDCCB Injected repro evidence (' + reproEvidence.length + ' chars)');
              }
            }

            // Inject reproduction screenshot into vision images
            if (reproResult && reproResult.screenshotFile) {
              try {
                var _homeDir = require('os').homedir();
                var _docsPath = require('path').join(_homeDir, 'Documents');
                if (!require('fs').existsSync(_docsPath)) _docsPath = _homeDir;
                var _ssPath = require('path').join(_docsPath, '.zoho-bug-track-logs', 'reproductions', reproResult.screenshotFile);
                if (require('fs').existsSync(_ssPath)) {
                  var _ssData = require('fs').readFileSync(_ssPath);
                  var _ssB64 = _ssData.toString('base64');
                  if (_ssB64.length < 5 * 1024 * 1024) {
                    _bugImages.push({ name: 'reproduction_screenshot.png', mimeType: 'image/png', base64: _ssB64 });
                    console.log('  \uD83D\uDCF8 Added repro screenshot to vision images');
                  }
                }
              } catch (ssErr) {
                console.log('  \u26a0\ufe0f Screenshot read error:', ssErr.message);
              }
            }

            // Cache everything for /fix and /repro-answer endpoints
            cacheAnalysis(analyzeMatch[1], userId, {
              result: result,
              bugData: bugData,
              bugImages: _bugImages,
              agentError: agentError,
              targetRoute: targetRoute,
              templateCtx: _templateCtx,
              parsedDesc: _parsedDesc,
              extraDescription: extraDescription,
              analyzeStart: _analyzeStart,
              reproResult: reproResult || null,
              reproPlan: reproPlan || null,
              componentRegistry: _componentRegistry,
              knownAutoIds: _knownAutoIds || []
            });

            console.log('  Cached \u2014 waiting for /fix');
            console.log('  Total:', ((Date.now() - _analyzeStart) / 1000).toFixed(1) + 's');
            console.log('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
            console.log('');

            var responseData = {
              prompt: result.prompt,
              analysis: result.analysis,
              bug: bugData.bug,
              agentError: agentError || null,
              bugImages: _bugImages.length,
              analysisCached: true,
              reproduction: reproResult || null
            };

            // Include reproduction plan + questions + steps for UI
            if (reproPlan) {
              responseData.reproPlan = {
                confidence: reproPlan.confidence,
                plan: reproPlan.plan,
                steps: reproPlan.steps,
                questions: reproPlan.questions,
                uncertainSelectors: reproPlan.uncertainSelectors,
                formAnalysis: reproPlan.formAnalysis || null,
                stepsCount: reproPlan.steps.length,
                hasQuestions: reproPlan.questions.length > 0
              };
            }

            sendJSON(res, 200, responseData);
          }

          // ================================================================
          //  MAIN ANALYSIS PIPELINE
          // ================================================================

          if (!analyzeUser.agentUrl) {
            // Local mode — just code scan, no reproduction
            console.log('');
            console.log('[STEP 3/4] \uD83D\uDD0E Scanning code LOCALLY in', analyzeUser.projectDir, '...');
            var _scanStart2 = Date.now();
            var localResult = fixPrompt.generatePrompt(userId, bugData, extraDescription, _parsedDesc);
            console.log('[STEP 3/4] \u2705 Local scan complete in', (Date.now() - _scanStart2) + 'ms');
            console.log('  Files:', (localResult.analysis ? localResult.analysis.relevantFiles.length : 0));
            return respondWithAnalysis(localResult, null, null, null);
          }

          // Agent mode: full pipeline
          //   1. Fetch contexts (template + component registry) in parallel
          //   2. AI generates reproduction plan (with 4-layer prompt)
          //   3. If confident: auto-run reproduction
          //   4. Code scan
          //   5. Cache & respond

          console.log('');
          console.log('[STEP 3a] \uD83D\uDD0E Fetching template context + component registry...');
          var _contextsReady = 0;
          var _knownAutoIds = [];

          function onContextReady() {
            _contextsReady++;
            if (_contextsReady < 2) return;

            console.log('[STEP 3a] \u2705 Contexts: template=' + (_templateCtx ? 'yes' : 'no') +
              ', registry=' + _componentRegistry.length + ' components');

            // No target route → skip reproduction
            if (!targetRoute) {
              console.log('[STEP 3b] \u26a0\ufe0f No target route \u2014 skipping reproduction');
              return doCodeScan(null, null);
            }

            // Build reproduction plan via AI (all 4 layers)
            console.log('[STEP 3b] \uD83E\uDDE0 Generating reproduction plan via AI...');
            var stepsPromptResult = buildInteractionStepsPrompt(
              bugData.bug.title || '',
              bugData.bug.description || '',
              _templateCtx || {},
              _componentRegistry
            );
            var stepsPrompt = stepsPromptResult.prompt;
            _knownAutoIds = stepsPromptResult.knownAutoIds;
            console.log('[STEP 3b] Prompt:', stepsPrompt.length, 'chars, known data-auto-ids:', _knownAutoIds.length);

            var copilotBridge = require('./lib/copilot-bridge-client');
            copilotBridge.checkHealth(function (hErr, hData) {
              if (!hErr && hData && hData.ok) {
                copilotBridge.analyze(stepsPrompt, aiModel, function (bErr, bResult) {
                  if (!bErr && bResult && bResult.text) {
                    var plan = parseReproductionPlan(bResult.text);
                    plan.steps = validateStepSelectors(plan.steps, _knownAutoIds);
                    console.log('[STEP 3b] \u2705 Plan: confidence=' + plan.confidence +
                      ', steps=' + plan.steps.length + ', questions=' + plan.questions.length);
                    plan.steps.forEach(function (s, i) {
                      console.log('[STEP 3b]   ' + (i + 1) + ': ' + s.action + ' ' + (s.selector || '') + ' \u2014 ' + (s.description || ''));
                    });
                    return handleReproPlan(plan);
                  }
                  console.log('[STEP 3b] \u26a0\ufe0f Copilot Bridge failed:', bErr ? bErr.message : 'empty \u2014 fallback');
                  tryStepsFallback(stepsPrompt, function (fbPlan) {
                    if (fbPlan) fbPlan.steps = validateStepSelectors(fbPlan.steps, _knownAutoIds);
                    handleReproPlan(fbPlan);
                  });
                });
              } else {
                tryStepsFallback(stepsPrompt, function (fbPlan) {
                  if (fbPlan) fbPlan.steps = validateStepSelectors(fbPlan.steps, _knownAutoIds);
                  handleReproPlan(fbPlan);
                });
              }
            });
          }

          function handleReproPlan(reproPlan) {
            if (!reproPlan || reproPlan.steps.length === 0) {
              console.log('[STEP 3c] \u26a0\ufe0f No reproduction steps \u2014 skipping to code scan');
              return doCodeScan(null, reproPlan);
            }

            // ALWAYS show the plan to user for review — never auto-run
            // User will click "Answer & Reproduce" or "Skip & Run" to trigger reproduction
            console.log('[STEP 3c] \uD83D\uDCCB Returning plan to user for review (confidence: ' + reproPlan.confidence + ')');
            console.log('[STEP 3c]   Steps: ' + reproPlan.steps.length + ', Questions: ' + reproPlan.questions.length);
            if (reproPlan.questions.length > 0) {
              reproPlan.questions.forEach(function (q) {
                console.log('[STEP 3c]   Q: ' + q.question + ' (reason: ' + (q.reason || 'n/a') + ')');
              });
            }
            doCodeScan(null, reproPlan);
          }

          function doCodeScan(reproResult, reproPlan) {
            console.log('');
            console.log('[STEP 4] \uD83D\uDD0E Scanning code via AGENT at', analyzeUser.agentUrl, '...');
            var _scanStart = Date.now();
            fixPrompt.generatePromptViaAgent(userId, bugData, analyzeUser.agentUrl, extraDescription, function (promptErr, result) {
              if (promptErr) return send500(res, 'Agent error: ' + promptErr.message);
              console.log('[STEP 4] \u2705 Agent scan complete in', (Date.now() - _scanStart) + 'ms');
              console.log('  Files:', (result.analysis ? result.analysis.relevantFiles.length : 0));
              respondWithAnalysis(result, result.agentError, reproResult || null, reproPlan || null);
            }, _templateCtx, _parsedDesc);
          }

          // ── Kick off parallel context fetches ──
          if (targetRoute) {
            agentProxy.getTemplateContext(analyzeUser.agentUrl, targetRoute).then(function (tCtx) {
              if (tCtx && tCtx.hasTemplate) {
                _templateCtx = tCtx;
                console.log('[STEP 3a] Template:', tCtx.totalTemplates, 'templates,',
                  (tCtx.routeJS || []).length, 'JS,', (tCtx.componentTemplates || []).length, 'components');
              }
              onContextReady();
            }).catch(function (e) {
              console.log('[STEP 3a] \u26a0\ufe0f Template fetch failed:', e.message);
              onContextReady();
            });
          } else {
            onContextReady();
          }

          agentProxy.getComponentRegistry(analyzeUser.agentUrl).then(function (reg) {
            if (reg && reg.components) {
              _componentRegistry = reg.components;
              console.log('[STEP 3a] Registry:', _componentRegistry.length, 'components');
            }
            onContextReady();
          }).catch(function (e) {
            console.log('[STEP 3a] \u26a0\ufe0f Registry fetch failed:', e.message);
            onContextReady();
          });

          } // end continueWithAnalysis
          // Entry point: auto-detect route then continue
          autoDetectAndContinue();
          } // end proceedAfterImages

          if (includeImages && (bugData.attachments || []).length > 0) {
            console.log('[STEP 2/6] \uD83D\uDDBC\uFE0F Downloading bug screenshots for AI vision...');
            bugService.downloadBugImages(userId, bugData.attachments, function (imgErr, images) {
              if (!imgErr && images && images.length > 0) {
                _bugImages = images;
                console.log('[STEP 2/6] \u2705 Downloaded', images.length, 'bug screenshot(s)');
              } else if (imgErr) {
                console.log('[STEP 2/6] \u26A0\uFE0F Image download error:', imgErr.message, '\u2014 continuing without images');
              }
              proceedAfterImages();
            });
          } else {
            if (!includeImages) console.log('[STEP 2/6] \uD83D\uDDBC\uFE0F Screenshots excluded by user');
            proceedAfterImages();
          }
        });
      });
      return;
    }

    // POST /api/bugs/:id/fix — send cached analysis + user instructions to AI
    var fixMatch = pathname.match(/^\/api\/bugs\/([a-zA-Z0-9_]+)\/fix$/);
    if (fixMatch && method === 'POST') {
      var githubAI_fix = require('./lib/github-ai-client');
      var claudeClient_fix = require('./lib/claude-client');
      var copilotBridge_fix = require('./lib/copilot-bridge-client');

      readBody(req, function (bodyErr, body) {
        var bugId = fixMatch[1];
        var userInstructions = (body && body.instructions) ? body.instructions : [];
        var cached = getCachedAnalysis(bugId, userId);

        if (!cached) {
          return send400(res, 'No cached analysis found for this bug. Run Analyze first.');
        }

        var fixUser = userStore.getUser(userId);
        var aiModel = fixUser.aiModel || 'claude-opus-4-6';
        var isClaude = githubAI_fix.isClaudeModel(aiModel);
        var githubToken = fixUser.githubToken || '';
        var claudeKey = fixUser.claudeApiKey || '';
        var prompt = cached.data.result.prompt;
        var bugImages = cached.data.bugImages || [];
        var _fixStart = Date.now();

        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[FIX] 🤖 Fix request received');
        console.log('  Bug ID:', bugId);
        console.log('  User instructions:', userInstructions.length);
        console.log('  AI model:', aiModel);
        console.log('  Prompt length:', prompt.length, 'chars');
        console.log('  Bug images:', bugImages.length);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Append user instructions to the prompt
        if (userInstructions.length > 0) {
          var instrSection = '\n\n## Additional Developer Instructions\n';
          instrSection += 'The developer reviewing this analysis has provided the following guidance:\n\n';
          for (var ii = 0; ii < userInstructions.length; ii++) {
            instrSection += (ii + 1) + '. ' + userInstructions[ii] + '\n';
          }
          instrSection += '\nIMPORTANT: Follow these instructions carefully. They override any conflicting assumptions.\n';

          // Insert before "## What You Must Do" if present
          var taskMarkerFix = '## What You Must Do';
          var markerIdxFix = prompt.indexOf(taskMarkerFix);
          if (markerIdxFix > 0) {
            prompt = prompt.substring(0, markerIdxFix) + instrSection + '\n' + prompt.substring(markerIdxFix);
          } else {
            prompt += instrSection;
          }
          console.log('[FIX] 📝 Appended', userInstructions.length, 'user instructions to prompt');
          console.log('  Updated prompt length:', prompt.length, 'chars');
        }

        logger.aiPromptSent(bugId, prompt, {
          model: aiModel,
          provider: 'pending',
          imageCount: bugImages.length,
          userInstructions: userInstructions.length
        });

        function sendFixResponse(aiResult) {
          console.log('');
          console.log('[FIX] ✅ AI response received!');
          console.log('  Model:', aiResult.model);
          console.log('  Response length:', aiResult.text.length, 'chars');
          console.log('  Usage:', JSON.stringify(aiResult.usage || {}));
          console.log('  Total time:', ((Date.now() - _fixStart) / 1000).toFixed(1) + 's');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          logger.aiResponseReceived(bugId, aiResult, Date.now() - _fixStart, {
            provider: aiResult._provider || 'unknown'
          });

          // Save prompt log to agent if available
          if (fixUser.agentUrl) {
            agentProxy.promptSave(fixUser.agentUrl, {
              bugId: bugId,
              bugTitle: cached.data.bugData.bug.title || '',
              bugStatus: cached.data.bugData.bug.status || '',
              prompt: prompt,
              aiModel: aiResult.model,
              userInstructions: userInstructions,
              timestamp: new Date().toISOString()
            }).catch(function (e) {
              console.log('[FIX] Prompt log save failed:', e.message);
            });
          }

          sendJSON(res, 200, {
            prompt: prompt,
            analysis: cached.data.result.analysis,
            bug: cached.data.bugData.bug,
            agentError: cached.data.agentError || null,
            bugImages: bugImages.length,
            aiFix: {
              text: aiResult.text,
              model: aiResult.model,
              usage: aiResult.usage
            }
          });
        }

        function sendFixError(errMsg) {
          console.error('[FIX] ❌ AI ERROR:', errMsg);
          logger.aiError(bugId, errMsg, { model: aiModel });
          sendJSON(res, 200, {
            prompt: prompt,
            analysis: cached.data.result.analysis,
            bug: cached.data.bugData.bug,
            agentError: cached.data.agentError || null,
            bugImages: bugImages.length,
            aiFix: null,
            aiError: errMsg
          });
        }

        // Route to AI provider
        console.log('[FIX] 🤖 Sending prompt to AI...');
        copilotBridge_fix.checkHealth(function (hErr, hData) {
          if (!hErr && hData && hData.ok) {
            console.log('[FIX] ✅ Copilot Bridge available — sending to model:', aiModel);
            copilotBridge_fix.analyze(prompt, aiModel, { images: bugImages }, function (bErr, bResult) {
              if (!bErr) return sendFixResponse(bResult);
              console.log('[FIX] ⚠️ Copilot Bridge failed:', bErr.message, '— trying fallback...');
              tryFixFallback();
            });
          } else {
            console.log('[FIX] Copilot Bridge not available — trying fallback...');
            tryFixFallback();
          }
        });

        function tryFixFallback() {
          if (isClaude) {
            if (claudeKey) {
              console.log('[FIX] 📡 Using Anthropic Direct API — model:', aiModel);
              claudeClient_fix.analyze(claudeKey, prompt, { model: aiModel, images: bugImages }, function (clErr, clResult) {
                if (!clErr) return sendFixResponse(clResult);
                sendFixError('Anthropic API: ' + clErr.message);
              });
            } else {
              sendFixError('Claude model selected but no way to reach it.\n\n' +
                '• Install the Copilot Bridge VS Code extension\n' +
                '• Or add an Anthropic API key in Settings → AI Analysis');
            }
          } else {
            if (githubToken) {
              console.log('[FIX] 📡 Using GitHub Models API — model:', aiModel);
              githubAI_fix.analyze(githubToken, prompt, { model: aiModel, images: bugImages }, function (ghErr, ghResult) {
                if (!ghErr) return sendFixResponse(ghResult);
                sendFixError('GitHub Models API: ' + ghErr.message);
              });
            } else {
              sendFixError('No GitHub token configured. Add your PAT in Settings → AI Analysis.');
            }
          }
        }
      });
      return;
    }

    // POST /api/bugs/:id/repro-answer — user answers AI questions → AI returns refined steps for REVIEW (no auto-run)
    var reproAnswerMatch = pathname.match(/^\/api\/bugs\/([a-zA-Z0-9_]+)\/repro-answer$/);
    if (reproAnswerMatch && method === 'POST') {
      var githubAI_ra = require('./lib/github-ai-client');
      var claudeClient_ra = require('./lib/claude-client');

      readBody(req, function (bodyErr, body) {
        var bugId_ra = reproAnswerMatch[1];
        var userAnswers = (body && body.answers) ? body.answers : [];
        var skipQuestions = body && body.skip === true;
        var cached_ra = getCachedAnalysis(bugId_ra, userId);

        if (!cached_ra) {
          return send400(res, 'No cached analysis. Run Analyze first.');
        }

        var raUser = userStore.getUser(userId);
        var reproPlan_ra = cached_ra.reproPlan;
        if (!reproPlan_ra || !reproPlan_ra.steps || reproPlan_ra.steps.length === 0) {
          return send400(res, 'No reproduction plan cached. Run Analyze first.');
        }

        var aiModel_ra = raUser.aiModel || 'claude-opus-4-6';
        var _raStart = Date.now();

        console.log('');
        console.log('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        console.log('[REPRO-ANSWER] Bug:', bugId_ra);
        console.log('  Answers:', userAnswers.length, '| Skip:', skipQuestions);
        console.log('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');

        if (skipQuestions || userAnswers.length === 0) {
          // Skip → return existing best-guess steps for review
          console.log('[REPRO-ANSWER] Returning original steps for review (' + reproPlan_ra.steps.length + ')');
          // Store in cache for /repro-run
          cached_ra.approvedSteps = reproPlan_ra.steps;
          sendJSON(res, 200, {
            phase: 'review',
            steps: reproPlan_ra.steps,
            formAnalysis: reproPlan_ra.formAnalysis || null,
            message: 'Review the steps below. Edit any step, then click Run Reproduction.'
          });
        } else {
          // Build a refinement prompt with user answers
          console.log('[REPRO-ANSWER] Refining steps with', userAnswers.length, 'answers...');
          var refineLines = [];
          refineLines.push('You previously generated a reproduction plan for a bug and had questions.');
          refineLines.push('The user has now answered your questions. Generate REFINED Puppeteer interaction steps.');
          refineLines.push('');
          refineLines.push('## Original Plan');
          refineLines.push('Steps: ' + reproPlan_ra.steps.length);
          refineLines.push('```json');
          refineLines.push(JSON.stringify(reproPlan_ra.steps, null, 2));
          refineLines.push('```');
          refineLines.push('');
          if (reproPlan_ra.formAnalysis) {
            refineLines.push('## Form Analysis');
            refineLines.push('```json');
            refineLines.push(JSON.stringify(reproPlan_ra.formAnalysis, null, 2));
            refineLines.push('```');
            refineLines.push('');
          }
          refineLines.push('## Your Questions & User Answers');
          userAnswers.forEach(function (qa) {
            refineLines.push('**Q: ' + (qa.question || qa.id) + '**');
            refineLines.push('A: ' + (qa.answer || '(no answer)'));
            refineLines.push('');
          });
          refineLines.push('## Task');
          refineLines.push('Using the user answers, generate CORRECTED interaction steps.');
          refineLines.push('Fix selectors, add missing steps, adjust form values, or modify the flow based on the answers.');
          refineLines.push('');
          refineLines.push('If the user confirmed a selector → keep it.');
          refineLines.push('If the user provided a new selector or value → use it.');
          refineLines.push('If the user said a field is mandatory → ensure a type step fills it.');
          refineLines.push('');
          refineLines.push('IMPORTANT: Every step with a selector MUST include:');
          refineLines.push('- "fallbackSelectors": array of 2-4 alternative CSS selectors');
          refineLines.push('- "textContent": the visible text of the target element (for text-based finding)');
          refineLines.push('');
          // Include data-auto-id allowlist if available
          var raAutoIds = cached_ra.knownAutoIds || [];
          if (raAutoIds.length > 0) {
            refineLines.push('## STRICT data-auto-id ALLOWLIST');
            refineLines.push('ONLY these data-auto-id values exist in the codebase. NEVER invent new ones:');
            refineLines.push(raAutoIds.map(function (id) { return '  - `[data-auto-id="' + id + '"]`'; }).join('\n'));
            refineLines.push('');
            refineLines.push('If an element is NOT in this list, it does NOT have a data-auto-id. Use CSS class selectors instead.');
            refineLines.push('');
          }
          refineLines.push('Return ONLY a valid JSON array of steps. No markdown fences.');
          var refinePrompt = refineLines.join('\n');

          var copilotBridge_ra = require('./lib/copilot-bridge-client');
          copilotBridge_ra.checkHealth(function (hErr, hData) {
            function parseStepsArray(text) {
              if (!text) return [];
              var c = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
              try {
                var m = c.match(/\[[\s\S]*\]/);
                if (m) {
                  var arr = JSON.parse(m[0]);
                  if (Array.isArray(arr)) return arr.filter(function (s) { return s && s.action; });
                }
              } catch (e) { /* ignore */ }
              return [];
            }

            function gotRefinedSteps(steps) {
              var finalSteps = (steps && steps.length > 0) ? steps : reproPlan_ra.steps;
              // Validate data-auto-ids against known allowlist
              var cachedAutoIds = cached_ra.knownAutoIds || [];
              if (cachedAutoIds.length > 0) {
                finalSteps = validateStepSelectors(finalSteps, cachedAutoIds);
              }
              console.log('[REPRO-ANSWER] \u2705 Returning', finalSteps.length, 'refined steps for review');
              // Store refined steps in cache for /repro-run
              cached_ra.approvedSteps = finalSteps;
              // Also update the reproPlan in cache
              cached_ra.reproPlan.steps = finalSteps;
              sendJSON(res, 200, {
                phase: 'review',
                steps: finalSteps,
                formAnalysis: reproPlan_ra.formAnalysis || null,
                refined: steps && steps.length > 0,
                message: 'AI refined the steps based on your answers. Review and edit, then click Run Reproduction.'
              });
              console.log('[REPRO-ANSWER] Done in', ((Date.now() - _raStart) / 1000).toFixed(1) + 's');
            }

            function tryRefineFallback() {
              var isCl = githubAI_ra.isClaudeModel(aiModel_ra);
              if (isCl && raUser.claudeApiKey) {
                claudeClient_ra.analyze(raUser.claudeApiKey, refinePrompt, { model: aiModel_ra }, function (e, r) {
                  gotRefinedSteps((!e && r && r.text) ? parseStepsArray(r.text) : []);
                });
              } else if (!isCl && raUser.githubToken) {
                githubAI_ra.analyze(raUser.githubToken, refinePrompt, { model: aiModel_ra }, function (e, r) {
                  gotRefinedSteps((!e && r && r.text) ? parseStepsArray(r.text) : []);
                });
              } else {
                gotRefinedSteps([]);
              }
            }

            if (!hErr && hData && hData.ok) {
              copilotBridge_ra.analyze(refinePrompt, aiModel_ra, function (bErr, bRes) {
                if (!bErr && bRes && bRes.text) {
                  return gotRefinedSteps(parseStepsArray(bRes.text));
                }
                tryRefineFallback();
              });
            } else {
              tryRefineFallback();
            }
          });
        }
      });
      return;
    }

    // POST /api/bugs/:id/repro-refine — user provides feedback on steps, AI adjusts
    var reproRefineMatch = pathname.match(/^\/api\/bugs\/([a-zA-Z0-9_]+)\/repro-refine$/);
    if (reproRefineMatch && method === 'POST') {
      var githubAI_rf = require('./lib/github-ai-client');
      var claudeClient_rf = require('./lib/claude-client');

      readBody(req, function (bodyErr, body) {
        var bugId_rf = reproRefineMatch[1];
        var currentSteps = (body && body.steps) ? body.steps : [];
        var userFeedback = (body && body.feedback) ? body.feedback : '';
        var cached_rf = getCachedAnalysis(bugId_rf, userId);

        if (!cached_rf) {
          return send400(res, 'No cached analysis. Run Analyze first.');
        }

        var rfUser = userStore.getUser(userId);
        var aiModel_rf = rfUser.aiModel || 'claude-opus-4-6';
        var _rfStart = Date.now();

        console.log('');
        console.log('[REPRO-REFINE] Bug:', bugId_rf);
        console.log('  Current steps:', currentSteps.length, '| Feedback:', userFeedback.length, 'chars');

        var rfLines = [];
        rfLines.push('You are refining Puppeteer reproduction steps for a bug based on user feedback.');
        rfLines.push('');
        rfLines.push('## Bug');
        rfLines.push('Title: ' + ((cached_rf.bugData && cached_rf.bugData.bug) ? cached_rf.bugData.bug.title : 'Unknown'));
        rfLines.push('');
        rfLines.push('## Current Steps');
        rfLines.push('```json');
        rfLines.push(JSON.stringify(currentSteps, null, 2));
        rfLines.push('```');
        rfLines.push('');
        rfLines.push('## User Feedback');
        rfLines.push(userFeedback);
        rfLines.push('');
        rfLines.push('## Task');
        rfLines.push('Adjust the steps based on the user feedback.');
        rfLines.push('The user may want to: change selectors, add steps, remove steps, change values, reorder steps, etc.');
        rfLines.push('Apply the feedback and return the COMPLETE CORRECTED steps array.');
        rfLines.push('');
        rfLines.push('IMPORTANT: Every step with a selector MUST include:');
        rfLines.push('- "fallbackSelectors": array of 2-4 alternative CSS selectors');
        rfLines.push('- "textContent": the visible text of the target element (for text-based finding)');
        rfLines.push('');
        // Include data-auto-id allowlist if available
        var rfAutoIds = cached_rf.knownAutoIds || [];
        if (rfAutoIds.length > 0) {
          rfLines.push('## STRICT data-auto-id ALLOWLIST');
          rfLines.push('ONLY these data-auto-id values exist in the codebase. NEVER invent new ones:');
          rfLines.push(rfAutoIds.map(function (id) { return '  - `[data-auto-id="' + id + '"]`'; }).join('\n'));
          rfLines.push('');
          rfLines.push('If an element is NOT in this list, it does NOT have a data-auto-id. Use CSS class selectors instead.');
          rfLines.push('');
        }
        rfLines.push('Return ONLY a valid JSON array of steps. No markdown fences, no explanation.');
        var rfPrompt = rfLines.join('\n');

        var copilotBridge_rf = require('./lib/copilot-bridge-client');
        copilotBridge_rf.checkHealth(function (hErr, hData) {
          function parseRfSteps(text) {
            if (!text) return [];
            var c = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
            try {
              var m = c.match(/\[[\s\S]*\]/);
              if (m) {
                var arr = JSON.parse(m[0]);
                if (Array.isArray(arr)) return arr.filter(function (s) { return s && s.action; });
              }
            } catch (e) { /* ignore */ }
            return [];
          }

          function gotRfSteps(steps) {
            var finalSteps = (steps && steps.length > 0) ? steps : currentSteps;
            // Validate data-auto-ids against known allowlist
            var rfCachedAutoIds = cached_rf.knownAutoIds || [];
            if (rfCachedAutoIds.length > 0) {
              finalSteps = validateStepSelectors(finalSteps, rfCachedAutoIds);
            }
            console.log('[REPRO-REFINE] \u2705 Returning', finalSteps.length, 'refined steps');
            cached_rf.approvedSteps = finalSteps;
            if (cached_rf.reproPlan) cached_rf.reproPlan.steps = finalSteps;
            sendJSON(res, 200, {
              phase: 'review',
              steps: finalSteps,
              refined: steps && steps.length > 0,
              message: 'Steps updated based on your feedback. Review and run when ready.'
            });
            console.log('[REPRO-REFINE] Done in', ((Date.now() - _rfStart) / 1000).toFixed(1) + 's');
          }

          function tryRfFallback() {
            var isCl = githubAI_rf.isClaudeModel(aiModel_rf);
            if (isCl && rfUser.claudeApiKey) {
              claudeClient_rf.analyze(rfUser.claudeApiKey, rfPrompt, { model: aiModel_rf }, function (e, r) {
                gotRfSteps((!e && r && r.text) ? parseRfSteps(r.text) : []);
              });
            } else if (!isCl && rfUser.githubToken) {
              githubAI_rf.analyze(rfUser.githubToken, rfPrompt, { model: aiModel_rf }, function (e, r) {
                gotRfSteps((!e && r && r.text) ? parseRfSteps(r.text) : []);
              });
            } else {
              gotRfSteps([]);
            }
          }

          if (!hErr && hData && hData.ok) {
            copilotBridge_rf.analyze(rfPrompt, aiModel_rf, function (bErr, bRes) {
              if (!bErr && bRes && bRes.text) {
                return gotRfSteps(parseRfSteps(bRes.text));
              }
              tryRfFallback();
            });
          } else {
            tryRfFallback();
          }
        });
      });
      return;
    }

    // POST /api/bugs/:id/repro-run — user approved steps, now execute Puppeteer reproduction
    var reproRunMatch = pathname.match(/^\/api\/bugs\/([a-zA-Z0-9_]+)\/repro-run$/);
    if (reproRunMatch && method === 'POST') {
      readBody(req, function (bodyErr, body) {
        var bugId_run = reproRunMatch[1];
        var stepsToRun = (body && body.steps) ? body.steps : [];
        var cached_run = getCachedAnalysis(bugId_run, userId);

        if (!cached_run) {
          return send400(res, 'No cached analysis. Run Analyze first.');
        }

        var runUser = userStore.getUser(userId);
        if (!runUser.agentUrl) {
          return send400(res, 'Agent URL not configured — reproduction requires a running agent.');
        }

        // Use provided steps or fall back to cached approved steps
        var steps = (stepsToRun.length > 0) ? stepsToRun : (cached_run.approvedSteps || (cached_run.reproPlan ? cached_run.reproPlan.steps : []));
        if (!steps || steps.length === 0) {
          return send400(res, 'No reproduction steps to run.');
        }

        var devServerUrl_run = runUser.devServerUrl || '';
        var targetRoute_run = cached_run.targetRoute || '';
        var bugTitle_run = (cached_run.bugData && cached_run.bugData.bug) ? cached_run.bugData.bug.title || '' : '';
        var bugDesc_run = (cached_run.bugData && cached_run.bugData.bug) ? cached_run.bugData.bug.description || '' : '';
        var _runStart = Date.now();

        console.log('');
        console.log('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
        console.log('[REPRO-RUN] Bug:', bugId_run);
        console.log('  Steps:', steps.length, '| User approved');
        console.log('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');

        agentProxy.playwrightGenerate(
          runUser.agentUrl, bugId_run,
          bugTitle_run, bugDesc_run,
          devServerUrl_run,
          runUser.testUsername || '', runUser.testPassword || '',
          targetRoute_run, steps
        ).then(function (genResult) {
          console.log('[REPRO-RUN] \u2705 Script generated:', genResult.testFile);
          console.log('[REPRO-RUN] \uD83C\uDFC3 Running...');
          agentProxy.playwrightRun(runUser.agentUrl, genResult.testFile).then(function (runResult) {
            var bugConfirmed = !!runResult.bugConfirmed;
            var assertions = runResult.assertions || [];
            var navigationOk = runResult.navigationOk !== false;
            var reproduced = bugConfirmed || !runResult.passed;
            var status = 'not-reproduced';
            if (bugConfirmed) status = 'bug-confirmed';
            else if (!navigationOk) { status = 'navigation-failed'; reproduced = false; }
            else if (!runResult.passed) status = 'test-errors';
            else if (assertions.length > 0) status = 'assertions-passed';
            else status = 'no-assertions';

            var reproResult = {
              attempted: true, passed: runResult.passed, reproduced: reproduced,
              bugConfirmed: bugConfirmed, assertions: assertions, navigationOk: navigationOk,
              pageUrl: runResult.pageUrl || null, status: status, output: runResult.output,
              duration: runResult.duration, testFile: genResult.testFile,
              screenshotFile: runResult.screenshotFile, interactionSteps: steps.length,
              stepResults: runResult.stepResults || [],
              domSnapshot: runResult.domSnapshot || null
            };

            console.log('[REPRO-RUN] Result: status=' + status + ', ' + (runResult.duration || 0) + 'ms');

            // Update cache
            cached_run.reproResult = reproResult;

            // Inject reproduction evidence into prompt
            if (reproResult.attempted && cached_run.result && cached_run.result.prompt) {
              var evidenceLines = [];
              evidenceLines.push('## \uD83E\uDDEA Reproduction Evidence (Automated Browser Test)');
              evidenceLines.push('');
              evidenceLines.push('**Status:** ' + reproResult.status);
              if (reproResult.bugConfirmed) evidenceLines.push('\u26a0\ufe0f **BUG CONFIRMED**');
              if (reproResult.pageUrl) evidenceLines.push('**Final URL:** `' + reproResult.pageUrl + '`');
              evidenceLines.push('**Duration:** ' + (reproResult.duration || 0) + 'ms');
              if (reproResult.assertions && reproResult.assertions.length > 0) {
                evidenceLines.push('');
                evidenceLines.push('### Assertions');
                reproResult.assertions.forEach(function (a, i) {
                  var st = a.passed ? '\u2705' : '\u274c';
                  if (a.status === 'element-not-found') st = '\u26a0\ufe0f';
                  evidenceLines.push((i + 1) + '. ' + st + ' ' + (a.description || 'assertion'));
                  if (a.selector) evidenceLines.push('   - Selector: `' + a.selector + '`');
                  if (a.expected !== undefined) evidenceLines.push('   - Expected (buggy): `' + a.expected + '`');
                  if (a.actual !== undefined) evidenceLines.push('   - Actual: `' + a.actual + '`');
                });
              }
              var evidence = evidenceLines.join('\n');
              var prompt = cached_run.result.prompt;
              var tm = '## What You Must Do';
              var mi = prompt.indexOf(tm);
              if (mi > 0) {
                cached_run.result.prompt = prompt.substring(0, mi) + evidence + '\n' + prompt.substring(mi);
              }
            }

            console.log('[REPRO-RUN] \u2705 Done in', ((Date.now() - _runStart) / 1000).toFixed(1) + 's');
            sendJSON(res, 200, { reproduction: reproResult });
          }).catch(function (runErr) {
            console.log('[REPRO-RUN] \u26a0\ufe0f Run failed:', runErr.message);
            sendJSON(res, 200, { reproduction: { attempted: true, passed: false, reproduced: false, error: runErr.message } });
          });
        }).catch(function (genErr) {
          console.log('[REPRO-RUN] \u26a0\ufe0f Generate failed:', genErr.message);
          sendJSON(res, 200, { reproduction: { attempted: false, error: genErr.message } });
        });
      });
      return;
    }

    // POST /api/bugs/:id/verify — re-run Playwright test to verify a fix
    var verifyMatch = pathname.match(/^\/api\/bugs\/([a-zA-Z0-9_]+)\/verify$/);
    if (verifyMatch && method === 'POST') {
      var verifyUser = userStore.getUser(userId);
      if (!verifyUser.agentUrl) {
        return send400(res, 'Agent URL not configured — bug verification requires a running agent.');
      }
      console.log('[verify] Bug:', verifyMatch[1], 'userId:', userId);
      agentProxy.playwrightVerify(verifyUser.agentUrl, verifyMatch[1]).then(function (result) {
        console.log('[verify] Result — passed:', result.passed, 'duration:', result.duration + 'ms');
        sendJSON(res, 200, result);
      }).catch(function (err) {
        console.error('[verify] Error:', err.message);
        send500(res, 'Verification failed: ' + err.message);
      });
      return;
    }

    // GET /api/bugs/:id/prompt-log — load saved prompt log from agent
    var promptLogMatch = pathname.match(/^\/api\/bugs\/([a-zA-Z0-9_]+)\/prompt-log$/);
    if (promptLogMatch && method === 'GET') {
      var plUser = userStore.getUser(userId);
      if (!plUser.agentUrl) {
        return sendJSON(res, 200, { found: false, error: 'No agent configured' });
      }
      agentProxy.promptLoad(plUser.agentUrl, promptLogMatch[1]).then(function (data) {
        sendJSON(res, 200, data);
      }).catch(function (err) {
        sendJSON(res, 200, { found: false, error: err.message });
      });
      return;
    }

    // POST /api/preview-diff — preview what changes will be applied (no write)
    if (pathname === '/api/preview-diff' && method === 'POST') {
      readBody(req, function (bodyErr, body) {
        if (bodyErr) return send400(res, bodyErr.message);
        if (!body.path || !body.code) return send400(res, 'Missing path or code');
        var pdUser = userStore.getUser(userId);
        var projectDir = pdUser.projectDir;
        if (!projectDir) return send400(res, 'No project directory configured');

        var filePath = path.resolve(projectDir, body.path);
        if (filePath.indexOf(path.resolve(projectDir)) !== 0)
          return send400(res, 'Path outside project');

        // Read the original file
        var originalText = '';
        var fileExists = fs.existsSync(filePath);
        if (fileExists) {
          try { originalText = fs.readFileSync(filePath, 'utf-8'); }
          catch (e) { return send500(res, 'Cannot read file: ' + e.message); }
        }

        // Compute the smart merge result (without writing)
        var mergeResult = patchUtils.applySmartMerge(originalText, body.code, {
          fileName: body.path
        });

        sendJSON(res, 200, {
          file: body.path,
          fileExists: fileExists,
          originalLines: originalText.split('\n').length,
          newLines: mergeResult.result.split('\n').length,
          strategy: mergeResult.strategy,
          diff: mergeResult.diff,
          hunks: mergeResult.hunks,
          applied: mergeResult.applied,
          failed: mergeResult.failed,
          details: mergeResult.details,
          success: mergeResult.success
        });
      });
      return;
    }

    // POST /api/apply-patch — smart patch-based file modification with backup
    if (pathname === '/api/apply-patch' && method === 'POST') {
      readBody(req, function (bodyErr, body) {
        if (bodyErr) return send400(res, bodyErr.message);
        if (!body.path || !body.code) return send400(res, 'Missing path or code');
        var apUser = userStore.getUser(userId);
        var projectDir = apUser.projectDir;

        if (apUser.agentUrl) {
          // For agent-based users, proxy to the agent's new patch endpoint
          agentProxy.applyPatch(apUser.agentUrl, body.path, body.code, body.force).then(function (data) {
            sendJSON(res, 200, data);
          }).catch(function (err) { send500(res, 'Agent error: ' + err.message); });
          return;
        }

        if (!projectDir) return send400(res, 'No project directory configured');

        var filePath = path.resolve(projectDir, body.path);
        if (filePath.indexOf(path.resolve(projectDir)) !== 0)
          return send400(res, 'Path outside project');

        // Read original file
        var originalText = '';
        var fileExists = fs.existsSync(filePath);
        if (fileExists) {
          try { originalText = fs.readFileSync(filePath, 'utf-8'); }
          catch (e) { return send500(res, 'Cannot read file: ' + e.message); }
        }

        // Compute smart merge
        var mergeResult = patchUtils.applySmartMerge(originalText, body.code, {
          fileName: body.path
        });

        // If merge failed and force is not set, return the diff for review
        if (!mergeResult.success && !body.force) {
          return sendJSON(res, 200, {
            success: false,
            needsReview: true,
            file: body.path,
            strategy: mergeResult.strategy,
            diff: mergeResult.diff,
            hunks: mergeResult.hunks,
            applied: mergeResult.applied,
            failed: mergeResult.failed,
            details: mergeResult.details
          });
        }

        // Create backup before writing
        var backupPath = null;
        if (fileExists) {
          try { backupPath = patchUtils.createBackup(projectDir, body.path); }
          catch (e) { console.error('[patch] Backup failed:', e.message); }
        }

        // Write the merged result
        try {
          fs.writeFileSync(filePath, mergeResult.result, 'utf-8');
          logger.patchOperation('apply', body.path, {
            strategy: mergeResult.strategy,
            hunksApplied: mergeResult.applied,
            hunksTotal: mergeResult.hunks,
            backupPath: backupPath || ''
          });
          sendJSON(res, 200, {
            success: true,
            file: body.path,
            strategy: mergeResult.strategy,
            diff: mergeResult.diff,
            hunks: mergeResult.hunks,
            applied: mergeResult.applied,
            failed: mergeResult.failed,
            details: mergeResult.details,
            backup: backupPath ? true : false
          });
        } catch (e) {
          send500(res, 'Write failed: ' + e.message);
        }
      });
      return;
    }

    // POST /api/revert-file — restore a file from its backup
    if (pathname === '/api/revert-file' && method === 'POST') {
      readBody(req, function (bodyErr, body) {
        if (bodyErr) return send400(res, bodyErr.message);
        if (!body.path) return send400(res, 'Missing path');
        var rvUser = userStore.getUser(userId);
        if (!rvUser.projectDir) return send400(res, 'No project directory configured');

        var result = patchUtils.restoreFromBackup(rvUser.projectDir, body.path);
        logger.patchOperation('revert', body.path, result);
        if (result.restored) {
          sendJSON(res, 200, { success: true, file: body.path, message: 'Restored from backup' });
        } else {
          sendJSON(res, 200, { success: false, error: result.error });
        }
      });
      return;
    }

    // POST /api/write-file — legacy direct write (kept for compatibility, now with backup)
    if (pathname === '/api/write-file' && method === 'POST') {
      readBody(req, function (bodyErr, body) {
        if (bodyErr) return send400(res, bodyErr.message);
        var wfUser = userStore.getUser(userId);
        if (wfUser.agentUrl) {
          agentProxy.writeFile(wfUser.agentUrl, body.path, body.content).then(function (data) {
            sendJSON(res, 200, data);
          }).catch(function (err) { send500(res, 'Agent error: ' + err.message); });
        } else if (wfUser.projectDir) {
          var wfPath = path.resolve(wfUser.projectDir, body.path);
          if (wfPath.indexOf(path.resolve(wfUser.projectDir)) !== 0)
            return send400(res, 'Path outside project');
          // Create backup before overwriting
          try { patchUtils.createBackup(wfUser.projectDir, body.path); }
          catch (e) { console.error('[write-file] Backup failed:', e.message); }
          try {
            fs.writeFileSync(wfPath, body.content || '', 'utf-8');
            sendJSON(res, 200, { success: true, file: body.path });
          } catch (e) { send500(res, 'Write failed: ' + e.message); }
        } else {
          send400(res, 'No project directory configured');
        }
      });
      return;
    }

    // GET /api/git/status
    if (pathname === '/api/git/status' && method === 'GET') {
      var gitUser = userStore.getUser(userId);
      if (gitUser.agentUrl) {
        agentProxy.gitStatus(gitUser.agentUrl).then(function (data) {
          sendJSON(res, 200, data);
        }).catch(function (err) { send500(res, 'Agent error: ' + err.message); });
      } else if (gitUser.projectDir) {
        var cp = require('child_process');
        cp.exec('git status --porcelain', { cwd: gitUser.projectDir, maxBuffer: 5*1024*1024 }, function (err, stdout) {
          if (err) return send500(res, err.message);
          var files = (stdout||'').trim().split('\n').filter(Boolean).map(function (line) {
            var st = line.substring(0,2).trim();
            var f = line.substring(3);
            var label = 'modified';
            if (st === '??') label = 'untracked';
            else if (st === 'A') label = 'added';
            else if (st === 'D') label = 'deleted';
            else if (st === 'R') label = 'renamed';
            return { file: f, status: st, label: label };
          });
          cp.exec('git rev-parse --abbrev-ref HEAD', { cwd: gitUser.projectDir }, function (bErr, branch) {
            sendJSON(res, 200, { branch: (branch||'').trim() || 'unknown', files: files });
          });
        });
      } else {
        send400(res, 'No project directory configured');
      }
      return;
    }

    // GET /api/git/diff?files=path1,path2 — optionally filter diff to specific files
    if (pathname === '/api/git/diff' && method === 'GET') {
      var diffUser = userStore.getUser(userId);
      var diffFiles = query.files ? decodeURIComponent(query.files).split(',').filter(Boolean) : [];
      if (diffUser.agentUrl) {
        agentProxy.gitDiff(diffUser.agentUrl, diffFiles).then(function (data) {
          sendJSON(res, 200, data);
        }).catch(function (err) { send500(res, 'Agent error: ' + err.message); });
      } else if (diffUser.projectDir) {
        var cpDiff = require('child_process');
        var fileSuffix = '';
        if (diffFiles.length > 0) {
          fileSuffix = ' -- ' + diffFiles.map(function (f) { return '"' + f + '"'; }).join(' ');
        }
        cpDiff.exec('git diff HEAD' + fileSuffix, { cwd: diffUser.projectDir, maxBuffer: 5*1024*1024 }, function (err, stdout) {
          if (err) {
            cpDiff.exec('git diff --cached' + fileSuffix, { cwd: diffUser.projectDir, maxBuffer: 5*1024*1024 }, function (err2, stdout2) {
              if (err2) return send500(res, err2.message);
              sendJSON(res, 200, { diff: (stdout2||'').trim() });
            });
            return;
          }
          sendJSON(res, 200, { diff: (stdout||'').trim() });
        });
      } else {
        send400(res, 'No project directory configured');
      }
      return;
    }

    // POST /api/git/commit
    if (pathname === '/api/git/commit' && method === 'POST') {
      readBody(req, function (bodyErr, body) {
        if (bodyErr) return send400(res, bodyErr.message);
        var gitUser2 = userStore.getUser(userId);
        if (gitUser2.agentUrl) {
          agentProxy.gitCommit(gitUser2.agentUrl, body.message, body.files).then(function (data) {
            sendJSON(res, 200, data);
          }).catch(function (err) { send500(res, 'Agent error: ' + err.message); });
        } else if (gitUser2.projectDir) {
          var cp2 = require('child_process');
          var stageCmd = (body.files && body.files.length > 0)
            ? 'git add -- ' + body.files.map(function(f){ return '"'+f+'"'; }).join(' ')
            : 'git add -A';
          cp2.exec(stageCmd, { cwd: gitUser2.projectDir }, function (stageErr) {
            if (stageErr) return send500(res, 'Stage failed: ' + stageErr.message);
            var msg = (body.message || '').replace(/"/g, '\\"');
            cp2.exec('git commit --no-verify -m "' + msg + '"', { cwd: gitUser2.projectDir, maxBuffer: 5*1024*1024 }, function (cErr, stdout, stderr) {
              if (cErr) {
                if (((stderr||'')+(stdout||'')).indexOf('nothing to commit') !== -1)
                  return sendJSON(res, 200, { success: false, message: 'Nothing to commit' });
                return send500(res, 'Commit failed: ' + (stderr || cErr.message));
              }
              sendJSON(res, 200, { success: true, message: (stdout||'').trim() });
            });
          });
        } else {
          send400(res, 'No project directory configured');
        }
      });
      return;
    }

    // GET /api/milestones
    if (pathname === '/api/milestones' && method === 'GET') {
      bugService.listMilestones(userId, function (err, data) {
        if (err) return send500(res, err.message);
        sendJSON(res, 200, data);
      });
      return;
    }

    // GET /api/search?q=...
    if (pathname === '/api/search' && method === 'GET') {
      var searchUser = userStore.getUser(userId);
      var q = query.q || '';
      if (!q) return send400(res, 'Missing query parameter ?q=');

      if (searchUser.agentUrl) {
        agentProxy.searchFiles(searchUser.agentUrl, q).then(function (data) {
          sendJSON(res, 200, data);
        }).catch(function (err) {
          send500(res, 'Agent error: ' + err.message);
        });
      } else {
        if (!searchUser.projectDir) return send400(res, 'No project directory configured');
        var results = codeAnalyzer.searchFiles(searchUser.projectDir, q, {
          extensions: searchUser.fileExtensions,
          excludeDirs: searchUser.excludeDirs
        });
        sendJSON(res, 200, { files: results });
      }
      return;
    }

    // GET /api/grep?q=...
    if (pathname === '/api/grep' && method === 'GET') {
      var grepUser = userStore.getUser(userId);
      var gq = query.q || '';
      if (!gq) return send400(res, 'Missing query parameter ?q=');

      if (grepUser.agentUrl) {
        agentProxy.grepFiles(grepUser.agentUrl, gq, query.regex === '1').then(function (data) {
          sendJSON(res, 200, data);
        }).catch(function (err) {
          send500(res, 'Agent error: ' + err.message);
        });
      } else {
        if (!grepUser.projectDir) return send400(res, 'No project directory configured');
        var gResults = codeAnalyzer.grepFiles(grepUser.projectDir, gq, {
          extensions: grepUser.fileExtensions,
          excludeDirs: grepUser.excludeDirs,
          isRegex: query.regex === '1'
        });
        sendJSON(res, 200, { matches: gResults });
      }
      return;
    }

    // GET /api/read-file?path=...
    if (pathname === '/api/read-file' && method === 'GET') {
      var rfUser = userStore.getUser(userId);
      var filePath = query.path || '';
      if (!filePath) return send400(res, 'Missing ?path=');
      var startLine = query.start ? parseInt(query.start, 10) : undefined;
      var endLine = query.end ? parseInt(query.end, 10) : undefined;

      if (rfUser.agentUrl) {
        agentProxy.readFile(rfUser.agentUrl, filePath, startLine, endLine).then(function (data) {
          sendJSON(res, 200, data);
        }).catch(function (err) {
          send500(res, 'Agent error: ' + err.message);
        });
      } else {
        if (!rfUser.projectDir) return send400(res, 'No project directory configured');
        var fileResult = codeAnalyzer.readFile(rfUser.projectDir, filePath, startLine, endLine);
        if (fileResult.error) return send400(res, fileResult.error);
        sendJSON(res, 200, fileResult);
      }
      return;
    }

    // ── Log Viewer API ──────────────────────────────────────

    // GET /api/logs — list available log files
    if (pathname === '/api/logs' && method === 'GET') {
      var logList = logger.listLogs();
      sendJSON(res, 200, logList);
      return;
    }

    // GET /api/logs/query?type=session|daily&id=xxx&level=INFO&category=AI_PROMPT&bugId=xxx&search=xxx&limit=200&offset=0
    if (pathname === '/api/logs/query' && method === 'GET') {
      var logType = query.type || 'daily';
      var logId = query.id || '';
      if (!logId) {
        // Default to today's daily log
        var d = new Date();
        logId = d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate();
      }
      var logResult = logger.queryLogs(logType, logId, {
        level: query.level || '',
        category: query.category || '',
        bugId: query.bugId || '',
        search: query.search || '',
        limit: query.limit || '200',
        offset: query.offset || '0'
      });
      sendJSON(res, 200, logResult);
      return;
    }

    // GET /api/logs/prompts/:bugId — list prompt files for a bug
    var promptListMatch = pathname.match(/^\/api\/logs\/prompts\/([a-zA-Z0-9_]+)$/);
    if (promptListMatch && method === 'GET') {
      var promptBugId = promptListMatch[1];
      var files = logger.listPromptFiles(promptBugId);
      // Enrich with bug title from logs metadata
      var logsList = logger.listLogs();
      var bugMeta = (logsList.promptLogs || []).filter(function (p) { return p.bugId === promptBugId; })[0];
      sendJSON(res, 200, {
        bugId: promptBugId,
        title: bugMeta ? bugMeta.title : '',
        folder: bugMeta ? bugMeta.folder : promptBugId,
        files: files
      });
      return;
    }

    // GET /api/logs/prompts/:bugId/:fileName — read a specific prompt/response file
    var promptFileMatch = pathname.match(/^\/api\/logs\/prompts\/([a-zA-Z0-9_]+)\/(.+)$/);
    if (promptFileMatch && method === 'GET') {
      var content = logger.readPromptFile(promptFileMatch[1], decodeURIComponent(promptFileMatch[2]));
      if (content === null) return sendJSON(res, 404, { error: 'File not found' });
      sendJSON(res, 200, { bugId: promptFileMatch[1], file: promptFileMatch[2], content: content });
      return;
    }

    // GET /api/logs/session — get current session info
    if (pathname === '/api/logs/session' && method === 'GET') {
      var sStats = logger.getSessionStats();
      sendJSON(res, 200, {
        sessionId: logger.getSessionId(),
        startedAt: sStats.startedAt || null,
        stats: sStats,
        logRoot: logger.getLogRoot()
      });
      return;
    }

    // Not found API
    sendJSON(res, 404, { error: 'API endpoint not found: ' + pathname });
    return;
  }

  // ── Static files ──

  if (pathname === '/' || pathname === '/index.html') {
    serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  // Serve from public/
  var safePath = pathname.replace(/\.\./g, '');
  var staticPath = path.join(PUBLIC_DIR, safePath);
  if (fs.existsSync(staticPath)) {
    serveStatic(res, staticPath);
    return;
  }

  // SPA fallback — serve index.html for unrecognized paths
  serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
}

// ── start server ─────────────────────────────────────────

// Start logging session before server starts
logger.startSession({ component: 'server', port: PORT });

// Graceful shutdown: end logging session
process.on('SIGINT', function () {
  logger.info('SYSTEM', 'Server shutting down (SIGINT)');
  logger.endSession();
  process.exit(0);
});
process.on('SIGTERM', function () {
  logger.info('SYSTEM', 'Server shutting down (SIGTERM)');
  logger.endSession();
  process.exit(0);
});

var server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', function () {
  var os = require('os');
  var interfaces = os.networkInterfaces();
  var addresses = [];
  Object.keys(interfaces).forEach(function (name) {
    interfaces[name].forEach(function (iface) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    });
  });

  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║        Zoho Bug Tracker — Per-User Edition       ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Server running at:                              ║');
  console.log('║    http://localhost:' + PORT + '                          ║');
  addresses.forEach(function (addr) {
    var url = 'http://' + addr + ':' + PORT;
    var padded = url;
    while (padded.length < 42) padded += ' ';
    console.log('║    ' + padded + '    ║');
  });
  console.log('║                                                  ║');
  console.log('║  Share any network URL above with your team.     ║');
  console.log('║  Each person runs agent.js on their machine.     ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  logger.info('SYSTEM', 'Server started successfully', { port: PORT, addresses: addresses, logRoot: logger.getLogRoot() });
});
