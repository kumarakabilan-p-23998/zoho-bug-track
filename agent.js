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

var PROMPTS_DIR = path.join(config.dir, '..', '.bug-tracker-data', 'prompts');
try {
  if (!fs.existsSync(path.join(config.dir, '..', '.bug-tracker-data'))) {
    fs.mkdirSync(path.join(config.dir, '..', '.bug-tracker-data'));
  }
  if (!fs.existsSync(PROMPTS_DIR)) {
    fs.mkdirSync(PROMPTS_DIR);
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
function ensurePuppeteer(callback) {
  try {
    require.resolve('puppeteer-core');
    return callback(null); // already installed
  } catch (e) { /* not found — install */ }

  console.log('[agent] Installing puppeteer-core@2.1.1 (one-time)...');
  var installDir = path.join(config.dir, '..');
  childProcess.exec('npm install puppeteer-core@2.1.1 --no-save --no-package-lock', {
    cwd: installDir,
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024
  }, function (err, stdout, stderr) {
    if (err) {
      console.log('[agent] puppeteer-core install failed:', (stderr || err.message));
      return callback(new Error('Failed to install puppeteer-core: ' + (stderr || err.message)));
    }
    console.log('[agent] puppeteer-core installed successfully');
    callback(null);
  });
}

/**
 * Generate a standalone Puppeteer reproduction script for a bug.
 * Uses puppeteer-core + locally installed Chrome/Edge.
 * Returns { testCode, testFile } or { error }.
 */
function generateReproScript(bugId, bugTitle, bugDescription, devServerUrl, testUsername, testPassword) {
  var testFile = path.join(PROMPTS_DIR, 'bug_' + bugId + '_repro.js');
  var baseUrl = devServerUrl || 'https://localhost:4200';
  var screenshotPath = path.join(PROMPTS_DIR, 'bug_' + bugId + '_screenshot.png').replace(/\\/g, '/');
  var browserPath = findBrowserPath();

  if (!browserPath) {
    return { error: 'No Chrome or Edge browser found. Set CHROME_PATH environment variable.' };
  }

  var L = [];  // lines
  L.push('// Auto-generated reproduction script for Bug: ' + (bugTitle || bugId));
  L.push('// Generated: ' + new Date().toISOString());
  L.push('// Uses puppeteer-core with local Chrome/Edge — Node 8+ compatible');
  L.push('var puppeteer = require("puppeteer-core");');
  L.push('');
  L.push('var BROWSER_PATH = ' + JSON.stringify(browserPath) + ';');
  L.push('var BASE_URL = ' + JSON.stringify(baseUrl) + ';');
  L.push('var SCREENSHOT = ' + JSON.stringify(screenshotPath) + ';');
  L.push('');
  L.push('function run() {');
  L.push('  var result = { passed: false, errors: [], title: "", pageUrl: "" };');
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
    L.push('    return page.goto(BASE_URL, { waitUntil: "networkidle0", timeout: 30000 })');
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
    L.push('      // Wait for ANY input field to appear on the page');
    L.push('      return page.waitForSelector("input", { visible: true, timeout: 20000 });');
    L.push('    })');
    L.push('    .then(function () {');
    L.push('      // Try selectors in priority order using waitForSelector');
    L.push('      var selectors = [');
    L.push('        "#login_id",');
    L.push('        "#userid",');
    L.push('        "input[name=LOGIN_ID]",');
    L.push('        "input[name=login_id]",');
    L.push('        "input[type=email]",');
    L.push('        "input[name*=user]",');
    L.push('        "input[name*=login]",');
    L.push('        "input[name*=email]",');
    L.push('        "input[id*=user]",');
    L.push('        "input[id*=login]",');
    L.push('        "input[id*=email]",');
    L.push('        "input[type=text]"');
    L.push('      ];');
    L.push('      // Try each selector — return the first match');
    L.push('      function tryNext(i) {');
    L.push('        if (i >= selectors.length) return Promise.resolve(null);');
    L.push('        return page.$(selectors[i]).then(function (el) {');
    L.push('          if (el) { console.log("Found username field: " + selectors[i]); return el; }');
    L.push('          return tryNext(i + 1);');
    L.push('        });');
    L.push('      }');
    L.push('      return tryNext(0);');
    L.push('    })');
    L.push('    .then(function (usernameEl) {');
    L.push('      if (!usernameEl) {');
    L.push('        // Last resort: dump all input elements for debugging');
    L.push('        return page.$$eval("input", function (inputs) {');
    L.push('          return inputs.map(function (i) { return { tag: i.tagName, type: i.type, id: i.id, name: i.name, class: i.className }; });');
    L.push('        }).then(function (info) {');
    L.push('          console.log("All inputs on page: " + JSON.stringify(info));');
    L.push('          throw new Error("Could not find username field. Inputs found: " + JSON.stringify(info));');
    L.push('        });');
    L.push('      }');
    L.push('      return usernameEl.click({ clickCount: 3 }).then(function () {');
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
    L.push('      return new Promise(function (r) { setTimeout(r, 3000); });');
    L.push('    })');
    L.push('    .then(function () {');
    L.push('      // Check if password field appeared (two-step login)');
    L.push('      return page.$("input[type=password]");');
    L.push('    })');
    L.push('    .then(function (pwEl) {');
    L.push('      if (!pwEl) {');
    L.push('        // Maybe password was already on the page or we are logged in');
    L.push('        console.log("No password field found — may already be logged in");');
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
    L.push('          return page.waitForNavigation({ waitUntil: "networkidle0", timeout: 30000 }).catch(function () {});');
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
    L.push('    return page.goto(BASE_URL, { waitUntil: "networkidle0", timeout: 30000 })');
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
  L.push('      return new Promise(function (r) { setTimeout(r, 2000); });');
  L.push('    })');
  L.push('    .then(function () {');
  L.push('      return page.screenshot({ path: SCREENSHOT }).catch(function () {});');
  L.push('    })');
  L.push('    .then(function () {');
  L.push('      result.passed = result.errors.length === 0;');
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
      cwd: path.join(config.dir, '..'),
      maxBuffer: 5 * 1024 * 1024,
      timeout: 90000
    }, function (err, stdout, stderr) {
      var duration = Date.now() - startTime;
      var fullOutput = (stdout || '') + '\n' + (stderr || '');
      var passed = !err;

      // Try to parse structured result from output
      var resultMatch = fullOutput.match(/__REPRO_RESULT__(\{.*\})/);
      if (resultMatch) {
        try {
          var parsed = JSON.parse(resultMatch[1]);
          passed = parsed.passed;
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

  // GET /search?q=...
  if (pathname === '/search') {
    var q = query.q || '';
    if (!q) { sendJSON(res, 400, { error: 'Missing ?q=' }); return; }
    sendJSON(res, 200, { files: searchFiles(q) });
    return;
  }

  // GET /grep?q=...
  if (pathname === '/grep') {
    var gq = query.q || '';
    if (!gq) { sendJSON(res, 400, { error: 'Missing ?q=' }); return; }
    sendJSON(res, 200, { matches: grepFiles(gq, { isRegex: query.regex === '1' }) });
    return;
  }

  // GET /read-file?path=...
  if (pathname === '/read-file') {
    var fp = query.path || '';
    if (!fp) { sendJSON(res, 400, { error: 'Missing ?path=' }); return; }
    var start = query.start ? parseInt(query.start, 10) : undefined;
    var end = query.end ? parseInt(query.end, 10) : undefined;
    var result = readFile(fp, start, end);
    if (result.error) { sendJSON(res, 400, result); return; }
    sendJSON(res, 200, result);
    return;
  }

  // GET /analyze?keywords=kw1,kw2,...&codeKeywords=ck1,ck2,...
  if (pathname === '/analyze') {
    var kwStr = query.keywords || '';
    if (!kwStr) { sendJSON(res, 400, { error: 'Missing ?keywords=' }); return; }
    var keywords = kwStr.split(',').map(function (k) { return k.trim(); }).filter(Boolean);
    // Receive code-identifier keyword metadata for weighted scoring
    var codeKwStr = query.codeKeywords || '';
    var codeKwSet = {};
    if (codeKwStr) {
      codeKwStr.split(',').map(function (k) { return k.trim().toLowerCase(); }).filter(Boolean)
        .forEach(function (k) { codeKwSet[k] = true; });
    }
    keywords._codeKeywords = codeKwSet;
    sendJSON(res, 200, analyzeForBug(keywords));
    return;
  }

  // POST /write-file  { path, content }
  if (pathname === '/write-file' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.path) { sendJSON(res, 400, { error: 'Missing path' }); return; }
      var fullPath = path.resolve(config.dir, body.path);
      if (!isInsideRoot(config.dir, fullPath)) {
        sendJSON(res, 403, { error: 'Path is outside project directory' }); return;
      }
      try {
        fs.writeFileSync(fullPath, body.content || '', 'utf-8');
        sendJSON(res, 200, { success: true, file: body.path });
      } catch (e) {
        sendJSON(res, 500, { error: 'Write failed: ' + e.message });
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
      var result = generateReproScript(body.bugId, body.bugTitle || '', body.bugDescription || '', body.devServerUrl || '', body.testUsername || '', body.testPassword || '');
      if (result.error) { sendJSON(res, 500, result); return; }
      sendJSON(res, 200, result);
    });
    return;
  }

  // POST /playwright/run  { testFile }
  if (pathname === '/playwright/run' && req.method === 'POST') {
    readAgentBody(req, function (bodyErr, body) {
      if (bodyErr) { sendJSON(res, 400, { error: bodyErr.message }); return; }
      if (!body.testFile) { sendJSON(res, 400, { error: 'Missing testFile' }); return; }
      runReproScript(body.testFile, function (err, result) {
        if (err) { sendJSON(res, 500, { error: err.message }); return; }
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

  sendJSON(res, 404, { error: 'Unknown endpoint: ' + pathname });
}

var server = http.createServer(handleRequest);

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
});

function pad(str, len) {
  while (str.length < len) str += ' ';
  return str;
}
