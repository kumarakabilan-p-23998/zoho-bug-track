#!/usr/bin/env node
'use strict';
/**
 * agent.js — Local Code Agent for Zoho Bug Tracker.
 *
 * Each developer runs this on their machine. It exposes a small HTTP server
 * that the main Zoho Bug Tracker server proxies code requests to.
 *
 * Endpoints:
 *   GET /health              → { ok: true, projectDir, user }
 *   GET /stats               → project file statistics
 *   GET /search?q=...        → search filenames
 *   GET /grep?q=...          → grep file contents
 *   GET /read-file?path=...  → read a file (with optional line range)
 *   GET /analyze?keywords=.. → full keyword analysis for a bug
 *
 * Usage:
 *   node agent.js --dir "D:/MyProject/app" --port 4000
 *   node agent.js -d "D:/MyProject/app" -p 4000 --name "John"
 *
 * Node 8+ compatible. Zero dependencies.
 */
var http = require('http');
var url = require('url');
var fs = require('fs');
var path = require('path');
var os = require('os');
var patchUtils = require('./lib/patch-utils');
var logger = require('./lib/logger');

// ── CLI args ─────────────────────────────────────────────

var args = process.argv.slice(2);
var config = {
  port: 4000,
  dir: '',
  name: os.hostname(),
  allowOrigins: '*',     // restrict if needed
  extensions: ['.js', '.hbs', '.css', '.java', '.json', '.xml'],
  excludeDirs: ['node_modules', '.git', 'bower_components', 'dist', 'tmp', 'vendor', 'third-party']
};

for (var i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--port': case '-p': config.port = parseInt(args[++i], 10) || 4000; break;
    case '--dir':  case '-d': config.dir = args[++i]; break;
    case '--name': case '-n': config.name = args[++i]; break;
    case '--allow-origins': config.allowOrigins = args[++i]; break;
    case '--extensions': case '-e': config.extensions = args[++i].split(','); break;
    case '--exclude': case '-x': config.excludeDirs = args[++i].split(','); break;
    case '--help': case '-h':
      console.log('');
      console.log('Zoho Bug Tracker — Local Code Agent');
      console.log('');
      console.log('Usage:');
      console.log('  node agent.js --dir <path> [--port <num>] [--name <name>]');
      console.log('');
      console.log('Options:');
      console.log('  -d, --dir <path>       Project directory to scan (REQUIRED)');
      console.log('  -p, --port <num>       Port to listen on (default: 4000)');
      console.log('  -n, --name <name>      Your name / machine name (default: hostname)');
      console.log('  -e, --extensions <ext>  Comma-separated file extensions (default: .js,.hbs,.css,.java,.json,.xml)');
      console.log('  -x, --exclude <dirs>   Comma-separated dirs to exclude (default: node_modules,.git,...)');
      console.log('');
      console.log('Example:');
      console.log('  node agent.js -d "D:/Repositories/MyProject/app" -p 4000 -n "John"');
      console.log('');
      console.log('Then in the web UI Settings, set Agent URL to:');
      console.log('  http://<your-ip>:4000');
      console.log('');
      process.exit(0);
      break;
    default:
      // If it looks like a path and no --dir set, use it as dir
      if (!config.dir && fs.existsSync(args[i])) config.dir = args[i];
      break;
  }
}

if (!config.dir) {
  console.error('');
  console.error('ERROR: --dir is required. Specify the project directory to scan.');
  console.error('');
  console.error('Usage: node agent.js --dir "D:/MyProject/app"');
  console.error('Run: node agent.js --help  for all options.');
  console.error('');
  process.exit(1);
}

config.dir = path.resolve(config.dir);
if (!fs.existsSync(config.dir)) {
  console.error('ERROR: Directory does not exist: ' + config.dir);
  process.exit(1);
}

// ── safety ───────────────────────────────────────────────

function isInsideRoot(root, target) {
  return path.resolve(target).indexOf(path.resolve(root)) === 0;
}

// ── file walker ──────────────────────────────────────────

function walkDir(dir, exts, exclude, maxFiles) {
  var results = [];
  maxFiles = maxFiles || 5000;

  function _walk(current) {
    if (results.length >= maxFiles) return;
    var entries;
    try { entries = fs.readdirSync(current); } catch (e) { return; }

    for (var i = 0; i < entries.length; i++) {
      if (results.length >= maxFiles) return;
      var name = entries[i];
      if (exclude.indexOf(name) !== -1 || name.charAt(0) === '.') continue;

      var full = path.join(current, name);
      var stat;
      try { stat = fs.statSync(full); } catch (e) { continue; }

      if (stat.isDirectory()) {
        _walk(full);
      } else if (stat.isFile()) {
        var ext = path.extname(name).toLowerCase();
        if (exts.length === 0 || exts.indexOf(ext) !== -1) {
          results.push(full);
        }
      }
    }
  }
  _walk(dir);
  return results;
}

// ── search / grep / read ─────────────────────────────────

// ── file list cache (rebuilt every 30s max) ─────────────────
var _cachedFiles = null;
var _cacheTime = 0;
var CACHE_TTL = 30000; // 30 seconds

function getCachedFileList() {
  var now = Date.now();
  if (!_cachedFiles || (now - _cacheTime) > CACHE_TTL) {
    _cachedFiles = walkDir(config.dir, config.extensions, config.excludeDirs);
    _cacheTime = now;
  }
  return _cachedFiles;
}

function searchFiles(query, maxResults, fileListOverride) {
  maxResults = maxResults || 50;
  var allFiles = fileListOverride || getCachedFileList();
  var qLower = query.toLowerCase();
  var matches = [];

  for (var i = 0; i < allFiles.length && matches.length < maxResults; i++) {
    var rel = path.relative(config.dir, allFiles[i]).replace(/\\/g, '/');
    if (rel.toLowerCase().indexOf(qLower) !== -1) {
      matches.push(rel);
    }
  }
  return matches;
}

function grepFiles(pattern, options, fileListOverride) {
  options = options || {};
  var maxResults = options.maxResults || 100;
  var maxFileSize = 500 * 1024;
  var allFiles = fileListOverride || getCachedFileList();
  var pLower = pattern.toLowerCase();
  var isRegex = options.isRegex || false;
  var regex = null;
  if (isRegex) {
    try { regex = new RegExp(pattern, 'gi'); } catch (e) { /* fallback */ }
  }

  var results = [];
  for (var i = 0; i < allFiles.length && results.length < maxResults; i++) {
    var stat;
    try { stat = fs.statSync(allFiles[i]); } catch (e) { continue; }
    if (stat.size > maxFileSize) continue;

    var content;
    try { content = fs.readFileSync(allFiles[i], 'utf-8'); } catch (e) { continue; }

    var lines = content.split('\n');
    for (var j = 0; j < lines.length && results.length < maxResults; j++) {
      var matches = false;
      if (regex) { regex.lastIndex = 0; matches = regex.test(lines[j]); }
      else { matches = lines[j].toLowerCase().indexOf(pLower) !== -1; }

      if (matches) {
        results.push({
          file: path.relative(config.dir, allFiles[i]).replace(/\\/g, '/'),
          line: j + 1,
          text: lines[j].trim().substring(0, 200)
        });
      }
    }
  }
  return results;
}

function readFile(relPath, startLine, endLine) {
  var fullPath = path.resolve(config.dir, relPath);
  if (!isInsideRoot(config.dir, fullPath)) {
    return { error: 'Path is outside project directory' };
  }
  if (!fs.existsSync(fullPath)) {
    return { error: 'File not found: ' + relPath };
  }

  var content;
  try { content = fs.readFileSync(fullPath, 'utf-8'); } catch (e) {
    return { error: 'Cannot read: ' + e.message };
  }

  var lines = content.split('\n');
  var total = lines.length;

  if (startLine || endLine) {
    var s = Math.max(1, startLine || 1) - 1;
    var e = Math.min(total, endLine || total);
    return { file: relPath, totalLines: total, startLine: s + 1, endLine: e, content: lines.slice(s, e).join('\n') };
  }

  if (total > 500) {
    return { file: relPath, totalLines: total, startLine: 1, endLine: 500, content: lines.slice(0, 500).join('\n'), truncated: true };
  }
  return { file: relPath, totalLines: total, content: content };
}

function getStats() {
  var files = walkDir(config.dir, config.extensions, config.excludeDirs, 10000);
  var byExt = {};
  files.forEach(function (f) {
    var ext = path.extname(f).toLowerCase() || '(no ext)';
    byExt[ext] = (byExt[ext] || 0) + 1;
  });
  return { valid: true, totalFiles: files.length, byExtension: byExt, projectDir: config.dir };
}

function analyzeForBug(keywords) {
  var allCodeMatches = [];
  var fileScores = {};   // file → Set of keywords matched
  var fileNameHit = {};  // file → true if filename matched

  // Walk directory ONCE, reuse for all keywords
  var allFiles = getCachedFileList();

  keywords.forEach(function (kw) {
    if (!kw || kw.length < 2) return;
    searchFiles(kw, 10, allFiles).forEach(function (f) {
      if (!fileScores[f]) fileScores[f] = {};
      fileScores[f][kw] = true;
      fileNameHit[f] = true;
    });
    grepFiles(kw, { maxResults: 20 }, allFiles).forEach(function (hit) {
      allCodeMatches.push(hit);
      if (!fileScores[hit.file]) fileScores[hit.file] = {};
      fileScores[hit.file][kw] = true;
    });
  });

  // Score each file: code-identifier keyword matches = 2 pts, plain words = 0.5 pts
  var codeKwSet = keywords._codeKeywords || {};
  var scored = Object.keys(fileScores).map(function (f) {
    var matchedKws = Object.keys(fileScores[f]);
    var kwCount = matchedKws.length;
    var codeKwCount = 0;
    var score = 0;
    matchedKws.forEach(function (kw) {
      if (codeKwSet[kw.toLowerCase()]) {
        score += 2;
        codeKwCount++;
      } else {
        score += 0.5;
      }
    });
    if (fileNameHit[f]) score += 1;
    return { file: f, score: score, kwCount: kwCount, codeKwCount: codeKwCount };
  });

  // Sort by score descending
  scored.sort(function (a, b) { return b.score - a.score; });

  // Relevance filter: prefer files matching code-identifier keywords
  var hasCodeKws = Object.keys(codeKwSet).length > 0;
  var relevant;
  if (hasCodeKws) {
    relevant = scored.filter(function (s) { return s.codeKwCount >= 1; });
    if (relevant.length === 0) {
      relevant = scored.filter(function (s) { return s.kwCount >= 2; });
    }
  } else {
    var minKw = keywords.length >= 3 ? 2 : 1;
    relevant = scored.filter(function (s) { return s.kwCount >= minKw; });
  }
  if (relevant.length === 0) relevant = scored;
  relevant = relevant.slice(0, 15);

  var relevantSet = {};
  var relevantFiles = relevant.map(function (s) { relevantSet[s.file] = true; return s.file; });

  // Filter codeMatches to only relevant files
  var codeMatches = allCodeMatches.filter(function (m) { return relevantSet[m.file]; });

  var fileContents = [];
  relevantFiles.slice(0, 10).forEach(function (f) {
    var result = readFile(f);
    if (!result.error) fileContents.push(result);
  });

  return {
    keywords: keywords,
    relevantFiles: relevantFiles,
    codeMatches: codeMatches.slice(0, 50),
    fileContents: fileContents,
    fileScores: relevant.map(function (s) { return { file: s.file, score: s.score, keywords: Object.keys(fileScores[s.file]) }; })
  };
}

// ── git helpers ──────────────────────────────────────────

var childProcess = require('child_process');

// ── prompts data dir ─────────────────────────────────────
// Store agent data OUTSIDE the Ember project to avoid triggering Broccoli/livereload.
// Uses the zoho-bug-track tool's own directory instead.

var BUG_TRACKER_DATA_DIR = path.join(__dirname, 'data', 'agent-data');
var PROMPTS_DIR = path.join(BUG_TRACKER_DATA_DIR, 'prompts');
// Settings stored OUTSIDE repo — in user home dir to avoid pushing credentials
var SETTINGS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.zoho-bug-track');
var SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
try {
  if (!fs.existsSync(BUG_TRACKER_DATA_DIR)) {
    fs.mkdirSync(BUG_TRACKER_DATA_DIR);
  }
  if (!fs.existsSync(PROMPTS_DIR)) {
    fs.mkdirSync(PROMPTS_DIR);
  }
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR);
    console.log('[agent] Created settings dir:', SETTINGS_DIR);
  }
  // Ensure package.json exists so npm install works in this dir
  var pkgFile = path.join(BUG_TRACKER_DATA_DIR, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(pkgFile, '{}', 'utf-8');
  }
} catch (e) { /* ignore — will fail at save time */ }

// ── Browser reproduction helpers (puppeteer-core, Node 8+) ──

/**
 * Find a Chrome or Edge executable on the system.
 * Returns the path or null.
 */
function findBrowserPath() {
  var candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
  }
  return null;
}

/**
 * Ensure puppeteer-core is installed. Runs npm install once if needed.
 * callback(err)
 */
function getPuppeteerCorePath() {
  return path.join(BUG_TRACKER_DATA_DIR, 'node_modules', 'puppeteer-core');
}

function ensurePuppeteer(callback) {
  // Check if puppeteer-core is installed in our isolated .bug-tracker-data dir
  var puppeteerPath = getPuppeteerCorePath();
  if (fs.existsSync(puppeteerPath)) {
    return callback(null); // already installed
  }

  console.log('[agent] Installing puppeteer-core@2.1.1 into .bug-tracker-data (one-time)...');
  childProcess.exec('npm install puppeteer-core@2.1.1 --no-save --no-package-lock', {
    cwd: BUG_TRACKER_DATA_DIR,
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024
  }, function (err, stdout, stderr) {
    if (err) {
      console.log('[agent] puppeteer-core install failed:', (stderr || err.message));
      return callback(new Error('Failed to install puppeteer-core: ' + (stderr || err.message)));
    }
    console.log('[agent] puppeteer-core installed to', BUG_TRACKER_DATA_DIR);
    callback(null);
  });
}

// ── Ember Route Parsing & Bug-to-Route Matching ──────────────

/**
 * Parse the Ember router.js file and extract a flat list of routes with their URL paths.
 * Returns an array of { name, path, fullName } objects.
 */
function parseEmberRoutes() {
  var routerFile = path.join(config.dir, '..', 'router.js');
  // Try a few common locations
  if (!fs.existsSync(routerFile)) {
    routerFile = path.join(config.dir, 'router.js');
  }
  if (!fs.existsSync(routerFile)) {
    // Search for it
    var candidates = ['router.js', '../router.js', '../../router.js'];
    for (var ci = 0; ci < candidates.length; ci++) {
      var candidate = path.resolve(config.dir, candidates[ci]);
      if (fs.existsSync(candidate)) { routerFile = candidate; break; }
    }
  }
  if (!fs.existsSync(routerFile)) {
    console.log('[agent] ⚠️ router.js not found near', config.dir);
    return [];
  }

  var content = fs.readFileSync(routerFile, 'utf-8');
  var routes = [];

  // Regex-based parser for Ember router.js
  // Tracks nesting via brace depth: update depth FIRST, then pop closed scopes,
  // then process route declarations and push new scopes.
  // This correctly handles { path: '...' } option objects (net-zero braces)
  // and inline function callbacks on the same line as this.route().
  var lines = content.split('\n');
  var braceDepth = 0;
  var routeDepths = []; // stack of { name, path, depth }

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];

    // Strip single-line comments to avoid counting braces inside them
    var codeLine = line.replace(/\/\/.*$/, '');
    // Strip string contents to avoid counting braces inside strings
    codeLine = codeLine.replace(/(["'])(?:(?!\1).)*\1/g, '""');

    // Count brace changes on the cleaned line
    var openBraces = (codeLine.match(/\{/g) || []).length;
    var closeBraces = (codeLine.match(/\}/g) || []).length;

    // ── 1. Update brace depth FIRST ──
    braceDepth += openBraces - closeBraces;

    // ── 2. Pop parent routes whose scope has closed ──
    // Use strict < : a route pushed at depth N stays until braceDepth drops below N
    while (routeDepths.length > 0 && braceDepth < routeDepths[routeDepths.length - 1].depth) {
      routeDepths.pop();
    }

    // ── 3. Process route declarations ──
    var routeMatch = line.match(/this\.route\s*\(\s*["']([^"']+)["']/);
    if (routeMatch) {
      var routeName = routeMatch[1];
      var pathMatch = line.match(/path\s*:\s*["']([^"']+)["']/);
      var routePath = pathMatch ? pathMatch[1] : '/' + routeName;
      var hasCallback = /function\s*\(/.test(line);

      // Build the full path from parent stack
      var fullPath = '';
      for (var pi = 0; pi < routeDepths.length; pi++) {
        fullPath += routeDepths[pi].path;
      }
      // Only add leading slash if routePath doesn't start with one
      if (routePath.charAt(0) !== '/') {
        fullPath += '/' + routePath;
      } else {
        fullPath += routePath;
      }

      // Build full dot-separated name
      var fullName = routeDepths.map(function (r) { return r.name; }).concat([routeName]).join('.');

      // Clean up path — remove duplicate slashes
      var cleanPath = fullPath.replace(/\/+/g, '/');

      routes.push({
        name: routeName,
        fullName: fullName,
        path: cleanPath,
        displayPath: cleanPath.replace(/\/:[^/]+/g, '/*')  // show :params as *
      });

      // If this route has a callback (children), push onto depth stack
      // depth = current braceDepth (already updated), which is the depth INSIDE the function body
      if (hasCallback) {
        routeDepths.push({ name: routeName, path: routePath.charAt(0) === '/' ? routePath : '/' + routeName, depth: braceDepth });
      }
    }
  }

  console.log('[agent] 📍 Parsed', routes.length, 'routes from', routerFile);
  return routes;
}

// ── Structured Description Parser ─────────────────────

// Stop-words: common words that appear everywhere but mean nothing for route matching
var ROUTE_STOP_WORDS = [
  'the', 'and', 'for', 'but', 'not', 'with', 'this', 'that', 'from', 'are',
  'was', 'were', 'been', 'have', 'has', 'had', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'shall', 'does', 'did', 'bug', 'error',
  'issue', 'problem', 'fix', 'click', 'button', 'page', 'when', 'after',
  'before', 'then', 'also', 'just', 'only', 'some', 'all', 'any', 'get',
  'set', 'add', 'new', 'old', 'try', 'use', 'see', 'show', 'hide', 'open',
  'close', 'save', 'edit', 'delete', 'remove', 'update', 'create', 'load',
  'display', 'appear', 'disappear', 'work', 'working', 'broken', 'expected',
  'actual', 'result', 'instead', 'incorrect', 'correct', 'wrong', 'right',
  'name', 'type', 'value', 'text', 'input', 'field', 'form', 'tab', 'modal',
  'popup', 'dialog', 'dropdown', 'select', 'option', 'check', 'checkbox',
  'radio', 'table', 'row', 'column', 'cell', 'list', 'item', 'data', 'user',
  'admin', 'test', 'step', 'steps', 'navigate', 'navigation', 'refresh'
];

/**
 * Parse structured bug description.
 * Looks for: Page:, Steps:, Expected:, Actual:
 * Returns { page, steps[], expected, actual } or null if format not detected.
 */
function parseStructuredDescription(description) {
  if (!description) return null;
  // Strip HTML tags (Zoho descriptions may contain HTML)
  var text = description.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

  var result = { page: '', steps: [], expected: '', actual: '' };
  var found = false;

  // Extract Page: field
  var pageMatch = text.match(/(?:^|\n)\s*page\s*:\s*(.+)/i);
  if (pageMatch) {
    result.page = pageMatch[1].trim();
    found = true;
  }

  // Extract Steps: block (numbered lines after "Steps:")
  var stepsMatch = text.match(/(?:^|\n)\s*steps\s*:\s*\n?([\s\S]*?)(?=\n\s*(?:expected|actual)\s*:|$)/i);
  if (stepsMatch) {
    var stepsBlock = stepsMatch[1].trim();
    var stepLines = stepsBlock.split(/\n/);
    for (var si = 0; si < stepLines.length; si++) {
      var line = stepLines[si].trim();
      // Match numbered steps: "1. Do something" or "- Do something"
      var stepText = line.replace(/^\d+[\.\)\-]\s*/, '').replace(/^[\-\*]\s*/, '').trim();
      if (stepText.length > 2) {
        result.steps.push(stepText);
        found = true;
      }
    }
  }

  // Extract Expected:
  var expectedMatch = text.match(/(?:^|\n)\s*expected\s*:\s*(.+)/i);
  if (expectedMatch) {
    result.expected = expectedMatch[1].trim();
    found = true;
  }

  // Extract Actual:
  var actualMatch = text.match(/(?:^|\n)\s*actual\s*:\s*(.+)/i);
  if (actualMatch) {
    result.actual = actualMatch[1].trim();
    found = true;
  }

  if (!found) return null;
  console.log('[agent] 📋 Parsed structured description:', JSON.stringify(result));
  return result;
}

/**
 * Extract route URLs from text (e.g. "#/settings/connections" or "/settings/connections").
 * Returns first match or ''.
 */
function extractRouteUrl(text) {
  if (!text) return '';
  // Match #/path/to/route or standalone /path/to/route (at least 2 segments)
  var urlMatch = text.match(/#\/([a-z][a-z0-9\-\/]+)/i);
  if (urlMatch) return urlMatch[1];
  // Also try bare /settings/... or /soar/... patterns
  var bareMatch = text.match(/(?:^|\s)\/([a-z][a-z0-9\-]+(?:\/[a-z][a-z0-9\-]+)+)/i);
  if (bareMatch) return bareMatch[1];
  return '';
}

/**
 * Fuzzy-match a plain English page name (e.g. "Connections", "SOAR > Playbooks")
 * against known Ember routes. Returns { route, score } or null.
 */
function matchPageNameToRoute(pageName, routes) {
  if (!pageName || !routes || routes.length === 0) return null;

  // Normalize: "SOAR > Playbooks" → ["soar", "playbooks"]
  var pageTokens = pageName.toLowerCase()
    .replace(/>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(function (t) { return t.length > 1; });

  if (pageTokens.length === 0) return null;

  var bestScore = 0;
  var bestRoute = null;

  for (var ri = 0; ri < routes.length; ri++) {
    var route = routes[ri];
    var score = 0;

    // Route parts: "settings.integrations.connections" → ["settings", "integrations", "connections"]
    var routeParts = route.fullName.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(function (p) { return p.length > 1; });

    // Also path parts: "/settings/integrations/connections" → same
    var pathParts = route.path.toLowerCase()
      .replace(/\/:[^/]+/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(function (p) { return p.length > 1; });

    var allParts = routeParts.concat(pathParts);

    // Score: how many page tokens match route parts
    var matchedTokens = 0;
    for (var ti = 0; ti < pageTokens.length; ti++) {
      for (var pi = 0; pi < allParts.length; pi++) {
        if (pageTokens[ti] === allParts[pi]) {
          score += 20;  // exact match — high confidence
          matchedTokens++;
          break;
        } else if (allParts[pi].indexOf(pageTokens[ti]) === 0 || pageTokens[ti].indexOf(allParts[pi]) === 0) {
          score += 10;  // prefix match (e.g. "connect" matches "connections")
          matchedTokens++;
          break;
        }
      }
    }

    // Bonus: if ALL page tokens matched, this is very likely the right route
    if (matchedTokens === pageTokens.length && pageTokens.length > 0) {
      score += 30;
    }

    // Bonus: prefer deeper/more specific routes ("connections" in path = better than top-level)
    var lastPathPart = pathParts.length > 0 ? pathParts[pathParts.length - 1] : '';
    for (var li = 0; li < pageTokens.length; li++) {
      if (pageTokens[li] === lastPathPart) {
        score += 15;  // page name matches the leaf route segment
        break;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestRoute = route;
    }
  }

  if (bestScore < 15) return null;  // too weak
  return { route: bestRoute, score: bestScore };
}

/**
 * Match a Zoho module name (e.g. "SOAR", "Connections") to a route.
 * Modules are curated by the team and usually map to a route section.
 */
function matchModuleToRoute(moduleName, routes) {
  if (!moduleName) return null;
  return matchPageNameToRoute(moduleName, routes);
}

/**
 * Match bug title + description keywords against known routes.
 * 4-layer cascading detection:
 *   1. Parsed Page: field (highest confidence)
 *   2. URL extraction from description (#/path/...)
 *   3. Zoho module name
 *   4. Improved keyword scoring (fallback)
 * Returns { matchedRoute, method, parsedDesc } or { matchedRoute: '' }.
 */
function matchBugToRoute(bugTitle, bugDescription, routes, moduleName) {
  if (!routes || routes.length === 0) return { matchedRoute: '', method: 'none', parsedDesc: null };

  var fullText = ((bugTitle || '') + ' ' + (bugDescription || ''));

  // ── Layer 1: Structured Page: field ──
  var parsed = parseStructuredDescription(bugDescription);
  if (parsed && parsed.page) {
    console.log('[agent] 🎯 Layer 1: Parsed Page field:', parsed.page);
    var pageResult = matchPageNameToRoute(parsed.page, routes);
    if (pageResult) {
      console.log('[agent] ✅ Layer 1 match:', pageResult.route.fullName, '→', pageResult.route.path, '(score:', pageResult.score + ')');
      return { matchedRoute: pageResult.route.path, method: 'structured-page', score: pageResult.score, parsedDesc: parsed };
    }
  }

  // ── Layer 2: URL extraction ──
  var extractedUrl = extractRouteUrl(fullText);
  if (extractedUrl) {
    console.log('[agent] 🔗 Layer 2: Extracted URL:', extractedUrl);
    // Try direct path match
    for (var ui = 0; ui < routes.length; ui++) {
      var rPath = normalizeRoutePath(routes[ui].path);
      if (rPath && extractedUrl.indexOf(rPath) !== -1) {
        console.log('[agent] ✅ Layer 2 match:', routes[ui].fullName, '→', routes[ui].path);
        return { matchedRoute: routes[ui].path, method: 'url-extraction', score: 100, parsedDesc: parsed };
      }
    }
    // Try partial match on URL segments
    var urlResult = matchPageNameToRoute(extractedUrl.replace(/\//g, ' '), routes);
    if (urlResult && urlResult.score >= 20) {
      console.log('[agent] ✅ Layer 2 fuzzy match:', urlResult.route.fullName, '→', urlResult.route.path);
      return { matchedRoute: urlResult.route.path, method: 'url-extraction', score: urlResult.score, parsedDesc: parsed };
    }
  }

  // ── Layer 3: Zoho module name ──
  if (moduleName) {
    console.log('[agent] 📦 Layer 3: Zoho module:', moduleName);
    var modResult = matchModuleToRoute(moduleName, routes);
    if (modResult) {
      console.log('[agent] ✅ Layer 3 match:', modResult.route.fullName, '→', modResult.route.path, '(score:', modResult.score + ')');
      return { matchedRoute: modResult.route.path, method: 'zoho-module', score: modResult.score, parsedDesc: parsed };
    }
  }

  // ── Layer 4: Improved keyword scoring (fallback) ──
  console.log('[agent] 🔤 Layer 4: Keyword scoring fallback');
  var text = fullText.toLowerCase();

  // Tokenize with stop-word filtering
  var tokens = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(function (t) {
      return t.length > 2 && ROUTE_STOP_WORDS.indexOf(t) === -1;
    });

  // Weight title tokens 3x higher
  var titleTokens = (bugTitle || '').toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(function (t) {
      return t.length > 2 && ROUTE_STOP_WORDS.indexOf(t) === -1;
    });

  var bestScore = 0;
  var bestRoute = null;

  for (var ri = 0; ri < routes.length; ri++) {
    var route = routes[ri];
    var score = 0;

    var nameParts = route.fullName.toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(function (p) { return p.length > 2; });

    var pathParts = route.path.toLowerCase()
      .replace(/\/:[^/]+/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(function (p) { return p.length > 2; });

    var allParts = nameParts.concat(pathParts);

    // Whole-word matching only (no partial indexOf)
    for (var api = 0; api < allParts.length; api++) {
      for (var ti = 0; ti < tokens.length; ti++) {
        if (tokens[ti] === allParts[api]) {
          // Title tokens worth 3x
          var isTitleToken = titleTokens.indexOf(tokens[ti]) !== -1;
          score += isTitleToken ? 15 : 5;
        }
      }
    }

    // Bonus for route name appearing in title
    var titleLower = (bugTitle || '').toLowerCase();
    if (route.name.length > 2 && titleLower.indexOf(route.name.toLowerCase()) !== -1) {
      score += 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRoute = route;
    }
  }

  // Higher minimum score to avoid false positives
  if (bestScore < 15) {
    console.log('[agent] ⚠️ No confident route match (best score:', bestScore + ')');
    return { matchedRoute: '', method: 'keyword-low-confidence', score: bestScore, parsedDesc: parsed };
  }

  console.log('[agent] 📍 Layer 4 match:', bestRoute.fullName, '→', bestRoute.path, '(score:', bestScore + ')');
  return { matchedRoute: bestRoute.path, method: 'keyword', score: bestScore, parsedDesc: parsed };
}

// Cache parsed routes (re-parse every 5 minutes)
var _cachedRoutes = null;
var _routesCacheTime = 0;
function getCachedRoutes() {
  var now = Date.now();
  if (!_cachedRoutes || (now - _routesCacheTime) > 5 * 60 * 1000) {
    _cachedRoutes = parseEmberRoutes();
    _routesCacheTime = now;
  }
  return _cachedRoutes;
}

// ── Layer 2: Template Resolution & Interaction Steps ─────

/**
 * Normalize a route path — strip hash prefix, leading/trailing slashes.
 * "#/settings/integrations/connections" → "settings/integrations/connections"
 */
function normalizeRoutePath(routePath) {
  if (!routePath) return '';
  var p = routePath.replace(/^#?\/?/, '').replace(/\/+$/, '');
  return p;
}

/**
 * Given a route path (e.g. "/settings/playbooks" or "#/settings/integrations/connections"),
 * find the matching route object.
 */
function findRouteByPath(routePath) {
  var routes = getCachedRoutes();
  if (!routePath) return null;
  var normalized = '/' + normalizeRoutePath(routePath);

  for (var i = 0; i < routes.length; i++) {
    var rp = routes[i].path.replace(/\/+$/, '');
    if (rp === normalized) return routes[i];
  }
  // Try without leading slash
  var noSlash = normalized.replace(/^\//, '');
  for (var j = 0; j < routes.length; j++) {
    if (routes[j].path.replace(/^\//, '').replace(/\/+$/, '') === noSlash) return routes[j];
  }
  return null;
}

/**
 * Convert a route path to its template file path.
 * Supports both pods and classic Ember layouts:
 *   Pods:    "#/settings/integrations/connections" → pods/settings/integrations/connections/template.hbs
 *   Classic: "settings.playbooks" → templates/settings/playbooks.hbs
 */
function getTemplateForRoute(routeFullName) {
  if (!routeFullName) return null;
  var parts = routeFullName.replace(/\./g, '/');

  // ── Pods layout (primary — used by this project) ──
  // pods/{route-segments}/template.hbs
  var podsRel = 'pods/' + parts + '/template.hbs';
  var podsPath = path.join(config.dir, podsRel);
  if (fs.existsSync(podsPath)) {
    try {
      return { path: podsRel, content: fs.readFileSync(podsPath, 'utf-8') };
    } catch (e) { /* skip */ }
  }

  // ── Classic layout (fallback) ──
  // templates/{route-segments}.hbs
  var classicRel = 'templates/' + parts + '.hbs';
  var classicPath = path.join(config.dir, classicRel);
  if (fs.existsSync(classicPath)) {
    try {
      return { path: classicRel, content: fs.readFileSync(classicPath, 'utf-8') };
    } catch (e) { /* skip */ }
  }
  // Classic index
  var classicIndexRel = 'templates/' + parts + '/index.hbs';
  var classicIndexPath = path.join(config.dir, classicIndexRel);
  if (fs.existsSync(classicIndexPath)) {
    try {
      return { path: classicIndexRel, content: fs.readFileSync(classicIndexPath, 'utf-8') };
    } catch (e) { /* skip */ }
  }
  return null;
}

/**
 * Extract component references from HBS content.
 * Matches both:
 *   {{component-name ...}}           — simple hyphenated names
 *   {{namespace/component-name ...}} — namespaced (pods-style) components
 *   {{#component-name ...}}          — block form
 */
function extractComponentRefs(hbsContent) {
  if (!hbsContent) return [];
  var components = {};
  // Match {{component-name}}, {{namespace/component-name}}, {{#component-name}}
  // Component names contain at least one hyphen OR are namespaced with /
  var regex = /\{\{#?((?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/)*[a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g;
  var match;
  while ((match = regex.exec(hbsContent)) !== null) {
    var name = match[1];
    // Skip built-in helpers
    var builtins = ['link-to', 'query-params', 'each-in', 'ember-wormhole',
      'liquid-if', 'liquid-unless', 'bs-tooltip', 'ember-popper',
      'moment-format', 'is-equal', 't-translation', 'ads-i18n',
      'ads-status-box', 'ads-dialog-box', 'ads-multi-section-filter',
      'ads-notification-template', 'insert-newline'];
    // Check base name (last segment after /) against builtins
    var baseName = name.indexOf('/') !== -1 ? name.split('/').pop() : name;
    if (builtins.indexOf(baseName) !== -1 || builtins.indexOf(name) !== -1) {
      continue;
    }
    components[name] = true;
  }
  return Object.keys(components);
}

/**
 * Read a single component's template + JS from pods or classic layout.
 *
 * Pod component paths:
 *   "connections/connections-home" → pods/components/connections/connections-home/template.hbs
 *   "show-cards"                  → pods/components/show-cards/template.hbs
 *
 * Classic component paths:
 *   "connections/connections-home" → templates/components/connections/connections-home.hbs
 *   "show-cards"                  → templates/components/show-cards.hbs
 */
function readOneComponent(name) {
  var result = { name: name, path: null, content: null, jsPath: null, jsContent: null };

  // ── Pods layout ──
  var podsTemplateRel = 'pods/components/' + name + '/template.hbs';
  var podsTemplatePath = path.join(config.dir, podsTemplateRel);
  if (fs.existsSync(podsTemplatePath)) {
    try {
      result.path = podsTemplateRel;
      result.content = fs.readFileSync(podsTemplatePath, 'utf-8');
    } catch (e) { /* skip */ }
  }

  // Pods component JS
  var podsJsRel = 'pods/components/' + name + '/component.js';
  var podsJsPath = path.join(config.dir, podsJsRel);
  if (fs.existsSync(podsJsPath)) {
    try {
      var jsContent = fs.readFileSync(podsJsPath, 'utf-8');
      if (jsContent.length > 6000) jsContent = jsContent.substring(0, 6000) + '\n// ... truncated ...';
      result.jsPath = podsJsRel;
      result.jsContent = jsContent;
    } catch (e) { /* skip */ }
  }

  // ── Classic layout fallback ──
  if (!result.content) {
    var classicRel = 'templates/components/' + name + '.hbs';
    var classicPath = path.join(config.dir, classicRel);
    if (fs.existsSync(classicPath)) {
      try {
        result.path = classicRel;
        result.content = fs.readFileSync(classicPath, 'utf-8');
      } catch (e) { /* skip */ }
    }
  }
  if (!result.jsContent) {
    var classicJsRel = 'components/' + name + '.js';
    var classicJsPath = path.join(config.dir, classicJsRel);
    if (fs.existsSync(classicJsPath)) {
      try {
        var jsC = fs.readFileSync(classicJsPath, 'utf-8');
        if (jsC.length > 6000) jsC = jsC.substring(0, 6000) + '\n// ... truncated ...';
        result.jsPath = classicJsRel;
        result.jsContent = jsC;
      } catch (e) { /* skip */ }
    }
  }

  return result.content ? result : null;
}

/**
 * Read component templates (and optional JS) for a list of component names.
 */
function readComponentTemplates(componentNames) {
  var results = [];
  for (var i = 0; i < componentNames.length; i++) {
    var comp = readOneComponent(componentNames[i]);
    if (comp) results.push(comp);
  }
  return results;
}

/**
 * Extract service injections, mixin imports, and helper references from Ember JS source.
 * Returns { services: [], mixins: [], helpers: [] }
 */
function extractJSDependencies(jsContent) {
  if (!jsContent) return { services: [], mixins: [], helpers: [] };
  var deps = { services: [], mixins: [], helpers: [] };

  // ── Service injections ──
  // Patterns: Ember.inject.service('name'), Ember.inject.service(), service: Ember.inject.service('name')
  var svcRegex = /Ember\.inject\.service\(\s*['"]([a-zA-Z0-9_-]+)['"]\s*\)/g;
  var m;
  while ((m = svcRegex.exec(jsContent)) !== null) {
    if (deps.services.indexOf(m[1]) === -1) deps.services.push(m[1]);
  }
  // Also match: property: Ember.inject.service()  (service name = property name)
  var svcImplicit = /([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*Ember\.inject\.service\(\s*\)/g;
  while ((m = svcImplicit.exec(jsContent)) !== null) {
    var svcName = m[1].replace(/([A-Z])/g, function (ch) { return '-' + ch.toLowerCase(); });
    if (deps.services.indexOf(svcName) === -1) deps.services.push(svcName);
  }

  // ── Mixin imports via import statement ──
  // import SomeMixin from '../mixins/some-mixin';
  // import FooMixin from 'app/mixins/foo-mixin';
  var importRegex = /import\s+\w+\s+from\s+['"]((?:\.\.\/?)+|[a-zA-Z0-9_-]+\/)(?:.*\/)?mixins\/([a-zA-Z0-9_/-]+)['"]/g;
  while ((m = importRegex.exec(jsContent)) !== null) {
    if (deps.mixins.indexOf(m[2]) === -1) deps.mixins.push(m[2]);
  }

  // ── Mixin imports via require ──
  // require('../mixins/some-mixin')
  var requireMixinRegex = /require\s*\(\s*['"](?:\.\.\/?)*(?:.*\/)?mixins\/([a-zA-Z0-9_/-]+)['"]\s*\)/g;
  while ((m = requireMixinRegex.exec(jsContent)) !== null) {
    if (deps.mixins.indexOf(m[1]) === -1) deps.mixins.push(m[1]);
  }

  // ── Helper references in templates (extracted from the template HBS side) ──
  // This is called separately for templates; here we just note .extend() mixins
  // e.g., Ember.Component.extend(SomeMixin, { ... })
  var extendMixinRegex = /\.extend\s*\(\s*([A-Z][a-zA-Z0-9_]*(?:\s*,\s*[A-Z][a-zA-Z0-9_]*)*)\s*,/g;
  while ((m = extendMixinRegex.exec(jsContent)) !== null) {
    var mixinNames = m[1].split(/\s*,\s*/);
    for (var mi = 0; mi < mixinNames.length; mi++) {
      var mn = mixinNames[mi].trim();
      if (mn && /^[A-Z]/.test(mn) && mn !== 'Ember' && mn.length > 2) {
        // Convert PascalCase to kebab-case for file lookup
        var kebab = mn.replace(/([A-Z])/g, function (ch, _, idx) {
          return (idx > 0 ? '-' : '') + ch.toLowerCase();
        });
        if (deps.mixins.indexOf(kebab) === -1) deps.mixins.push(kebab);
      }
    }
  }

  return deps;
}

/**
 * Extract helper references from HBS template.
 * Looks for {{helper-name ...}} calls that are NOT components (no dash-prefix or known helpers).
 */
function extractHelperRefs(hbsContent) {
  if (!hbsContent) return [];
  var helpers = [];
  // Match helpers: single-word-with-hyphen usages that are not components
  // Helpers are called like {{format-date value}} or {{my-helper param}}
  // We differentiate from components by checking if a matching component exists
  var regex = /\{\{([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\s/g;
  var m;
  var seen = {};
  while ((m = regex.exec(hbsContent)) !== null) {
    var name = m[1];
    if (!seen[name]) {
      seen[name] = true;
      helpers.push(name);
    }
  }
  return helpers;
}

/**
 * Look up a service file path in both pods and classic layouts.
 * Returns { path, content } or null.
 */
function readServiceFile(serviceName) {
  // Pods: services/service-name.js or pods/services/service-name.js
  // Classic: services/service-name.js
  var candidates = [
    'services/' + serviceName + '.js',
    'pods/services/' + serviceName + '.js'
  ];
  for (var i = 0; i < candidates.length; i++) {
    var fullPath = path.join(config.dir, candidates[i]);
    if (fs.existsSync(fullPath)) {
      try {
        var content = fs.readFileSync(fullPath, 'utf-8');
        if (content.length > 8000) content = content.substring(0, 8000) + '\n// ... truncated ...';
        return { path: candidates[i], content: content };
      } catch (e) { /* skip */ }
    }
  }
  return null;
}

/**
 * Look up a mixin file path.
 * Returns { path, content } or null.
 */
function readMixinFile(mixinName) {
  var candidates = [
    'mixins/' + mixinName + '.js',
    'pods/mixins/' + mixinName + '.js'
  ];
  for (var i = 0; i < candidates.length; i++) {
    var fullPath = path.join(config.dir, candidates[i]);
    if (fs.existsSync(fullPath)) {
      try {
        var content = fs.readFileSync(fullPath, 'utf-8');
        if (content.length > 6000) content = content.substring(0, 6000) + '\n// ... truncated ...';
        return { path: candidates[i], content: content };
      } catch (e) { /* skip */ }
    }
  }
  return null;
}

/**
 * Look up a helper file path.
 * Returns { path, content } or null.
 */
function readHelperFile(helperName) {
  var candidates = [
    'helpers/' + helperName + '.js',
    'pods/helpers/' + helperName + '.js'
  ];
  for (var i = 0; i < candidates.length; i++) {
    var fullPath = path.join(config.dir, candidates[i]);
    if (fs.existsSync(fullPath)) {
      try {
        var content = fs.readFileSync(fullPath, 'utf-8');
        if (content.length > 4000) content = content.substring(0, 4000) + '\n// ... truncated ...';
        return { path: candidates[i], content: content };
      } catch (e) { /* skip */ }
    }
  }
  return null;
}

/**
 * Resolve all JS dependencies (services, mixins, helpers) from loaded components + route JS.
 * Returns { services: [{path, content}], mixins: [{path, content}], helpers: [{path, content}] }
 */
function resolveJSDependencies(componentTemplates, routeJS) {
  var allServices = {};
  var allMixins = {};
  var allHelpers = {};

  // Extract from component JS files
  if (componentTemplates) {
    for (var ci = 0; ci < componentTemplates.length; ci++) {
      var ct = componentTemplates[ci];
      if (ct.jsContent) {
        var deps = extractJSDependencies(ct.jsContent);
        deps.services.forEach(function (s) { allServices[s] = true; });
        deps.mixins.forEach(function (m) { allMixins[m] = true; });
      }
      // Extract helpers from component templates
      if (ct.content) {
        var helperRefs = extractHelperRefs(ct.content);
        helperRefs.forEach(function (h) { allHelpers[h] = true; });
      }
    }
  }

  // Extract from route/controller JS files
  if (routeJS) {
    for (var ri = 0; ri < routeJS.length; ri++) {
      if (routeJS[ri].content) {
        var routeDeps = extractJSDependencies(routeJS[ri].content);
        routeDeps.services.forEach(function (s) { allServices[s] = true; });
        routeDeps.mixins.forEach(function (m) { allMixins[m] = true; });
      }
    }
  }

  // Resolve service files
  var serviceFiles = [];
  Object.keys(allServices).forEach(function (svcName) {
    var svc = readServiceFile(svcName);
    if (svc) serviceFiles.push(svc);
  });

  // Resolve mixin files
  var mixinFiles = [];
  Object.keys(allMixins).forEach(function (mixinName) {
    var mixin = readMixinFile(mixinName);
    if (mixin) mixinFiles.push(mixin);
  });

  // Resolve helper files (only ones that exist as actual helper files, not components)
  var helperFiles = [];
  Object.keys(allHelpers).forEach(function (helperName) {
    var helper = readHelperFile(helperName);
    if (helper) helperFiles.push(helper);
  });

  return {
    services: serviceFiles,
    mixins: mixinFiles,
    helpers: helperFiles
  };
}

/**
 * Read the route JS handler and controller for a route.
 * Supports both pods and classic:
 *   Pods:    pods/settings/integrations/connections/route.js + controller.js
 *   Classic: routes/settings/integrations/connections.js + controllers/...
 */
function readRouteJS(routeFullName) {
  if (!routeFullName) return [];
  var parts = routeFullName.replace(/\./g, '/');
  var files = [];

  // ── Pods layout ──
  var podCandidates = [
    { type: 'route', rel: 'pods/' + parts + '/route.js' },
    { type: 'controller', rel: 'pods/' + parts + '/controller.js' }
  ];

  // ── Classic layout ──
  var classicCandidates = [
    { type: 'route', rel: 'routes/' + parts + '.js' },
    { type: 'controller', rel: 'controllers/' + parts + '.js' }
  ];

  var allCandidates = podCandidates.concat(classicCandidates);
  for (var i = 0; i < allCandidates.length; i++) {
    var fullPath = path.join(config.dir, allCandidates[i].rel);
    if (fs.existsSync(fullPath)) {
      try {
        var content = fs.readFileSync(fullPath, 'utf-8');
        if (content.length > 8000) content = content.substring(0, 8000) + '\n// ... truncated ...';
        files.push({ type: allCandidates[i].type, path: allCandidates[i].rel, content: content });
      } catch (e) { /* skip */ }
    }
  }
  return files;
}

/**
 * Get full template context for a route path.
 * Returns HBS + component templates + route/controller JS.
 * Supports pods layout: pods/{route}/template.hbs, pods/components/{name}/template.hbs
 *
 * Used by server.js to build AI prompt for interaction steps.
 */
function getTemplateContext(routePath) {
  // Strip hash prefix (#/) and normalize
  var cleanPath = normalizeRoutePath(routePath);

  // Find route by path
  var route = findRouteByPath(cleanPath);
  if (!route) {
    // Treat cleaned path segments as a dot-separated fullName
    var guessFullName = cleanPath.replace(/\//g, '.');
    route = { fullName: guessFullName, path: '/' + cleanPath, name: guessFullName.split('.').pop() };
  }

  console.log('[agent] Layer 2 — getTemplateContext for route:', route.fullName, '(' + route.path + ')');

  var template = getTemplateForRoute(route.fullName);
  if (template) {
    console.log('[agent]   ✅ Template found:', template.path, '(' + template.content.length + ' chars)');
  } else {
    console.log('[agent]   ⚠️ No template found for', route.fullName);
  }

  // Extract component references from main template
  var componentNames = template ? extractComponentRefs(template.content) : [];
  console.log('[agent]   Components in template:', componentNames.length, componentNames.length > 0 ? componentNames.join(', ') : '');

  var componentTemplates = readComponentTemplates(componentNames);
  console.log('[agent]   Component templates loaded:', componentTemplates.length);

  // Also extract 1-level-deep nested components from loaded component templates
  var allKnown = {};
  componentNames.forEach(function (n) { allKnown[n] = true; });
  var nestedNames = [];
  componentTemplates.forEach(function (ct) {
    var nested = extractComponentRefs(ct.content);
    nested.forEach(function (n) {
      if (!allKnown[n]) {
        allKnown[n] = true;
        nestedNames.push(n);
      }
    });
  });
  if (nestedNames.length > 0) {
    console.log('[agent]   Nested components (depth 2):', nestedNames.join(', '));
    var nestedTemplates = readComponentTemplates(nestedNames);
    componentTemplates = componentTemplates.concat(nestedTemplates);
    console.log('[agent]   Nested templates loaded:', nestedTemplates.length);
  }

  // Limit total component templates to avoid huge prompts
  if (componentTemplates.length > 15) {
    console.log('[agent]   Limiting to 15 component templates (had', componentTemplates.length + ')');
    componentTemplates = componentTemplates.slice(0, 15);
  }

  var routeJS = readRouteJS(route.fullName);
  console.log('[agent]   Route/controller JS files:', routeJS.length);

  // ── Resolve JS dependencies (services, mixins, helpers) from all loaded JS ──
  var jsDeps = resolveJSDependencies(componentTemplates, routeJS);
  console.log('[agent]   JS dependencies: services=' + jsDeps.services.length +
    ', mixins=' + jsDeps.mixins.length + ', helpers=' + jsDeps.helpers.length);
  if (jsDeps.services.length > 0) console.log('[agent]     Services:', jsDeps.services.map(function (s) { return s.path; }).join(', '));
  if (jsDeps.mixins.length > 0) console.log('[agent]     Mixins:', jsDeps.mixins.map(function (m) { return m.path; }).join(', '));
  if (jsDeps.helpers.length > 0) console.log('[agent]     Helpers:', jsDeps.helpers.map(function (h) { return h.path; }).join(', '));

  // Also extract helpers from the main route template
  var mainHelpers = [];
  if (template) {
    var mainHelperRefs = extractHelperRefs(template.content);
    mainHelperRefs.forEach(function (h) {
      var helper = readHelperFile(h);
      if (helper) {
        // Avoid duplicates
        var alreadyIncluded = false;
        for (var di = 0; di < jsDeps.helpers.length; di++) {
          if (jsDeps.helpers[di].path === helper.path) { alreadyIncluded = true; break; }
        }
        if (!alreadyIncluded) mainHelpers.push(helper);
      }
    });
  }
  if (mainHelpers.length > 0) {
    jsDeps.helpers = jsDeps.helpers.concat(mainHelpers);
    console.log('[agent]     Main template helpers:', mainHelpers.map(function (h) { return h.path; }).join(', '));
  }

  return {
    route: route,
    template: template,
    componentTemplates: componentTemplates,
    routeJS: routeJS,
    dependencies: jsDeps,
    totalTemplates: (template ? 1 : 0) + componentTemplates.length,
    hasTemplate: !!template
  };
}

/**
 * Generate a standalone Puppeteer reproduction script for a bug.
 * Uses puppeteer-core + locally installed Chrome/Edge.
 * Returns { testCode, testFile } or { error }.
 */
function generateReproScript(bugId, bugTitle, bugDescription, devServerUrl, testUsername, testPassword, targetRoute, interactionSteps) {
  var testFile = path.join(PROMPTS_DIR, 'bug_' + bugId + '_repro.js');
  var baseUrl = devServerUrl || 'https://localhost:4200';
  var screenshotPath = path.join(PROMPTS_DIR, 'bug_' + bugId + '_screenshot.png').replace(/\\/g, '/');
  var browserPath = findBrowserPath();
  interactionSteps = interactionSteps || [];

  // Auto-detect target route from bug keywords if not manually specified
  if (!targetRoute) {
    var routes = getCachedRoutes();
    targetRoute = matchBugToRoute(bugTitle, bugDescription, routes);
  }
  // Clean the route — ensure it starts with / and remove any leading BASE_URL
  if (targetRoute) {
    targetRoute = targetRoute.replace(/^https?:\/\/[^/]+/, '');  // strip origin if full URL
    if (targetRoute.charAt(0) !== '/') targetRoute = '/' + targetRoute;
    // Remove dynamic segments like :tab_id  — replace with sensible defaults
    targetRoute = targetRoute.replace(/\/:[^/]+/g, '');
    console.log('[agent] 📍 Target route for reproduction:', targetRoute);
  }

  if (!browserPath) {
    return { error: 'No Chrome or Edge browser found. Set CHROME_PATH environment variable.' };
  }

  var L = [];  // lines
  L.push('// Auto-generated reproduction script for Bug: ' + (bugTitle || bugId));
  L.push('// Generated: ' + new Date().toISOString());
  L.push('// Uses puppeteer-core with local Chrome/Edge — Node 8+ compatible');
  L.push('var puppeteer = require(' + JSON.stringify(getPuppeteerCorePath().replace(/\\/g, '/')) + ');');
  L.push('');
  L.push('var BROWSER_PATH = ' + JSON.stringify(browserPath) + ';');
  L.push('var BASE_URL = ' + JSON.stringify(baseUrl) + ';');
  L.push('var TARGET_ROUTE = ' + JSON.stringify(targetRoute || '') + ';  // Route to navigate after login');
  L.push('var SCREENSHOT = ' + JSON.stringify(screenshotPath) + ';');
  L.push('');
  L.push('function run() {');
  L.push('  var result = { passed: false, errors: [], assertions: [], title: "", pageUrl: "", navigationOk: false };');
  L.push('  var browser;');
  L.push('');
  L.push('  return puppeteer.launch({');
  L.push('    executablePath: BROWSER_PATH,');
  L.push('    headless: true,');
  L.push('    args: ["--ignore-certificate-errors", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]');
  L.push('  }).then(function (b) {');
  L.push('    browser = b;');
  L.push('    return browser.newPage();');
  L.push('  }).then(function (page) {');
  L.push('    // Capture JS errors on the page');
  L.push('    page.on("pageerror", function (err) { result.errors.push(err.message || String(err)); });');
  L.push('    page.on("error", function (err) { result.errors.push(err.message || String(err)); });');
  L.push('');

  // ── Login step ──
  if (testUsername && testPassword) {
    L.push('    // ── Step 1: Login ──');
    L.push('    // Use networkidle2 (allows 2 outstanding connections) — SSO pages keep background requests alive');
    L.push('    return page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 60000 })');
    L.push('    .then(function () {');
    L.push('      // Page may redirect to SSO/login — wait for it to settle');
    L.push('      return new Promise(function (r) { setTimeout(r, 3000); });');
    L.push('    })');
    L.push('    .then(function () {');
    L.push('      // Take a debug screenshot to see what the login page looks like');
    L.push('      return page.screenshot({ path: SCREENSHOT.replace(".png", "_login_debug.png") }).catch(function () {});');
    L.push('    })');
    L.push('    .then(function () {');
    L.push('      // Log current URL (may have redirected to SSO)');
    L.push('      console.log("Login page URL: " + page.url());');
    L.push('      // Wait for the Zoho SSO login field specifically (id=login_id)');
    L.push('      // Do NOT use generic "input" with visible:true — the SSO page has many hidden inputs');
    L.push('      // that confuse Puppeteer visibility checks');
    L.push('      var loginSelectors = [');
    L.push('        "#login_id",');
    L.push('        "#userid",');
    L.push('        "input[name=LOGIN_ID]",');
    L.push('        "input[name=login_id]",');
    L.push('        "input[type=email]",');
    L.push('        "input[type=text]:not([style*=\\"display: none\\"])"');
    L.push('      ];');
    L.push('      // Poll for any of these selectors to appear (check every 500ms, up to 30s)');
    L.push('      var attempts = 0;');
    L.push('      var maxAttempts = 60;');
    L.push('      function pollForLogin() {');
    L.push('        function trySelector(i) {');
    L.push('          if (i >= loginSelectors.length) return Promise.resolve(null);');
    L.push('          return page.$(loginSelectors[i]).then(function (el) {');
    L.push('            if (el) return { el: el, selector: loginSelectors[i] };');
    L.push('            return trySelector(i + 1);');
    L.push('          });');
    L.push('        }');
    L.push('        return trySelector(0).then(function (found) {');
    L.push('          if (found) return found;');
    L.push('          attempts++;');
    L.push('          if (attempts >= maxAttempts) return null;');
    L.push('          return new Promise(function (r) { setTimeout(r, 500); }).then(pollForLogin);');
    L.push('        });');
    L.push('      }');
    L.push('      return pollForLogin();');
    L.push('    })');
    L.push('    .then(function (found) {');
    L.push('      if (!found) {');
    L.push('        // Dump all input elements for debugging');
    L.push('        return page.$$eval("input", function (inputs) {');
    L.push('          return inputs.map(function (i) {');
    L.push('            var rect = i.getBoundingClientRect();');
    L.push('            return { id: i.id, name: i.name, type: i.type, class: i.className,');
    L.push('              visible: rect.width > 0 && rect.height > 0,');
    L.push('              display: window.getComputedStyle(i).display,');
    L.push('              visibility: window.getComputedStyle(i).visibility };');
    L.push('          });');
    L.push('        }).then(function (info) {');
    L.push('          console.log("All inputs on page: " + JSON.stringify(info, null, 2));');
    L.push('          throw new Error("Could not find login field after 30s. URL: " + page.url());');
    L.push('        });');
    L.push('      }');
    L.push('      console.log("Found username field: " + found.selector);');
    L.push('      return found.el.click({ clickCount: 3 }).then(function () {');
    L.push('        return page.keyboard.type(' + JSON.stringify(testUsername) + ');');
    L.push('      });');
    L.push('    })');
    L.push('    .then(function () {');
    L.push('      // Look for submit/next button and click it');
    L.push('      var btnSelectors = ["#nextbtn", "button[type=submit]", "input[type=submit]", "button[id*=next]", "button[id*=login]", ".btn-primary", "button.login"];');
    L.push('      function findBtn(i) {');
    L.push('        if (i >= btnSelectors.length) return Promise.resolve(null);');
    L.push('        return page.$(btnSelectors[i]).then(function (el) {');
    L.push('          if (el) { console.log("Found submit button: " + btnSelectors[i]); return el; }');
    L.push('          return findBtn(i + 1);');
    L.push('        });');
    L.push('      }');
    L.push('      return findBtn(0);');
    L.push('    })');
    L.push('    .then(function (submitBtn) {');
    L.push('      if (!submitBtn) {');
    L.push('        console.log("No submit button found, pressing Enter instead");');
    L.push('        return page.keyboard.press("Enter");');
    L.push('      }');
    L.push('      return submitBtn.click();');
    L.push('    })');
    L.push('    .then(function () {');
    L.push('      // Wait for page to transition (password step or dashboard)');
    L.push('      return new Promise(function (r) { setTimeout(r, 4000); });');
    L.push('    })');
    L.push('    .then(function () {');
    L.push('      // Check if password field appeared (two-step login) — poll for it');
    L.push('      return page.waitForSelector("#password, input[type=password]", { timeout: 10000 }).catch(function () { return null; });');
    L.push('    })');
    L.push('    .then(function (pwEl) {');
    L.push('      if (!pwEl) {');
    L.push('        // Try one more direct check');
    L.push('        return page.$("#password").then(function (el) {');
    L.push('          if (el) return el;');
    L.push('          return page.$("input[type=password]");');
    L.push('        });');
    L.push('      }');
    L.push('      return pwEl;');
    L.push('    })');
    L.push('    .then(function (pwEl) {');
    L.push('      if (!pwEl) {');
    L.push('        console.log("No password field found — may already be logged in or single-step login");');
    L.push('        return;');
    L.push('      }');
    L.push('      console.log("Password field found — filling password");');
    L.push('      return pwEl.click({ clickCount: 3 })');
    L.push('        .then(function () { return page.keyboard.type(' + JSON.stringify(testPassword) + '); })');
    L.push('        .then(function () {');
    L.push('          // Find and click sign-in button');
    L.push('          var btnSelectors = ["#nextbtn", "button[type=submit]", "input[type=submit]", "button[id*=next]", "button[id*=sign]", ".btn-primary"];');
    L.push('          function findBtn2(i) {');
    L.push('            if (i >= btnSelectors.length) return Promise.resolve(null);');
    L.push('            return page.$(btnSelectors[i]).then(function (el) { return el || findBtn2(i + 1); });');
    L.push('          }');
    L.push('          return findBtn2(0);');
    L.push('        })');
    L.push('        .then(function (btn) {');
    L.push('          if (!btn) return page.keyboard.press("Enter");');
    L.push('          return btn.click();');
    L.push('        })');
    L.push('        .then(function () {');
    L.push('          // Wait for post-login navigation');
    L.push('          return page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(function () {});');
    L.push('        });');
    L.push('    })');
    L.push('    .then(function () {');
    L.push('      console.log("Post-login URL: " + page.url());');
    L.push('      return new Promise(function (r) { setTimeout(r, 3000); });  // let app initialize');
    L.push('    })');
    L.push('    .then(function () {');
  } else {
    // No credentials — just navigate
    L.push('    // ── Navigate (no credentials configured) ──');
    L.push('    return page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 60000 })');
    L.push('    .then(function () {');
  }

  // ── Route navigation step (after login OR after initial navigation) ──
  // Navigate to BASE_URL/#/route — after SSO login, shared domain cookies
  // mean the dev server recognizes the session without re-auth.
  L.push('      // ── Step 2: Navigate to bug\'s page ──');
  L.push('      if (TARGET_ROUTE) {');
  L.push('        var targetUrl = BASE_URL.replace(/\\/+$/, "") + "/#" + TARGET_ROUTE;');
  L.push('        console.log("Navigating to target route: " + targetUrl);');
  L.push('        return page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 })');
  L.push('          .then(function () {');
  L.push('            return new Promise(function (r) { setTimeout(r, 5000); });');
  L.push('          })');
  L.push('          .then(function () {');
  L.push('            var currentUrl = page.url();');
  L.push('            console.log("On target page: " + currentUrl);');
  L.push('            var routeSegments = TARGET_ROUTE.replace(/^\\//, "").split("/");');
  L.push('            var lastSeg = routeSegments[routeSegments.length - 1] || "";');
  L.push('            if (currentUrl.indexOf(lastSeg) !== -1) {');
  L.push('              result.navigationOk = true;');
  L.push('              console.log("\\u2705 Navigation verified");');
  L.push('            } else {');
  L.push('              return page.evaluate(function () { return window.location.hash; }).then(function (hash) {');
  L.push('                console.log("URL hash: " + hash);');
  L.push('                if (hash && hash.indexOf(lastSeg) !== -1) {');
  L.push('                  result.navigationOk = true;');
  L.push('                  console.log("\\u2705 Navigation OK via hash");');
  L.push('                } else {');
  L.push('                  result.navigationOk = false;');
  L.push('                  console.log("\\u26a0\\ufe0f Navigation may have failed");');
  L.push('                  console.log("   Expected: " + lastSeg + " | URL: " + currentUrl + " | Hash: " + hash);');
  L.push('                }');
  L.push('              });');
  L.push('            }');
  L.push('          })');
  L.push('          .then(function () {');
  L.push('            return page.screenshot({ path: SCREENSHOT.replace(".png", "_route_debug.png") }).catch(function () {});');
  L.push('          });');
  L.push('      } else {');
  L.push('        result.navigationOk = true;');
  L.push('        console.log("No target route \\u2014 staying on current page: " + page.url());');
  L.push('        return Promise.resolve();');
  L.push('      }');
  L.push('    })');
  L.push('    .then(function () {');

  // ── Layer 2: AI-generated interaction steps ──
  if (interactionSteps && interactionSteps.length > 0) {
    L.push('      // ── Step 3: AI-generated interaction steps (' + interactionSteps.length + ' steps) ──');
    L.push('      console.log("Executing " + ' + JSON.stringify(String(interactionSteps.length)) + ' + " AI-generated interaction steps...");');
    L.push('      var interactionErrors = [];');
    L.push('      return Promise.resolve()');
    for (var si = 0; si < interactionSteps.length; si++) {
      var step = interactionSteps[si];
      var stepNum = si + 1;
      var desc = (step.description || step.action || 'step').replace(/'/g, "\\'").replace(/"/g, '\\"');
      L.push('      .then(function () {');
      L.push('        console.log("  Step ' + stepNum + '/' + interactionSteps.length + ': ' + desc + '");');

      if (step.action === 'click') {
        L.push('        return page.click(' + JSON.stringify(step.selector || 'body') + ').catch(function (e) {');
        L.push('          console.log("    ⚠ Click failed: " + e.message);');
        L.push('          interactionErrors.push("Step ' + stepNum + ' click failed: " + e.message);');
        L.push('        });');
      } else if (step.action === 'type') {
        L.push('        return page.click(' + JSON.stringify(step.selector || 'body') + ').then(function () {');
        L.push('          return page.type(' + JSON.stringify(step.selector || 'body') + ', ' + JSON.stringify(step.text || '') + ');');
        L.push('        }).catch(function (e) {');
        L.push('          console.log("    ⚠ Type failed: " + e.message);');
        L.push('          interactionErrors.push("Step ' + stepNum + ' type failed: " + e.message);');
        L.push('        });');
      } else if (step.action === 'waitForSelector') {
        L.push('        return page.waitForSelector(' + JSON.stringify(step.selector || 'body') + ', { timeout: ' + (step.timeout || 10000) + ' }).catch(function (e) {');
        L.push('          console.log("    ⚠ Wait failed: " + e.message);');
        L.push('          interactionErrors.push("Step ' + stepNum + ' wait failed: " + e.message);');
        L.push('        });');
      } else if (step.action === 'select') {
        L.push('        return page.select(' + JSON.stringify(step.selector || 'select') + ', ' + JSON.stringify(step.value || '') + ').catch(function (e) {');
        L.push('          console.log("    ⚠ Select failed: " + e.message);');
        L.push('          interactionErrors.push("Step ' + stepNum + ' select failed: " + e.message);');
        L.push('        });');
      } else if (step.action === 'wait') {
        L.push('        return new Promise(function (r) { setTimeout(r, ' + (step.ms || 1000) + '); });');
      } else if (step.action === 'screenshot') {
        var ssName = (step.name || 'step_' + stepNum).replace(/[^a-zA-Z0-9_-]/g, '_');
        L.push('        return page.screenshot({ path: SCREENSHOT.replace(".png", "_' + ssName + '.png") }).catch(function () {});');
      } else if (step.action === 'hover') {
        L.push('        return page.hover(' + JSON.stringify(step.selector || 'body') + ').catch(function (e) {');
        L.push('          console.log("    ⚠ Hover failed: " + e.message);');
        L.push('          interactionErrors.push("Step ' + stepNum + ' hover failed: " + e.message);');
        L.push('        });');
      } else if (step.action === 'assert') {
        // Assertion step — checks element attribute/text against expected value
        var assertSel = JSON.stringify(step.selector || 'body');
        var assertAttr = step.attribute || 'textContent';
        var assertExpected = step.expected || '';
        var assertCompare = step.compare || 'equals';
        L.push('        return page.$(' + assertSel + ').then(function (el) {');
        L.push('          if (!el) {');
        L.push('            console.log("    ⚠ Assert element not found: ' + (step.selector || 'body').replace(/"/g, '\\"') + '");');
        L.push('            result.assertions.push({ step: ' + stepNum + ', status: "element-not-found", selector: ' + assertSel + ' });');
        L.push('            return;');
        L.push('          }');
        if (assertAttr === 'textContent' || assertAttr === 'innerText') {
          L.push('          return page.evaluate(function (el) { return (el.' + assertAttr + ' || "").trim(); }, el).then(function (actual) {');
        } else {
          L.push('          return page.evaluate(function (el, attr) { return (el.getAttribute(attr) || "").trim(); }, el, ' + JSON.stringify(assertAttr) + ').then(function (actual) {');
        }
        L.push('            console.log("    Assert: ' + assertAttr + ' = \'" + actual + "\'");');
        if (assertCompare === 'contains') {
          L.push('            var matched = actual.toLowerCase().indexOf(' + JSON.stringify(assertExpected.toLowerCase()) + ') !== -1;');
        } else {
          L.push('            var matched = actual.toLowerCase() === ' + JSON.stringify(assertExpected.toLowerCase()) + ';');
        }
        L.push('            result.assertions.push({');
        L.push('              step: ' + stepNum + ',');
        L.push('              attribute: ' + JSON.stringify(assertAttr) + ',');
        L.push('              expected: ' + JSON.stringify(assertExpected) + ',');
        L.push('              actual: actual,');
        L.push('              matched: matched,');
        L.push('              description: ' + JSON.stringify(desc) + '');
        L.push('            });');
        L.push('            if (matched) {');
        L.push('              console.log("    ✅ ASSERT MATCHED — bug condition confirmed");');
        L.push('            } else {');
        L.push('              console.log("    ❌ ASSERT DID NOT MATCH — expected ' + assertExpected.replace(/'/g, '\\\'') + ' but got " + actual);');
        L.push('            }');
        L.push('          });');
        L.push('        }).catch(function (e) {');
        L.push('          console.log("    ⚠ Assert failed: " + e.message);');
        L.push('          interactionErrors.push("Step ' + stepNum + ' assert failed: " + e.message);');
        L.push('        });');
      } else {
        L.push('        console.log("    Unknown action: ' + (step.action || 'none') + '");');
        L.push('        return Promise.resolve();');
      }

      L.push('      })');
      // Small delay between steps for page to react
      if (si < interactionSteps.length - 1) {
        L.push('      .then(function () { return new Promise(function (r) { setTimeout(r, ' + (step.delayAfter || 500) + '); }); })');
      }
    }
    L.push('      .then(function () {');
    L.push('        console.log("Interaction steps complete. Errors: " + interactionErrors.length);');
    L.push('        if (interactionErrors.length > 0) {');
    L.push('          interactionErrors.forEach(function (e) { result.errors.push(e); });');
    L.push('        }');
    L.push('        // Wait for any async UI updates after interactions');
    L.push('        return new Promise(function (r) { setTimeout(r, 2000); });');
    L.push('      });');
    L.push('    })');
    L.push('    .then(function () {');
  }

  // ── Common reproduction body ──
  L.push('      // Bug: ' + (bugDescription || 'No description').replace(/\n/g, ' ').substring(0, 200));
  L.push('      result.pageUrl = page.url();');
  L.push('      return page.title();');
  L.push('    })');
  L.push('    .then(function (t) {');
  L.push('      result.title = t;');
  L.push('      // Wait a bit for any late errors');
  L.push('      return new Promise(function (r) { setTimeout(r, 2000); });')
  L.push('    })');
  L.push('    .then(function () {');
  L.push('      return page.screenshot({ path: SCREENSHOT }).catch(function () {});');
  L.push('    })');
  L.push('    .then(function () {');
  L.push('      // Determine result based on assertions + errors');
  L.push('      var bugAssertions = result.assertions.filter(function (a) { return a.matched; });');
  L.push('      if (bugAssertions.length > 0) {');
  L.push('        // At least one assertion confirmed the buggy behavior');
  L.push('        result.passed = false;');
  L.push('        result.bugConfirmed = true;');
  L.push('        console.log("BUG CONFIRMED by " + bugAssertions.length + " assertion(s)");');
  L.push('      } else if (result.assertions.length > 0) {');
  L.push('        // Assertions ran but none matched bug condition');
  L.push('        result.passed = true;');
  L.push('        result.bugConfirmed = false;');
  L.push('        console.log("Assertions ran but bug condition NOT found");');
  L.push('      } else {');
  L.push('        // No assertions — rely on error count');
  L.push('        result.passed = result.errors.length === 0;');
  L.push('        result.bugConfirmed = false;');
  L.push('        if (!result.navigationOk) {');
  L.push('          result.passed = false;');
  L.push('          console.log("Test FAILED due to navigation failure");');
  L.push('        }');
  L.push('      }');
  L.push('      return browser.close();');
  L.push('    })');
  L.push('    .then(function () { return result; });');
  L.push('  });');
  L.push('}');
  L.push('');
  L.push('run().then(function (r) {');
  L.push('  // Output result as JSON on a tagged line so the runner can parse it');
  L.push('  console.log("__REPRO_RESULT__" + JSON.stringify(r));');
  L.push('  process.exit(r.passed ? 0 : 1);');
  L.push('}).catch(function (e) {');
  L.push('  console.error("Reproduction error:", e.message || e);');
  L.push('  console.log("__REPRO_RESULT__" + JSON.stringify({ passed: false, errors: [e.message || String(e)] }));');
  L.push('  process.exit(1);');
  L.push('});');
  L.push('');

  var testCode = L.join('\n');

  try {
    fs.writeFileSync(testFile, testCode, 'utf-8');
    return { testCode: testCode, testFile: 'bug_' + bugId + '_repro.js' };
  } catch (e) {
    return { error: 'Failed to write script file: ' + e.message };
  }
}

/**
 * Run a reproduction script and return pass/fail + output.
 * Uses plain `node script.js` — works on Node 8+.
 * callback(err, { passed, output, duration, screenshotFile })
 */
function runReproScript(testFileName, callback) {
  var testFile = path.join(PROMPTS_DIR, testFileName);
  if (!fs.existsSync(testFile)) {
    return callback(new Error('Script file not found: ' + testFileName));
  }

  // Ensure puppeteer-core is installed first
  ensurePuppeteer(function (installErr) {
    if (installErr) {
      return callback(null, {
        passed: false,
        output: 'Could not install puppeteer-core: ' + installErr.message,
        duration: 0,
        screenshotFile: null,
        exitCode: -1
      });
    }

    var startTime = Date.now();
    var cmd = 'node "' + testFile.replace(/\\/g, '/') + '"';

    childProcess.exec(cmd, {
      cwd: BUG_TRACKER_DATA_DIR,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 90000
    }, function (err, stdout, stderr) {
      var duration = Date.now() - startTime;
      var fullOutput = (stdout || '') + '\n' + (stderr || '');
      var passed = !err;

      // Try to parse structured result from output
      var resultMatch = fullOutput.match(/__REPRO_RESULT__(\{.*\})/);
      var bugConfirmed = false;
      var assertions = [];
      var navigationOk = true;
      if (resultMatch) {
        try {
          var parsed = JSON.parse(resultMatch[1]);
          passed = parsed.passed;
          bugConfirmed = !!parsed.bugConfirmed;
          assertions = parsed.assertions || [];
          navigationOk = parsed.navigationOk !== false;
          if (parsed.errors && parsed.errors.length) {
            fullOutput += '\nPage errors: ' + parsed.errors.join('; ');
          }
        } catch (e) { /* ignore parse error */ }
      }

      // Check for screenshot
      var bugIdPart = path.basename(testFileName).replace('_repro.js', '').replace('_test.spec.js', '');
      var screenshotFile = path.join(PROMPTS_DIR, bugIdPart + '_screenshot.png');
      var hasScreenshot = fs.existsSync(screenshotFile);

      callback(null, {
        passed: passed,
        bugConfirmed: bugConfirmed,
        assertions: assertions,
        navigationOk: navigationOk,
        pageUrl: parsed ? parsed.pageUrl : null,
        output: fullOutput.substring(0, 5000),
        duration: duration,
        screenshotFile: hasScreenshot ? path.basename(screenshotFile) : null,
        exitCode: err ? err.code : 0
      });
    });
  });
}

/**
 * Save a prompt log for a bug analysis.
 */
function savePromptLog(bugId, data) {
  var logFile = path.join(PROMPTS_DIR, 'bug_' + bugId + '.json');
  data.savedAt = new Date().toISOString();
  try {
    fs.writeFileSync(logFile, JSON.stringify(data, null, 2), 'utf-8');
    return { success: true, file: 'bug_' + bugId + '.json' };
  } catch (e) {
    return { error: 'Failed to save prompt log: ' + e.message };
  }
}

/**
 * Load a prompt log for a bug.
 */
function loadPromptLog(bugId) {
  var logFile = path.join(PROMPTS_DIR, 'bug_' + bugId + '.json');
  if (!fs.existsSync(logFile)) {
    return { found: false };
  }
  try {
    var data = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    data.found = true;
    return data;
  } catch (e) {
    return { found: false, error: e.message };
  }
}

function execGit(args, callback) {
  var cmd = 'git ' + args;
  childProcess.exec(cmd, { cwd: config.dir, maxBuffer: 5 * 1024 * 1024, timeout: 30000 }, function (err, stdout, stderr) {
    callback(err, (stdout || '').trim(), (stderr || '').trim());
  });
}

function getGitStatus(callback) {
  execGit('status --porcelain', function (err, stdout) {
    if (err) return callback(err);
    var files = stdout.split('\n').filter(Boolean).map(function (line) {
      var status = line.substring(0, 2).trim();
      var file = line.substring(3);
      var label = 'modified';
      if (status === '??') label = 'untracked';
      else if (status === 'A') label = 'added';
      else if (status === 'D') label = 'deleted';
      else if (status === 'R') label = 'renamed';
      return { file: file, status: status, label: label };
    });
    // Also get current branch
    execGit('rev-parse --abbrev-ref HEAD', function (brErr, branch) {
      callback(null, { branch: branch || 'unknown', files: files });
    });
  });
}

function gitCommit(message, filePaths, callback) {
  if (!message) return callback(new Error('Commit message is required'));
  // Stage the specified files (or all if none specified)
  var stageCmd = (filePaths && filePaths.length > 0)
    ? 'add -- ' + filePaths.map(function(f){ return '"' + f + '"'; }).join(' ')
    : 'add -A';
  execGit(stageCmd, function (stageErr) {
    if (stageErr) return callback(new Error('Stage failed: ' + stageErr.message));
    execGit('commit --no-verify -m "' + message.replace(/"/g, '\\"') + '"', function (commitErr, stdout, stderr) {
      if (commitErr) {
        // "nothing to commit" is not a real error
        if ((stderr + stdout).indexOf('nothing to commit') !== -1) {
          return callback(null, { success: false, message: 'Nothing to commit' });
        }
        return callback(new Error('Commit failed: ' + (stderr || commitErr.message)));
      }
      callback(null, { success: true, message: stdout });
    });
  });
}

function readAgentBody(req, callback) {
  var body = '';
  req.on('data', function (chunk) { body += chunk; });
  req.on('end', function () {
    try { callback(null, body ? JSON.parse(body) : {}); }
    catch (e) { callback(new Error('Invalid JSON')); }
  });
}

// ── HTTP server ──────────────────────────────────────────

function sendJSON(res, code, data) {
  var body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': config.allowOrigins,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function handleRequest(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': config.allowOrigins,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;
  var query = parsed.query;

  // GET /health
  if (pathname === '/health') {
    sendJSON(res, 200, {
      ok: true,
      name: config.name,
      projectDir: config.dir,
      port: config.port,
      extensions: config.extensions,
      nodeVersion: process.version,
      browserPath: findBrowserPath() || null,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // GET /stats
  if (pathname === '/stats') {
    sendJSON(res, 200, getStats());
    return;
  }

  // GET /routes — return parsed Ember routes for UI dropdown
  if (pathname === '/routes') {
    var routes = getCachedRoutes();
    sendJSON(res, 200, { routes: routes });
    return;
  }

  // GET /routes/match?title=...&description=...&module=...&page=... — auto-match bug to a route
  if (pathname === '/routes/match') {
    var matchTitle = query.title || '';
    var matchDesc = query.description || '';
    var matchModule = query.module || '';
    var matchPage = query.page || '';
    var routes2 = getCachedRoutes();

    // If explicit page param given (from parsed description), try direct page match first
    if (matchPage) {
      var directPageResult = matchPageNameToRoute(matchPage, routes2);
      if (directPageResult) {
        console.log('[agent] 🎯 Direct page match:', matchPage, '→', directPageResult.route.path);
        sendJSON(res, 200, {
          matchedRoute: directPageResult.route.path,
          method: 'direct-page',
          score: directPageResult.score,
          totalRoutes: routes2.length
        });
        return;
      }
    }

    var result = matchBugToRoute(matchTitle, matchDesc, routes2, matchModule);
    sendJSON(res, 200, {
      matchedRoute: result.matchedRoute,
      method: result.method || 'keyword',
      score: result.score || 0,
      parsedDesc: result.parsedDesc || null,
      totalRoutes: routes2.length
    });
    return;
  }

  // GET /template-context?route=/settings/playbooks — Layer 2: get HBS + components + route JS
  if (pathname === '/template-context') {
    var routeParam = query.route || '';
    if (!routeParam) { sendJSON(res, 400, { error: 'Missing ?route= parameter' }); return; }
    console.log('[agent] GET /template-context route=' + routeParam);
    var templateCtx = getTemplateContext(routeParam);
    sendJSON(res, 200, templateCtx);
    return;
  }

  // GET /search?q=...
  if (pathname === '/search') {
    var q = query.q || '';
    if (!q) { sendJSON(res, 400, { error: 'Missing ?q=' }); return; }
    console.log('[agent] 🔍 Search files:', q);
    var searchResult = searchFiles(q);
    console.log('[agent]   → Found', searchResult.length, 'files');
    sendJSON(res, 200, { files: searchResult });
    return;
  }

  // GET /grep?q=...
  if (pathname === '/grep') {
    var gq = query.q || '';
    if (!gq) { sendJSON(res, 400, { error: 'Missing ?q=' }); return; }
    console.log('[agent] 🔎 Grep:', gq);
    var grepResult = grepFiles(gq, { isRegex: query.regex === '1' });
    console.log('[agent]   → Found', grepResult.length, 'matches');
    sendJSON(res, 200, { matches: grepResult });
    return;
  }

  // GET /read-file?path=...
  if (pathname === '/read-file') {
    var fp = query.path || '';
    if (!fp) { sendJSON(res, 400, { error: 'Missing ?path=' }); return; }
    console.log('[agent] 📄 Read file:', fp);
    var start = query.start ? parseInt(query.start, 10) : undefined;
    var end = query.end ? parseInt(query.end, 10) : undefined;
    var result = readFile(fp, start, end);
    if (result.error) { console.log('[agent]   ❌', result.error); sendJSON(res, 400, result); return; }
    console.log('[agent]   →', result.totalLines, 'lines');
    sendJSON(res, 200, result);
    return;
  }

  // GET /analyze?keywords=kw1,kw2,...&codeKeywords=ck1,ck2,...
  if (pathname === '/analyze') {
    var kwStr = query.keywords || '';
    if (!kwStr) { sendJSON(res, 400, { error: 'Missing ?keywords=' }); return; }
    var keywords = kwStr.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
    console.log('');
    console.log('[agent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[agent] 🔎 ANALYZE request received');
    console.log('[agent]   Keywords (' + keywords.length + '):', keywords.join(', '));
    var _agentAnalyzeStart = Date.now();
    var keywords = kwStr.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
    // Receive code-identifier keyword metadata for weighted scoring
    var codeKwStr = query.codeKeywords || '';
    var codeKwSet = {};
    if (codeKwStr) {
      codeKwStr.split(',').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean)
        .forEach(function (k) { codeKwSet[k] = true; });
    }
    keywords._codeKeywords = codeKwSet;
    var analyzeResult = analyzeForBug(keywords);
    console.log('[agent]   Relevant files:', (analyzeResult.relevantFiles || []).length);
    console.log('[agent]   Code matches:', (analyzeResult.codeMatches || []).length);
    console.log('[agent]   File contents loaded:', (analyzeResult.fileContents || []).length);
    if (analyzeResult.relevantFiles && analyzeResult.relevantFiles.length > 0) {
      console.log('[agent]   Top files:');
      analyzeResult.relevantFiles.slice(0, 5).forEach(function (f) {
        console.log('[agent]     - ' + f);
      });
    }
    console.log('[agent]   Scan time:', (Date.now() - _agentAnalyzeStart) + 'ms');
    console.log('[agent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    sendJSON(res, 200, analyzeResult);
    return;
  }

  // POST /write-file  { path, content } — legacy direct write, now with backup
  if (pathname === '/write-file' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.path) { sendJSON(res, 400, { error: 'Missing path' }); return; }
      console.log('[agent] ✏️ Write file:', body.path);
      var fullPath = path.resolve(config.dir, body.path);
      if (!isInsideRoot(config.dir, fullPath)) {
        sendJSON(res, 403, { error: 'Path is outside project directory' }); return;
      }
      // Create backup before overwriting
      try { patchUtils.createBackup(config.dir, body.path); }
      catch (e) { console.error('[agent] Backup failed:', e.message); }
      try {
        fs.writeFileSync(fullPath, body.content || '', 'utf-8');
        sendJSON(res, 200, { success: true, file: body.path });
      } catch (e) {
        sendJSON(res, 500, { error: 'Write failed: ' + e.message });
      }
    });
    return;
  }

  // POST /apply-patch  { path, code, force } — smart patch-based modification with backup
  if (pathname === '/apply-patch' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.path || !body.code) { sendJSON(res, 400, { error: 'Missing path or code' }); return; }
      console.log('[agent] 🩹 Apply patch:', body.path);
      var fullPath = path.resolve(config.dir, body.path);
      if (!isInsideRoot(config.dir, fullPath)) {
        sendJSON(res, 403, { error: 'Path is outside project directory' }); return;
      }

      // Read original file
      var originalText = '';
      var fileExists = fs.existsSync(fullPath);
      if (fileExists) {
        try { originalText = fs.readFileSync(fullPath, 'utf-8'); }
        catch (e) { sendJSON(res, 500, { error: 'Cannot read file: ' + e.message }); return; }
      }

      // Compute smart merge
      var mergeResult = patchUtils.applySmartMerge(originalText, body.code, {
        fileName: body.path
      });

      // If merge failed and force is not set, return diff for review
      if (!mergeResult.success && !body.force) {
        sendJSON(res, 200, {
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
        return;
      }

      // Create backup before writing
      if (fileExists) {
        try { patchUtils.createBackup(config.dir, body.path); }
        catch (e) { console.error('[agent] Backup failed:', e.message); }
      }

      // Write the merged result
      try {
        fs.writeFileSync(fullPath, mergeResult.result, 'utf-8');
        sendJSON(res, 200, {
          success: true,
          file: body.path,
          strategy: mergeResult.strategy,
          diff: mergeResult.diff,
          hunks: mergeResult.hunks,
          applied: mergeResult.applied,
          failed: mergeResult.failed,
          details: mergeResult.details,
          backup: true
        });
      } catch (e) {
        sendJSON(res, 500, { error: 'Write failed: ' + e.message });
      }
    });
    return;
  }

  // POST /revert-file  { path } — restore a file from its backup
  if (pathname === '/revert-file' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.path) { sendJSON(res, 400, { error: 'Missing path' }); return; }
      console.log('[agent] ↩️ Revert file:', body.path);
      var result = patchUtils.restoreFromBackup(config.dir, body.path);
      if (result.restored) {
        sendJSON(res, 200, { success: true, file: body.path, message: 'Restored from backup' });
      } else {
        sendJSON(res, 200, { success: false, error: result.error });
      }
    });
    return;
  }

  // GET /git/status
  if (pathname === '/git/status' && req.method === 'GET') {
    getGitStatus(function (err, result) {
      if (err) { sendJSON(res, 500, { error: err.message }); return; }
      sendJSON(res, 200, result);
    });
    return;
  }

  // GET /git/diff?files=path1,path2 — get diff, optionally filtered to specific files
  if (pathname === '/git/diff' && req.method === 'GET') {
    var diffQuery = url.parse(req.url, true).query || {};
    var diffFiles = diffQuery.files ? decodeURIComponent(diffQuery.files).split(',').filter(Boolean) : [];
    var fileSuffix = '';
    if (diffFiles.length > 0) {
      fileSuffix = ' -- ' + diffFiles.map(function (f) { return '"' + f + '"'; }).join(' ');
    }
    // Get diff of working tree changes (staged + unstaged), filtered to specific files if provided
    execGit('diff HEAD' + fileSuffix, function (err, stdout) {
      if (err) {
        // If HEAD doesn't exist (no commits yet), diff against empty tree
        execGit('diff --cached' + fileSuffix, function (err2, stdout2) {
          if (err2) { sendJSON(res, 500, { error: err2.message }); return; }
          sendJSON(res, 200, { diff: stdout2 || '' });
        });
        return;
      }
      sendJSON(res, 200, { diff: stdout || '' });
    });
    return;
  }

  // POST /git/commit
  if (pathname === '/git/commit' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      gitCommit(body.message, body.files, function (err, result) {
        if (err) { sendJSON(res, 500, { error: err.message }); return; }
        sendJSON(res, 200, result);
      });
    });
    return;
  }

  // POST /playwright/generate  { bugId, bugTitle, bugDescription, devServerUrl }
  if (pathname === '/playwright/generate' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.bugId) { sendJSON(res, 400, { error: 'Missing bugId' }); return; }
      console.log('[agent] 🎭 Playwright generate for bug:', body.bugId);
      if (body.targetRoute) console.log('[agent]   Target route:', body.targetRoute);
      if (body.interactionSteps && body.interactionSteps.length) console.log('[agent]   Interaction steps:', body.interactionSteps.length);
      var result = generateReproScript(body.bugId, body.bugTitle || '', body.bugDescription || '', body.devServerUrl || '', body.testUsername || '', body.testPassword || '', body.targetRoute || '', body.interactionSteps || []);
      if (result.error) { console.log('[agent]   \u274c', result.error); sendJSON(res, 500, result); return; }
      console.log('[agent]   \u2705 Script generated:', result.testFile);
      sendJSON(res, 200, result);
    });
    return;
  }

  // POST /playwright/run  { testFile }
  if (pathname === '/playwright/run' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.testFile) { sendJSON(res, 400, { error: 'Missing testFile' }); return; }
      console.log('[agent] 🏃 Playwright run:', body.testFile);
      runReproScript(body.testFile, function (err, result) {
        if (err) { console.log('[agent]   ❌', err.message); sendJSON(res, 500, { error: err.message }); return; }
        console.log('[agent]   → Passed:', result.passed, '| Duration:', result.duration + 'ms');
        sendJSON(res, 200, result);
      });
    });
    return;
  }

  // POST /playwright/verify  { bugId }
  if (pathname === '/playwright/verify' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.bugId) { sendJSON(res, 400, { error: 'Missing bugId' }); return; }
      var testFile = 'bug_' + body.bugId + '_repro.js';
      var logData = loadPromptLog(body.bugId);
      runReproScript(testFile, function (err, result) {
        if (err) { sendJSON(res, 500, { error: err.message }); return; }
        result.promptLog = logData.found ? logData : null;
        sendJSON(res, 200, result);
      });
    });
    return;
  }

  // POST /prompts/save  { bugId, ... }
  if (pathname === '/prompts/save' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.bugId) { sendJSON(res, 400, { error: 'Missing bugId' }); return; }
      var result = savePromptLog(body.bugId, body);
      if (result.error) { sendJSON(res, 500, result); return; }
      sendJSON(res, 200, result);
    });
    return;
  }

  // GET /prompts/:bugId
  if (pathname.match(/^\/prompts\/([a-zA-Z0-9_]+)$/) && req.method === 'GET') {
    var promptBugId = pathname.match(/^\/prompts\/([a-zA-Z0-9_]+)$/)[1];
    var logResult = loadPromptLog(promptBugId);
    sendJSON(res, 200, logResult);
    return;
  }

  // GET /settings — load persisted settings from agent
  if (pathname === '/settings' && req.method === 'GET') {
    var settingsData = null;
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        settingsData = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      }
    } catch (e) {
      console.log('[agent] Settings read error:', e.message);
    }
    sendJSON(res, 200, { ok: true, settings: settingsData });
    return;
  }

  // POST /settings — persist settings locally on agent
  if (pathname === '/settings' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      try {
        // Merge with existing settings (don't overwrite fields not sent)
        var existing = {};
        if (fs.existsSync(SETTINGS_FILE)) {
          try { existing = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch (e2) { /* ignore */ }
        }
        var merged = existing;
        Object.keys(body).forEach(function (k) {
          merged[k] = body[k];
        });
        merged.updatedAt = new Date().toISOString();
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf-8');
        console.log('[agent] ✅ Settings saved (' + Object.keys(body).length + ' fields)');
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        console.log('[agent] Settings write error:', e.message);
        sendJSON(res, 500, { error: 'Failed to save settings: ' + e.message });
      }
    });
    return;
  }

  sendJSON(res, 404, { error: 'Unknown endpoint: ' + pathname });
}

var server = http.createServer(handleRequest);

// Start logging session for agent
logger.startSession({ component: 'agent', name: config.name, dir: config.dir, port: config.port });

// Graceful shutdown
process.on('SIGINT', function () {
  logger.info('SYSTEM', 'Agent shutting down (SIGINT)');
  logger.endSession();
  process.exit(0);
});
process.on('SIGTERM', function () {
  logger.info('SYSTEM', 'Agent shutting down (SIGTERM)');
  logger.endSession();
  process.exit(0);
});

server.listen(config.port, '0.0.0.0', function () {
  // Get local IP addresses
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
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          Zoho Bug Tracker — Local Code Agent             ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log('║  Agent:  ' + pad(config.name, 48) + '║');
  console.log('║  Dir:    ' + pad(config.dir, 48) + '║');
  console.log('║  Port:   ' + pad(String(config.port), 48) + '║');
  console.log('║                                                           ║');
  console.log('║  Accessible at:                                           ║');
  console.log('║    http://localhost:' + pad(String(config.port), 38) + '║');
  addresses.forEach(function (addr) {
    console.log('║    http://' + pad(addr + ':' + config.port, 48) + '║');
  });
  console.log('║                                                           ║');
  console.log('║  Set this URL in the web UI → Settings → Agent URL        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');
  logger.info('SYSTEM', 'Agent started successfully', { port: config.port, dir: config.dir, name: config.name });
});

function pad(str, len) {
  while (str.length < len) str += ' ';
  return str;
}
