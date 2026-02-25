'use strict';
/**
 * agent-proxy.js — Proxy code analysis requests to the user's local agent.
 *
 * When a user has configured an agentUrl in their settings, all code search,
 * grep, read-file, stats, and analyze calls are forwarded to their agent
 * instead of reading the local filesystem.
 */
var http = require('http');
var https = require('https');
var url = require('url');

/**
 * Make an HTTP GET request to the agent and return parsed JSON.
 * @param {string} agentUrl  Base URL like "http://192.168.1.50:4000"
 * @param {string} endpoint  e.g. "/search?q=foo"
 * @param {number} timeoutMs  Timeout in ms (default 15000)
 * @returns {Promise<object>}
 */
function agentGet(agentUrl, endpoint, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  return new Promise(function (resolve, reject) {
    var fullUrl = agentUrl.replace(/\/$/, '') + endpoint;
    var parsed = url.parse(fullUrl);
    var mod = parsed.protocol === 'https:' ? https : http;

    var req = mod.get(fullUrl, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          try { var err = JSON.parse(body); reject(new Error(err.error || 'Agent error ' + res.statusCode)); }
          catch (e) { reject(new Error('Agent returned ' + res.statusCode)); }
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON from agent')); }
      });
    });

    req.on('error', function (err) { reject(new Error('Agent unreachable: ' + err.message)); });
    req.setTimeout(timeoutMs, function () { req.abort(); reject(new Error('Agent request timed out')); });
  });
}

/**
 * Check if the agent is online.
 */
function checkHealth(agentUrl) {
  return agentGet(agentUrl, '/health', 5000);
}

/**
 * Get project stats from agent.
 */
function getStats(agentUrl, extensions, excludeDirs) {
  return agentGet(agentUrl, '/stats');
}

/**
 * Search file names via agent.
 */
function searchFiles(agentUrl, query) {
  return agentGet(agentUrl, '/search?q=' + encodeURIComponent(query));
}

/**
 * Grep file contents via agent.
 */
function grepFiles(agentUrl, pattern, isRegex) {
  var endpoint = '/grep?q=' + encodeURIComponent(pattern);
  if (isRegex) endpoint += '&regex=1';
  return agentGet(agentUrl, endpoint);
}

/**
 * Read a file via agent.
 */
function readFile(agentUrl, filePath, startLine, endLine) {
  var endpoint = '/read-file?path=' + encodeURIComponent(filePath);
  if (startLine) endpoint += '&start=' + startLine;
  if (endLine) endpoint += '&end=' + endLine;
  return agentGet(agentUrl, endpoint);
}

/**
 * Analyze code for a bug using keywords via agent.
 * Uses 60s timeout — large projects with many keywords can take 10-20s.
 */
function analyzeForBug(agentUrl, keywords) {
  var qs = '/analyze?keywords=' + encodeURIComponent(keywords.join(','));
  // Pass code-identifier keywords so agent can apply weighted scoring
  if (keywords._codeKeywords) {
    var codeKwList = Object.keys(keywords._codeKeywords);
    if (codeKwList.length > 0) {
      qs += '&codeKeywords=' + encodeURIComponent(codeKwList.join(','));
    }
  }
  console.log('[agent-proxy] → GET', agentUrl + qs.substring(0, 80) + '...');
  return agentGet(agentUrl, qs, 60000);
}

/**
 * Make an HTTP POST request to the agent with a JSON body.
 */
function agentPost(agentUrl, endpoint, data, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  return new Promise(function (resolve, reject) {
    var fullUrl = agentUrl.replace(/\/$/, '') + endpoint;
    var parsed = url.parse(fullUrl);
    var mod = parsed.protocol === 'https:' ? https : http;
    var postData = JSON.stringify(data || {});

    var options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };

    var req = mod.request(options, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          try { var err = JSON.parse(body); reject(new Error(err.error || 'Agent error ' + res.statusCode)); }
          catch (e) { reject(new Error('Agent returned ' + res.statusCode)); }
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON from agent')); }
      });
    });

    req.on('error', function (err) { reject(new Error('Agent unreachable: ' + err.message)); });
    req.setTimeout(timeoutMs, function () { req.abort(); reject(new Error('Agent request timed out')); });
    req.write(postData);
    req.end();
  });
}

/**
 * Write a file via agent.
 */
function writeFile(agentUrl, filePath, content) {
  return agentPost(agentUrl, '/write-file', { path: filePath, content: content }, 15000);
}

/**
 * Get git status from agent.
 */
function gitStatus(agentUrl) {
  return agentGet(agentUrl, '/git/status', 15000);
}

/**
 * Get git diff from agent, optionally filtered to specific files.
 * @param {string[]} [files] - file paths to filter the diff to
 */
function gitDiff(agentUrl, files) {
  var endpoint = '/git/diff';
  if (files && files.length > 0) {
    endpoint += '?files=' + encodeURIComponent(files.join(','));
  }
  return agentGet(agentUrl, endpoint, 15000);
}

/**
 * Commit changes via agent.
 */
function gitCommit(agentUrl, message, files) {
  return agentPost(agentUrl, '/git/commit', { message: message, files: files }, 30000);
}

// ── Playwright proxy functions ──────────────────────────

/**
 * Get template context (HBS + components + route JS) for a route path.
 * Used by Layer 2 to build AI interaction-steps prompt.
 */
function getTemplateContext(agentUrl, routePath) {
  return agentGet(agentUrl, '/template-context?route=' + encodeURIComponent(routePath), 10000);
}

/**
 * Generate a Playwright test for a bug on the agent.
 */
function playwrightGenerate(agentUrl, bugId, bugTitle, bugDescription, devServerUrl, testUsername, testPassword, targetRoute, interactionSteps) {
  return agentPost(agentUrl, '/playwright/generate', {
    bugId: bugId,
    bugTitle: bugTitle,
    bugDescription: bugDescription,
    devServerUrl: devServerUrl,
    testUsername: testUsername || '',
    testPassword: testPassword || '',
    targetRoute: targetRoute || '',
    interactionSteps: interactionSteps || []
  }, 15000);
}

/**
 * Run a Playwright test on the agent.
 */
function playwrightRun(agentUrl, testFile) {
  return agentPost(agentUrl, '/playwright/run', { testFile: testFile }, 90000);
}

/**
 * Verify a bug fix using saved Playwright test on the agent.
 */
function playwrightVerify(agentUrl, bugId) {
  return agentPost(agentUrl, '/playwright/verify', { bugId: bugId }, 90000);
}

/**
 * Save a prompt log on the agent.
 */
function promptSave(agentUrl, data) {
  return agentPost(agentUrl, '/prompts/save', data, 15000);
}

/**
 * Load a prompt log from the agent.
 */
function promptLoad(agentUrl, bugId) {
  return agentGet(agentUrl, '/prompts/' + encodeURIComponent(bugId), 10000);
}

/**
 * Save settings to agent for persistent local storage.
 * Settings survive token refreshes and server restarts.
 */
function saveSettings(agentUrl, settings) {
  return agentPost(agentUrl, '/settings', settings, 10000);
}

/**
 * Load settings from agent's local storage.
 * Returns { ok, settings } where settings may be null if never saved.
 */
function loadSettings(agentUrl) {
  return agentGet(agentUrl, '/settings', 10000);
}

module.exports = {
  agentGet: agentGet,
  agentPost: agentPost,
  checkHealth: checkHealth,
  getStats: getStats,
  searchFiles: searchFiles,
  grepFiles: grepFiles,
  readFile: readFile,
  writeFile: writeFile,
  analyzeForBug: analyzeForBug,
  getTemplateContext: getTemplateContext,
  gitStatus: gitStatus,
  gitDiff: gitDiff,
  gitCommit: gitCommit,
  playwrightGenerate: playwrightGenerate,
  playwrightRun: playwrightRun,
  playwrightVerify: playwrightVerify,
  promptSave: promptSave,
  promptLoad: promptLoad,
  saveSettings: saveSettings,
  loadSettings: loadSettings
};
