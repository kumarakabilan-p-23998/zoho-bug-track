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

var PORT = envConfig.PORT;
var PUBLIC_DIR = path.join(__dirname, 'public');

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
    zohoAuth.exchangeCode(code, function (err, tokenData) {
      if (err) {
        console.error('TOKEN EXCHANGE FAILED:', err.message);
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

        // If this is a fresh user (no projectDir/agentUrl), try to inherit settings
        // from a previous user with the same name or ZUID
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
        console.log('');
        console.log('[STEP 2/6] 🔍 Fetching bug details from Zoho...');
        var _analyzeStart = Date.now();
        bugService.getBugDetails(userId, analyzeMatch[1], function (err, bugData) {
          if (err) { console.error('[STEP 2/6] ❌ getBugDetails FAILED:', err.message); return send500(res, err.message); }
          console.log('[STEP 2/6] ✅ Bug details fetched in', (Date.now() - _analyzeStart) + 'ms');
          console.log('  Title:', (bugData.bug.title || '').substring(0, 80));
          console.log('  Status:', bugData.bug.status, '| Severity:', bugData.bug.severity);
          console.log('  Attachments:', (bugData.attachments || []).length, '| Comments:', (bugData.comments || []).length);

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
          console.log('');
          console.log('[STEP 3/6] 📂 Code scanning config:');
          console.log('  Agent URL:', JSON.stringify(analyzeUser.agentUrl) || '(none — local mode)');
          console.log('  Project dir:', JSON.stringify(analyzeUser.projectDir) || '(none)');
          console.log('  AI model:', analyzeUser.aiModel || 'claude-opus-4-6 (default)');
          if (targetRoute) console.log('  Target route:', targetRoute);

          // Helper: after code analysis, route to AI provider, then respond
          // Routing order:
          //   1. Copilot Bridge (free with Copilot license — Claude Opus 4.6 preferred)
          //   2. GitHub Models API (for non-Claude models, uses PAT)
          //   3. Anthropic Direct API (for Claude models, uses Anthropic key)
          function respondWithAnalysis(result, agentError) {
            console.log('');
            console.log('[STEP 4/6] ✅ Code scanning complete');
            console.log('  Relevant files:', result.analysis ? result.analysis.relevantFiles.length : 0);
            console.log('  Code matches:', result.analysis ? (result.analysis.codeMatches || []).length : 0);
            console.log('  File contents loaded:', result.analysis ? (result.analysis.fileContents || []).length : 0);
            console.log('  Prompt length:', result.prompt.length, 'chars');
            if (agentError) console.log('  ⚠️ Agent error:', agentError);
            var copilotBridge = require('./lib/copilot-bridge-client');
            // Default to claude-opus-4-6 for best results via Copilot Bridge
            var aiModel = analyzeUser.aiModel || 'claude-opus-4-6';
            var isClaude = githubAI.isClaudeModel(aiModel);
            var githubToken = analyzeUser.githubToken || '';
            var claudeKey = analyzeUser.claudeApiKey || '';
            var devServerUrl = analyzeUser.devServerUrl || '';

            function sendFinalResponse(aiResult, reproResult) {
              console.log('');
              console.log('[STEP 6/6] ✅ AI response received!');
              console.log('  Model:', aiResult.model);
              console.log('  Response length:', aiResult.text.length, 'chars');
              console.log('  Usage:', JSON.stringify(aiResult.usage || {}));
              console.log('  Total time:', ((Date.now() - _analyzeStart) / 1000).toFixed(1) + 's');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.log('');

              // Save prompt log to agent if available
              var promptLogData = {
                bugId: analyzeMatch[1],
                bugTitle: bugData.bug.title || '',
                bugStatus: bugData.bug.status || '',
                prompt: result.prompt,
                aiModel: aiResult.model,
                timestamp: new Date().toISOString()
              };
              if (analyzeUser.agentUrl) {
                agentProxy.promptSave(analyzeUser.agentUrl, promptLogData).catch(function (e) {
                  console.log('[analyze] Prompt log save failed:', e.message);
                });
              }

              sendJSON(res, 200, {
                prompt: result.prompt,
                analysis: result.analysis,
                bug: bugData.bug,
                agentError: agentError || null,
                bugImages: _bugImages.length,
                aiFix: {
                  text: aiResult.text,
                  model: aiResult.model,
                  usage: aiResult.usage
                },
                reproduction: reproResult || null
              });
            }

            function sendError(errMsg, reproResult) {
              console.error('');
              console.error('[STEP 6/6] ❌ AI ERROR:', errMsg);
              console.error('  Total time:', ((Date.now() - _analyzeStart) / 1000).toFixed(1) + 's');
              console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              console.error('');
              sendJSON(res, 200, {
                prompt: result.prompt,
                analysis: result.analysis,
                bug: bugData.bug,
                agentError: agentError || null,
                bugImages: _bugImages.length,
                aiFix: null,
                aiError: errMsg,
                reproduction: reproResult || null
              });
            }

            // ── Layer 2: Build AI interaction steps prompt from template context ──
            function buildInteractionStepsPrompt(bugTitle, bugDesc, templateCtx) {
              var lines = [];
              lines.push('You are helping reproduce a bug in an Ember.js 1.13.15 application by generating Puppeteer browser interaction steps.');
              lines.push('');
              lines.push('## Bug');
              lines.push('Title: ' + (bugTitle || 'Unknown'));
              lines.push('Description: ' + (bugDesc || 'No description'));
              lines.push('');

              // Include structured QA data (page, steps, expected/actual) if available
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

              if (templateCtx.template) {
                lines.push('## Page Template (HBS)');
                lines.push('File: ' + templateCtx.template.path);
                lines.push('```hbs');
                // Limit template size to keep prompt manageable
                var tContent = templateCtx.template.content;
                if (tContent.length > 6000) tContent = tContent.substring(0, 6000) + '\n{{!-- truncated --}}';
                lines.push(tContent);
                lines.push('```');
                lines.push('');
              }

              if (templateCtx.componentTemplates && templateCtx.componentTemplates.length > 0) {
                lines.push('## Component Templates');
                templateCtx.componentTemplates.forEach(function (ct) {
                  lines.push('### ' + ct.name);
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

              if (templateCtx.routeJS && templateCtx.routeJS.length > 0) {
                lines.push('## Route/Controller JS');
                templateCtx.routeJS.forEach(function (rj) {
                  lines.push('### ' + rj.path + ' (' + rj.type + ')');
                  lines.push('```js');
                  lines.push(rj.content);
                  lines.push('```');
                  lines.push('');
                });
              }

              lines.push('## Task');
              lines.push('Generate a JSON array of Puppeteer interaction steps to reproduce AND VERIFY this bug on the page.');
              lines.push('Look at the HBS templates to identify interactive elements (buttons, inputs, links, dropdowns, etc.).');
              lines.push('Create a realistic sequence of user interactions that would trigger the bug described above.');
              lines.push('');
              lines.push('CRITICAL: You MUST include at least one "assert" step that verifies the BUGGY condition.');
              lines.push('The assert step checks whether the bug exists. If the assert matches, it means the bug IS present.');
              lines.push('For example, if the bug says placeholder shows "Search Service" instead of "Search Services",');
              lines.push('use: { "action": "assert", "selector": "input.search", "attribute": "placeholder", "expected": "Search Service", "description": "Bug: placeholder says Search Service" }');
              lines.push('The "expected" value should be the INCORRECT/BUGGY value from the bug report.');
              if (_parsedDesc && _parsedDesc.actual) {
                lines.push('');
                lines.push('**For this specific bug:**');
                lines.push('The QA reports the ACTUAL (buggy) behavior is: "' + _parsedDesc.actual + '"');
                if (_parsedDesc.expected) {
                  lines.push('The EXPECTED (correct) behavior should be: "' + _parsedDesc.expected + '"');
                }
                lines.push('Your assert "expected" field should match the BUGGY value (the "actual" above).');
              }
              lines.push('');
              lines.push('Each step must be one of:');
              lines.push('- { "action": "click", "selector": "CSS selector", "description": "why" }');
              lines.push('- { "action": "type", "selector": "CSS selector", "text": "text to type", "description": "why" }');
              lines.push('- { "action": "waitForSelector", "selector": "CSS selector", "description": "why" }');
              lines.push('- { "action": "select", "selector": "CSS selector", "value": "option value", "description": "why" }');
              lines.push('- { "action": "hover", "selector": "CSS selector", "description": "why" }');
              lines.push('- { "action": "wait", "ms": 1000, "description": "why" }');
              lines.push('- { "action": "screenshot", "name": "step_name", "description": "why" }');
              lines.push('- { "action": "assert", "selector": "CSS selector", "attribute": "placeholder|textContent|innerText|value|class|title|aria-label|etc", "expected": "expected BUGGY value", "compare": "equals|contains", "description": "what the assert verifies" }');
              lines.push('');
              lines.push('Guidelines:');
              lines.push('- Use CSS selectors that match the HBS template elements. Prefer class selectors, data attributes, or IDs.');
              lines.push('- Ember uses {{action "name"}} — map these to their containing element\'s CSS class/ID.');
              lines.push('- Include waitForSelector before interacting with elements that may load asynchronously.');
              lines.push('- Add a screenshot step after key interactions (especially where the bug might manifest).');
              lines.push('- ALWAYS include 1-3 "assert" steps that CHECK for the buggy condition described in the bug report.');
              lines.push('- The assert "expected" value is the WRONG/BUGGY value (what the bug says is happening, not what SHOULD happen).');
              lines.push('- If the bug is visual (wrong text, placeholder, label, CSS), assert the text/attribute.');
              lines.push('- If the bug is behavioral (clicking X does Y wrong), assert the state after the action.');
              lines.push('- Keep the sequence practical: 5-15 steps typically suffice.');
              lines.push('');
              lines.push('Return ONLY a valid JSON array. No explanation, no markdown fences, no text before or after the JSON.');

              return lines.join('\n');
            }

            /**
             * Parse AI response into interaction steps JSON array.
             * Handles cases where AI wraps response in markdown fences or adds text.
             */
            function parseInteractionSteps(aiText) {
              if (!aiText) return [];
              // Strip markdown fences if present
              var cleaned = aiText.trim();
              cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
              // Try to find JSON array in the response
              var arrayMatch = cleaned.match(/\[[\s\S]*\]/);
              if (!arrayMatch) {
                console.log('[Layer 2] Could not find JSON array in AI response');
                return [];
              }
              try {
                var steps = JSON.parse(arrayMatch[0]);
                if (!Array.isArray(steps)) return [];
                // Validate each step has required fields
                return steps.filter(function (s) {
                  return s && s.action && typeof s.action === 'string';
                });
              } catch (e) {
                console.log('[Layer 2] JSON parse error:', e.message);
                return [];
              }
            }

            /**
             * Get AI-generated interaction steps using template context.
             * Calls: agent (template context) → AI (interaction steps) → callback(steps[])
             */
            function getInteractionSteps(callback) {
              if (!analyzeUser.agentUrl || !targetRoute) {
                return callback([]); // No agent or no route — skip
              }

              // ── Check for parsed QA steps first (skip AI if available) ──
              if (_parsedDesc && _parsedDesc.steps && _parsedDesc.steps.length > 0) {
                console.log('[Layer 2] 📋 Using', _parsedDesc.steps.length, 'parsed QA steps (skipping AI step generation)');
                // Convert QA text steps into Puppeteer-compatible step objects
                var qaSteps = _parsedDesc.steps.map(function (stepText, idx) {
                  var step = { description: stepText };
                  // Try to detect action type from step text
                  var lower = stepText.toLowerCase();
                  if (lower.match(/^(?:click|press|tap)\s/i)) {
                    step.action = 'click';
                    step.selector = ''; // Will be resolved by template matching in agent
                    step.hint = stepText.replace(/^(?:click|press|tap)\s+(?:on\s+)?(?:the\s+)?/i, '');
                  } else if (lower.match(/^(?:type|enter|input|fill)\s/i)) {
                    step.action = 'type';
                    step.selector = '';
                    var typeMatch = stepText.match(/(?:type|enter|input|fill)\s+["']([^"']+)["']/i);
                    step.text = typeMatch ? typeMatch[1] : '';
                    step.hint = stepText.replace(/^(?:type|enter|input|fill)\s+(?:in\s+)?(?:the\s+)?/i, '');
                  } else if (lower.match(/^(?:select|choose|pick)\s/i)) {
                    step.action = 'select';
                    step.selector = '';
                    step.hint = stepText.replace(/^(?:select|choose|pick)\s+/i, '');
                  } else if (lower.match(/^(?:hover|mouse\s*over)\s/i)) {
                    step.action = 'hover';
                    step.selector = '';
                    step.hint = stepText.replace(/^(?:hover|mouse\s*over)\s+(?:on\s+)?(?:the\s+)?/i, '');
                  } else if (lower.match(/^(?:wait|pause)/i)) {
                    step.action = 'wait';
                    step.ms = 2000;
                  } else if (lower.match(/^(?:navigate|go\s+to|open)/i)) {
                    step.action = 'navigate';
                    step.hint = stepText.replace(/^(?:navigate\s+to|go\s+to|open)\s+(?:the\s+)?/i, '');
                  } else if (lower.match(/^(?:refresh|reload)/i)) {
                    step.action = 'reload';
                  } else {
                    // Generic step — let AI resolve it
                    step.action = 'click';
                    step.selector = '';
                    step.hint = stepText;
                  }
                  return step;
                });
                // Add screenshot at the end to capture bug state
                qaSteps.push({ action: 'screenshot', name: 'after_steps', description: 'Capture state after QA steps' });
                qaSteps.forEach(function (s, idx) {
                  console.log('[Layer 2]   Parsed step', (idx + 1) + ':', s.action, '-', s.description || s.hint || '');
                });
                return callback(qaSteps);
              }

              console.log('[Layer 2] 🧠 Getting template context for route:', targetRoute);
              agentProxy.getTemplateContext(analyzeUser.agentUrl, targetRoute).then(function (templateCtx) {
                if (!templateCtx.hasTemplate) {
                  console.log('[Layer 2] ⚠️ No HBS template found for route — skipping interaction steps');
                  return callback([]);
                }
                console.log('[Layer 2] ✅ Template context received:',
                  templateCtx.totalTemplates, 'templates,',
                  (templateCtx.routeJS || []).length, 'JS files');

                // Build AI prompt
                var stepsPrompt = buildInteractionStepsPrompt(
                  bugData.bug.title || '',
                  bugData.bug.description || '',
                  templateCtx
                );
                console.log('[Layer 2] 📝 Interaction steps prompt:', stepsPrompt.length, 'chars');

                // Call AI for interaction steps (use same routing as main analysis)
                console.log('[Layer 2] 🤖 Asking AI for interaction steps...');
                var copilotBridge = require('./lib/copilot-bridge-client');
                copilotBridge.checkHealth(function (hErr, hData) {
                  if (!hErr && hData && hData.ok) {
                    copilotBridge.analyze(stepsPrompt, aiModel, function (bErr, bResult) {
                      if (!bErr && bResult && bResult.text) {
                        var steps = parseInteractionSteps(bResult.text);
                        console.log('[Layer 2] ✅ AI returned', steps.length, 'interaction steps');
                        steps.forEach(function (s, idx) {
                          console.log('[Layer 2]   Step', (idx + 1) + ':', s.action, s.selector || '', '-', s.description || '');
                        });
                        return callback(steps);
                      }
                      console.log('[Layer 2] ⚠️ Copilot Bridge failed for steps:', bErr ? bErr.message : 'empty response');
                      // Try fallback
                      tryStepsFallback(stepsPrompt, callback);
                    });
                  } else {
                    tryStepsFallback(stepsPrompt, callback);
                  }
                });
              }).catch(function (tErr) {
                console.log('[Layer 2] ⚠️ Template context failed:', tErr.message);
                callback([]);
              });
            }

            function tryStepsFallback(stepsPrompt, callback) {
              var isClaude2 = githubAI.isClaudeModel(aiModel);
              var claudeKey2 = analyzeUser.claudeApiKey || '';
              var githubToken2 = analyzeUser.githubToken || '';

              if (isClaude2 && claudeKey2) {
                claudeClient.analyze(claudeKey2, stepsPrompt, { model: aiModel }, function (clErr, clResult) {
                  if (!clErr && clResult && clResult.text) {
                    var steps = parseInteractionSteps(clResult.text);
                    console.log('[Layer 2] ✅ Anthropic returned', steps.length, 'interaction steps');
                    return callback(steps);
                  }
                  console.log('[Layer 2] ⚠️ Anthropic fallback failed:', clErr ? clErr.message : 'empty');
                  callback([]);
                });
              } else if (!isClaude2 && githubToken2) {
                githubAI.analyze(githubToken2, stepsPrompt, { model: aiModel }, function (ghErr, ghResult) {
                  if (!ghErr && ghResult && ghResult.text) {
                    var steps = parseInteractionSteps(ghResult.text);
                    console.log('[Layer 2] ✅ GitHub Models returned', steps.length, 'interaction steps');
                    return callback(steps);
                  }
                  console.log('[Layer 2] ⚠️ GitHub Models fallback failed:', ghErr ? ghErr.message : 'empty');
                  callback([]);
                });
              } else {
                console.log('[Layer 2] ⚠️ No AI fallback available for interaction steps');
                callback([]);
              }
            }

            // Step 0: Try browser reproduction (if agent is available)
            // Supports retry: if first attempt fails/inconclusive, ask AI for corrected steps
            function attemptReproduction(callback) {
              if (!analyzeUser.agentUrl) {
                return callback(null); // No agent — skip reproduction
              }

              // Layer 2: Get AI interaction steps first, then generate + run script
              console.log('');
              console.log('[STEP 5a] 🎭 Attempting Playwright browser reproduction...');
              if (targetRoute) console.log('[STEP 5a] 📍 Target route:', targetRoute);

              getInteractionSteps(function (interactionSteps) {
                if (interactionSteps.length > 0) {
                  console.log('[STEP 5a] 🧠 Using', interactionSteps.length, 'AI-generated interaction steps');
                } else {
                  console.log('[STEP 5a] ℹ️ No interaction steps — observe-only mode');
                }

                // Run the reproduction for a given set of steps and callback with result
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
                    console.log('[' + label + '] ✅ Reproduction script generated:', genResult.testFile);
                    console.log('[' + label + '] 🏃 Running reproduction script...');
                    agentProxy.playwrightRun(analyzeUser.agentUrl, genResult.testFile).then(function (runResult) {
                      var bugConfirmed = !!runResult.bugConfirmed;
                      var assertions = runResult.assertions || [];
                      var navigationOk = runResult.navigationOk !== false;
                      var reproduced = bugConfirmed || !runResult.passed;
                      var status = 'not-reproduced';
                      if (bugConfirmed) {
                        status = 'bug-confirmed';
                        console.log('[' + label + '] 🔴 Bug CONFIRMED by assertion(s)');
                      } else if (!navigationOk) {
                        status = 'navigation-failed';
                        console.log('[' + label + '] ⚠️ Navigation failed — test inconclusive');
                        reproduced = false;
                      } else if (!runResult.passed) {
                        status = 'test-errors';
                        console.log('[' + label + '] ⚠️ Test had errors (may or may not indicate bug)');
                      } else if (assertions.length > 0) {
                        status = 'assertions-passed';
                        console.log('[' + label + '] ✅ Assertions ran — bug condition NOT found');
                      } else {
                        status = 'no-assertions';
                        console.log('[' + label + '] ℹ️ No assertions — test completed without verification');
                      }
                      console.log('[' + label + '] Result — status:', status, 'passed:', runResult.passed, 'bugConfirmed:', bugConfirmed, 'duration:', runResult.duration + 'ms');
                      doneCallback({
                        attempted: true,
                        passed: runResult.passed,
                        reproduced: reproduced,
                        bugConfirmed: bugConfirmed,
                        assertions: assertions,
                        navigationOk: navigationOk,
                        pageUrl: runResult.pageUrl || null,
                        status: status,
                        output: runResult.output,
                        duration: runResult.duration,
                        testFile: genResult.testFile,
                        screenshotFile: runResult.screenshotFile,
                        interactionSteps: steps.length
                      });
                    }).catch(function (runErr) {
                      console.log('[' + label + '] ⚠️ Reproduction run failed:', runErr.message);
                      doneCallback({
                        attempted: true,
                        passed: false,
                        reproduced: false,
                        error: runErr.message,
                        interactionSteps: steps.length
                      });
                    });
                  }).catch(function (genErr) {
                    console.log('[' + label + '] ⚠️ Reproduction generate failed:', genErr.message);
                    doneCallback({
                      attempted: false,
                      error: genErr.message
                    });
                  });
                }

                // ── First attempt ──
                runReproduction(interactionSteps, 'STEP 5a', function (firstResult) {
                  // Check if retry is warranted (navigation-failed, test-errors, or no-assertions)
                  var shouldRetry = firstResult && firstResult.attempted &&
                    !firstResult.bugConfirmed &&
                    (firstResult.status === 'navigation-failed' || firstResult.status === 'test-errors' || firstResult.status === 'no-assertions') &&
                    interactionSteps.length > 0;

                  if (!shouldRetry) {
                    return callback(firstResult);
                  }

                  // ── Retry: ask AI for corrected steps using first attempt's output ──
                  console.log('');
                  console.log('[STEP 5a-retry] 🔄 First reproduction attempt was', firstResult.status, '— asking AI for corrected steps...');

                  var retryPromptLines = [];
                  retryPromptLines.push('A Puppeteer browser reproduction test for a bug just ran but the result was: ' + firstResult.status + '.');
                  retryPromptLines.push('');
                  retryPromptLines.push('## Bug');
                  retryPromptLines.push('Title: ' + (bugData.bug.title || ''));
                  retryPromptLines.push('Description: ' + (bugData.bug.description || '').substring(0, 1500));
                  retryPromptLines.push('');
                  retryPromptLines.push('## Original Interaction Steps (that failed)');
                  retryPromptLines.push('```json');
                  retryPromptLines.push(JSON.stringify(interactionSteps, null, 2));
                  retryPromptLines.push('```');
                  retryPromptLines.push('');
                  retryPromptLines.push('## Test Output');
                  retryPromptLines.push('```');
                  var retryOutput = (firstResult.output || '').substring(0, 3000);
                  retryPromptLines.push(retryOutput);
                  retryPromptLines.push('```');
                  if (firstResult.pageUrl) retryPromptLines.push('Final page URL: ' + firstResult.pageUrl);
                  retryPromptLines.push('');
                  retryPromptLines.push('## Task');
                  retryPromptLines.push('Based on the failure output above, generate CORRECTED interaction steps. Fix issues like:');
                  retryPromptLines.push('- Wrong CSS selectors (element not found → use broader/different selector)');
                  retryPromptLines.push('- Missing wait steps (element not yet rendered → add waitForSelector)');
                  retryPromptLines.push('- Wrong page state (need to click/navigate somewhere first)');
                  retryPromptLines.push('- Navigation errors (wrong route or URL)');
                  retryPromptLines.push('');
                  retryPromptLines.push('IMPORTANT: Include at least one "assert" step that checks for the buggy condition.');
                  retryPromptLines.push('Return ONLY a valid JSON array of corrected steps. No markdown fences, no explanation.');

                  var retryPromptText = retryPromptLines.join('\n');
                  console.log('[STEP 5a-retry] Retry prompt:', retryPromptText.length, 'chars');

                  // Send to AI for corrected steps
                  var copilotBridge2 = require('./lib/copilot-bridge-client');
                  copilotBridge2.checkHealth(function (hErr2, hData2) {
                    function gotRetrySteps(retrySteps) {
                      if (retrySteps && retrySteps.length > 0) {
                        console.log('[STEP 5a-retry] ✅ Got', retrySteps.length, 'corrected steps — running retry...');
                        retrySteps.forEach(function (s, idx) {
                          console.log('[STEP 5a-retry]   Step', (idx + 1) + ':', s.action, s.selector || '', '-', s.description || '');
                        });
                        runReproduction(retrySteps, 'STEP 5a-retry', function (retryResult) {
                          // Use the better result (prefer confirmed or assertions-passed)
                          if (retryResult && retryResult.bugConfirmed) {
                            console.log('[STEP 5a-retry] 🔴 Bug confirmed on retry!');
                            retryResult.retried = true;
                            return callback(retryResult);
                          }
                          if (retryResult && retryResult.status === 'assertions-passed') {
                            console.log('[STEP 5a-retry] ✅ Assertions passed on retry');
                            retryResult.retried = true;
                            return callback(retryResult);
                          }
                          // Retry wasn't better — use first result
                          console.log('[STEP 5a-retry] Retry result:', retryResult ? retryResult.status : 'failed', '— using first attempt result');
                          firstResult.retryAttempted = true;
                          callback(firstResult);
                        });
                      } else {
                        console.log('[STEP 5a-retry] ⚠️ No corrected steps returned — using first attempt result');
                        firstResult.retryAttempted = true;
                        callback(firstResult);
                      }
                    }

                    function tryRetryFallback() {
                      var isClaude3 = githubAI.isClaudeModel(aiModel);
                      var claudeKey3 = analyzeUser.claudeApiKey || '';
                      var githubToken3 = analyzeUser.githubToken || '';
                      if (isClaude3 && claudeKey3) {
                        claudeClient.analyze(claudeKey3, retryPromptText, { model: aiModel }, function (err3, res3) {
                          if (!err3 && res3 && res3.text) return gotRetrySteps(parseInteractionSteps(res3.text));
                          firstResult.retryAttempted = true;
                          callback(firstResult);
                        });
                      } else if (!isClaude3 && githubToken3) {
                        githubAI.analyze(githubToken3, retryPromptText, { model: aiModel }, function (err3, res3) {
                          if (!err3 && res3 && res3.text) return gotRetrySteps(parseInteractionSteps(res3.text));
                          firstResult.retryAttempted = true;
                          callback(firstResult);
                        });
                      } else {
                        firstResult.retryAttempted = true;
                        callback(firstResult);
                      }
                    }

                    if (!hErr2 && hData2 && hData2.ok) {
                      copilotBridge2.analyze(retryPromptText, aiModel, function (bErr2, bResult2) {
                        if (!bErr2 && bResult2 && bResult2.text) {
                          return gotRetrySteps(parseInteractionSteps(bResult2.text));
                        }
                        tryRetryFallback();
                      });
                    } else {
                      tryRetryFallback();
                    }
                  });
                });
              });
            }

            // ── Build a "Reproduction Evidence" section to inject into the AI prompt ──
            function buildReproductionEvidenceSection(repro) {
              if (!repro || !repro.attempted) return '';
              var lines = [];
              lines.push('## 🧪 Reproduction Evidence (Automated Browser Test)');
              lines.push('');
              lines.push('> The following data was collected by running an automated Puppeteer browser test');
              lines.push('> against the development server. Use this evidence to validate your analysis');
              lines.push('> and focus on the confirmed bug behavior.');
              lines.push('');
              lines.push('**Reproduction Status:** ' + repro.status);
              if (repro.bugConfirmed) {
                lines.push('');
                lines.push('⚠️ **BUG CONFIRMED** — the automated test found evidence matching the reported bug.');
                lines.push('The assertions below matched the buggy condition. Your fix MUST address this confirmed behavior.');
              } else if (repro.status === 'assertions-passed') {
                lines.push('');
                lines.push('✅ Assertions ran but the buggy condition was NOT found. The bug may be intermittent,');
                lines.push('environment-specific, or already partially fixed. Still analyze the code for the root cause.');
              } else if (repro.status === 'navigation-failed') {
                lines.push('');
                lines.push('⚠️ Navigation to the target page failed. The bug may involve routing or access issues.');
              }
              if (repro.pageUrl) {
                lines.push('**Final Page URL:** `' + repro.pageUrl + '`');
              }
              lines.push('**Test Duration:** ' + (repro.duration || 0) + 'ms');
              lines.push('');

              // Detailed assertion results
              if (repro.assertions && repro.assertions.length > 0) {
                lines.push('### Assertion Results');
                lines.push('');
                for (var ai = 0; ai < repro.assertions.length; ai++) {
                  var a = repro.assertions[ai];
                  var statusTag = a.passed ? '✅ PASSED' : '❌ FAILED';
                  if (a.status === 'element-not-found') statusTag = '⚠️ ELEMENT NOT FOUND';
                  lines.push((ai + 1) + '. **' + statusTag + '** — ' + (a.description || 'assertion'));
                  if (a.selector) lines.push('   - Selector: `' + a.selector + '`');
                  if (a.attribute) lines.push('   - Attribute: `' + a.attribute + '`');
                  if (a.expected !== undefined && a.expected !== null) lines.push('   - Expected (buggy value): `' + a.expected + '`');
                  if (a.actual !== undefined && a.actual !== null) lines.push('   - Actual value found: `' + a.actual + '`');
                  if (a.status === 'element-not-found') {
                    lines.push('   - ⚠️ The element was not present on the page. The component may not be rendering or the selector is wrong.');
                  }
                }
                lines.push('');
              }

              // Trimmed Puppeteer output (useful error messages, console logs)
              if (repro.output) {
                var outputLines = repro.output.split('\n');
                // Filter for useful lines (skip blank and redundant lines)
                var usefulLines = outputLines.filter(function (line) {
                  var trimmed = line.trim();
                  return trimmed.length > 0 && trimmed.indexOf('__REPRO_RESULT__') === -1;
                });
                if (usefulLines.length > 40) {
                  usefulLines = usefulLines.slice(0, 40);
                  usefulLines.push('... (output truncated)');
                }
                if (usefulLines.length > 0) {
                  lines.push('### Browser Test Output');
                  lines.push('```');
                  lines.push(usefulLines.join('\n'));
                  lines.push('```');
                  lines.push('');
                }
              }

              return lines.join('\n');
            }

            // Run reproduction first, then AI analysis
            attemptReproduction(function (reproResult) {

            // If bug was NOT reproduced (assertions ran and passed), skip code fix
            if (reproResult && reproResult.attempted && !reproResult.bugConfirmed && !reproResult.reproduced &&
                reproResult.status === 'assertions-passed') {
              console.log('');
              console.log('[STEP 5/6] ✅ Bug not reproduced — skipping AI code fix generation');
              console.log('  Assertions confirmed the bug is NOT present');
              console.log('  Total time:', ((Date.now() - _analyzeStart) / 1000).toFixed(1) + 's');
              console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              return sendJSON(res, 200, {
                prompt: result.prompt,
                analysis: result.analysis,
                bug: bugData.bug,
                agentError: agentError || null,
                bugImages: _bugImages.length,
                aiFix: null,
                fixSkipped: 'Bug was not reproduced — assertions verified the bug condition is not present. No code fix needed.',
                reproduction: reproResult
              });
            }

            // ── Inject reproduction evidence into AI prompt (before sending to AI) ──
            if (reproResult && reproResult.attempted) {
              var reproEvidence = buildReproductionEvidenceSection(reproResult);
              if (reproEvidence) {
                // Insert the evidence BEFORE the "What You Must Do" section so AI prioritizes it
                var taskMarker = '## What You Must Do';
                var markerIdx = result.prompt.indexOf(taskMarker);
                if (markerIdx > 0) {
                  result.prompt = result.prompt.substring(0, markerIdx) + reproEvidence + '\n' + result.prompt.substring(markerIdx);
                } else {
                  // Fallback: append before coding standards
                  result.prompt = result.prompt + '\n' + reproEvidence;
                }
                console.log('[STEP 5b] 📋 Injected reproduction evidence into AI prompt (' + reproEvidence.length + ' chars)');
                console.log('  Updated prompt length:', result.prompt.length, 'chars');
              }
            }

            // ── Inject reproduction screenshot into vision images ──
            if (reproResult && reproResult.screenshotFile) {
              try {
                var reproScreenshotPath = require('path').join(__dirname, 'data', 'agent-data', 'prompts', reproResult.screenshotFile);
                if (require('fs').existsSync(reproScreenshotPath)) {
                  var screenshotData = require('fs').readFileSync(reproScreenshotPath);
                  var screenshotBase64 = screenshotData.toString('base64');
                  if (screenshotBase64.length < 5 * 1024 * 1024) { // under 5MB base64
                    _bugImages.push({
                      name: 'reproduction_screenshot.png',
                      mimeType: 'image/png',
                      base64: screenshotBase64
                    });
                    console.log('[STEP 5b] 📸 Added reproduction screenshot to vision images (' + Math.round(screenshotBase64.length / 1024) + ' KB)');
                  }
                }
              } catch (ssErr) {
                console.log('[STEP 5b] ⚠️ Could not read reproduction screenshot:', ssErr.message);
              }
            }

            // Step 1: Try Copilot Bridge first (free, works for Claude + GPT-4o + more)
            console.log('');
            console.log('[STEP 5/6] 🤖 Sending prompt to AI...');
            console.log('  Checking Copilot Bridge...');
            copilotBridge.checkHealth(function (hErr, hData) {
              if (!hErr && hData && hData.ok) {
                console.log('[STEP 5/6] ✅ Copilot Bridge available — sending to model:', aiModel);
                if (_bugImages.length > 0) console.log('  Including', _bugImages.length, 'bug screenshot(s) for vision analysis');
                copilotBridge.analyze(result.prompt, aiModel, { images: _bugImages }, function (bErr, bResult) {
                  if (!bErr) return sendFinalResponse(bResult, reproResult);
                  console.log('[STEP 5/6] ⚠️ Copilot Bridge failed:', bErr.message, '— trying fallback...');
                  tryFallback(reproResult);
                });
              } else {
                console.log('[STEP 5/6] Copilot Bridge not available —', hErr ? hErr.message : 'trying fallback...');
                tryFallback(reproResult);
              }
            });

            // Step 2–3: Fallback based on model type
            function tryFallback(reproRes) {
              if (isClaude) {
                // Claude → Anthropic Direct API (needs Anthropic key)
                if (claudeKey) {
                  console.log('[STEP 5/6] 📡 Using Anthropic Direct API — model:', aiModel);
                  console.log('  Waiting for Claude response (may take 30-120s)...');
                  claudeClient.analyze(claudeKey, result.prompt, { model: aiModel, images: _bugImages }, function (clErr, clResult) {
                    if (!clErr) return sendFinalResponse(clResult, reproRes);
                    sendError('Anthropic API: ' + clErr.message, reproRes);
                  });
                } else {
                  sendError('Claude model selected but no way to reach it.\n\n' +
                    '• Install the Copilot Bridge VS Code extension (uses your Copilot license — no API key needed)\n' +
                    '• Or add an Anthropic API key in Settings → AI Analysis', reproRes);
                }
              } else {
                // Non-Claude → GitHub Models API (needs PAT)
                if (githubToken) {
                  console.log('[STEP 5/6] 📡 Using GitHub Models API — model:', aiModel);
                  console.log('  Waiting for AI response (may take 30-120s)...');
                  githubAI.analyze(githubToken, result.prompt, { model: aiModel, images: _bugImages }, function (ghErr, ghResult) {
                    if (!ghErr) return sendFinalResponse(ghResult, reproRes);
                    sendError('GitHub Models API: ' + ghErr.message, reproRes);
                  });
                } else {
                  sendError('No GitHub token configured. Add your PAT in Settings → AI Analysis.', reproRes);
                }
              }
            }

            }); // end attemptReproduction
          }

          if (analyzeUser.agentUrl) {
            // Agent mode: proxy analysis through agent
            // First, fetch template context for the target route (Layer 2)
            // so the fix prompt includes the actual page files
            console.log('');
            var _templateCtx = null;
            function fetchTemplateContextThenScan() {
              if (targetRoute && analyzeUser.agentUrl) {
                console.log('[STEP 3/6] 🎯 Fetching page template context for route:', targetRoute);
                agentProxy.getTemplateContext(analyzeUser.agentUrl, targetRoute).then(function (tCtx) {
                  if (tCtx && tCtx.hasTemplate) {
                    _templateCtx = tCtx;
                    console.log('[STEP 3/6] ✅ Template context:',
                      tCtx.totalTemplates, 'templates,',
                      (tCtx.routeJS || []).length, 'JS files,',
                      (tCtx.componentTemplates || []).length, 'components');
                  } else {
                    console.log('[STEP 3/6] ⚠️ No template found for route — using keyword scan only');
                  }
                  doAgentScan();
                }).catch(function (tErr) {
                  console.log('[STEP 3/6] ⚠️ Template context fetch failed:', tErr.message, '— continuing with keyword scan');
                  doAgentScan();
                });
              } else {
                doAgentScan();
              }
            }

            function doAgentScan() {
              console.log('[STEP 3/6] 🔎 Scanning code via AGENT at', analyzeUser.agentUrl, '...');
              var _scanStart = Date.now();
              fixPrompt.generatePromptViaAgent(userId, bugData, analyzeUser.agentUrl, extraDescription, function (promptErr, result) {
                if (promptErr) return send500(res, 'Agent error: ' + promptErr.message);
                console.log('[STEP 3/6] ✅ Agent scan complete in', (Date.now() - _scanStart) + 'ms');
                console.log('  Files found:', (result.analysis ? result.analysis.relevantFiles.length : 0), '| Agent error:', result.agentError || 'none');
                respondWithAnalysis(result, result.agentError);
              }, _templateCtx, _parsedDesc);
            }

            fetchTemplateContextThenScan();
          } else {
            // Local mode
            console.log('');
            console.log('[STEP 3/6] 🔎 Scanning code LOCALLY in', analyzeUser.projectDir, '...');
            var _scanStart2 = Date.now();
            var result = fixPrompt.generatePrompt(userId, bugData, extraDescription, _parsedDesc);
            console.log('[STEP 3/6] ✅ Local scan complete in', (Date.now() - _scanStart2) + 'ms');
            console.log('  Files found:', (result.analysis ? result.analysis.relevantFiles.length : 0));
            respondWithAnalysis(result, null);
          }
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

    // POST /api/write-file
    if (pathname === '/api/write-file' && method === 'POST') {
      readBody(req, function (bodyErr, body) {
        if (bodyErr) return send400(res, bodyErr.message);
        var wfUser = userStore.getUser(userId);
        if (wfUser.agentUrl) {
          agentProxy.writeFile(wfUser.agentUrl, body.path, body.content).then(function (data) {
            sendJSON(res, 200, data);
          }).catch(function (err) { send500(res, 'Agent error: ' + err.message); });
        } else if (wfUser.projectDir) {
          var wfPath = require('path').resolve(wfUser.projectDir, body.path);
          if (wfPath.indexOf(require('path').resolve(wfUser.projectDir)) !== 0)
            return send400(res, 'Path outside project');
          try {
            require('fs').writeFileSync(wfPath, body.content || '', 'utf-8');
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
});
