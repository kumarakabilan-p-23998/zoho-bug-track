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
        console.log('[analyze] Request for bug:', analyzeMatch[1], 'userId:', userId, 'extraDesc length:', extraDescription.length);
        bugService.getBugDetails(userId, analyzeMatch[1], function (err, bugData) {
          if (err) { console.error('[analyze] getBugDetails error:', err.message); return send500(res, err.message); }
          var analyzeUser = userStore.getUser(userId);
          console.log('[analyze] User agentUrl:', JSON.stringify(analyzeUser.agentUrl), 'projectDir:', JSON.stringify(analyzeUser.projectDir));

          // Helper: after code analysis, route to AI provider, then respond
          // Routing order:
          //   1. Copilot Bridge (free with Copilot license — Claude Opus 4.6 preferred)
          //   2. GitHub Models API (for non-Claude models, uses PAT)
          //   3. Anthropic Direct API (for Claude models, uses Anthropic key)
          function respondWithAnalysis(result, agentError) {
            var copilotBridge = require('./lib/copilot-bridge-client');
            // Default to claude-opus-4-6 for best results via Copilot Bridge
            var aiModel = analyzeUser.aiModel || 'claude-opus-4-6';
            var isClaude = githubAI.isClaudeModel(aiModel);
            var githubToken = analyzeUser.githubToken || '';
            var claudeKey = analyzeUser.claudeApiKey || '';
            var devServerUrl = analyzeUser.devServerUrl || '';

            function sendFinalResponse(aiResult, reproResult) {
              console.log('[analyze] AI fix received —', aiResult.text.length, 'chars, model:', aiResult.model);

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
                aiFix: {
                  text: aiResult.text,
                  model: aiResult.model,
                  usage: aiResult.usage
                },
                reproduction: reproResult || null
              });
            }

            function sendError(errMsg, reproResult) {
              console.error('[analyze] AI error:', errMsg);
              sendJSON(res, 200, {
                prompt: result.prompt,
                analysis: result.analysis,
                bug: bugData.bug,
                agentError: agentError || null,
                aiFix: null,
                aiError: errMsg,
                reproduction: reproResult || null
              });
            }

            // Step 0: Try browser reproduction (if agent is available)
            function attemptReproduction(callback) {
              if (!analyzeUser.agentUrl) {
                return callback(null); // No agent — skip reproduction
              }

              console.log('[analyze] Attempting browser reproduction for bug:', analyzeMatch[1]);
              agentProxy.playwrightGenerate(
                analyzeUser.agentUrl,
                analyzeMatch[1],
                bugData.bug.title || '',
                bugData.bug.description || '',
                devServerUrl,
                analyzeUser.testUsername || '',
                analyzeUser.testPassword || ''
              ).then(function (genResult) {
                console.log('[analyze] Reproduction script generated:', genResult.testFile);
                // Run the test
                agentProxy.playwrightRun(analyzeUser.agentUrl, genResult.testFile).then(function (runResult) {
                  console.log('[analyze] Reproduction result — passed:', runResult.passed, 'duration:', runResult.duration + 'ms');
                  callback({
                    attempted: true,
                    passed: runResult.passed,
                    reproduced: !runResult.passed, // test failing = bug reproduced
                    output: runResult.output,
                    duration: runResult.duration,
                    testFile: genResult.testFile,
                    screenshotFile: runResult.screenshotFile
                  });
                }).catch(function (runErr) {
                  console.log('[analyze] Reproduction run failed:', runErr.message);
                  callback({
                    attempted: true,
                    passed: false,
                    reproduced: false,
                    error: runErr.message
                  });
                });
              }).catch(function (genErr) {
                console.log('[analyze] Reproduction generate failed:', genErr.message);
                callback({
                  attempted: false,
                  error: genErr.message
                });
              });
            }

            // Run reproduction first, then AI analysis
            attemptReproduction(function (reproResult) {

            // Step 1: Try Copilot Bridge first (free, works for Claude + GPT-4o + more)
            copilotBridge.checkHealth(function (hErr, hData) {
              if (!hErr && hData && hData.ok) {
                console.log('[analyze] Copilot Bridge available — trying model:', aiModel);
                copilotBridge.analyze(result.prompt, aiModel, function (bErr, bResult) {
                  if (!bErr) return sendFinalResponse(bResult, reproResult);
                  console.log('[analyze] Bridge failed:', bErr.message, '— trying fallback');
                  tryFallback(reproResult);
                });
              } else {
                tryFallback(reproResult);
              }
            });

            // Step 2–3: Fallback based on model type
            function tryFallback(reproRes) {
              if (isClaude) {
                // Claude → Anthropic Direct API (needs Anthropic key)
                if (claudeKey) {
                  console.log('[analyze] Using Anthropic Direct API — model:', aiModel);
                  claudeClient.analyze(claudeKey, result.prompt, { model: aiModel }, function (clErr, clResult) {
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
                  console.log('[analyze] Using GitHub Models API — model:', aiModel);
                  githubAI.analyze(githubToken, result.prompt, { model: aiModel }, function (ghErr, ghResult) {
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
            fixPrompt.generatePromptViaAgent(userId, bugData, analyzeUser.agentUrl, extraDescription, function (promptErr, result) {
              if (promptErr) return send500(res, 'Agent error: ' + promptErr.message);
              console.log('[analyze] Agent result — files:', (result.analysis ? result.analysis.relevantFiles.length : 0), 'agentError:', result.agentError || 'none');
              respondWithAnalysis(result, result.agentError);
            });
          } else {
            // Local mode
            console.log('[analyze] Using local mode with projectDir:', analyzeUser.projectDir);
            var result = fixPrompt.generatePrompt(userId, bugData, extraDescription);
            console.log('[analyze] Local result — files:', (result.analysis ? result.analysis.relevantFiles.length : 0));
            respondWithAnalysis(result, null);
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
