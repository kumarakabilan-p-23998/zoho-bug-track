'use strict';
/**
 * code-analyzer.js — Analyze code in a user's configured project directory.
 * Provides: recursive file search, grep, read-file, and keyword-based analysis.
 * Runs ONLY within the user's configured projectDir — never outside.
 * Node 8 compatible. Zero dependencies.
 */
var fs = require('fs');
var path = require('path');

// ── safety: ensure all paths stay within the project root ──

function isInsideRoot(root, target) {
  var resolved = path.resolve(target);
  var resolvedRoot = path.resolve(root);
  return resolved.indexOf(resolvedRoot) === 0;
}

// ── recursive file walker ────────────────────────────────

/**
 * Walk directory recursively, returning file paths matching extensions.
 * @param {string} dir       - root to walk
 * @param {string[]} exts    - e.g. ['.js', '.hbs']
 * @param {string[]} exclude - dir names to skip
 * @param {number} maxFiles  - safety limit
 */
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

      // Skip excluded dirs
      if (exclude.indexOf(name) !== -1) continue;
      // Skip hidden dirs/files
      if (name.charAt(0) === '.') continue;

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

// ── search files by filename pattern ─────────────────────

/**
 * Search for files whose name contains the query string.
 * Returns up to maxResults paths (relative to projectDir).
 */
function searchFiles(projectDir, query, options) {
  options = options || {};
  var exts = options.extensions || ['.js', '.hbs', '.css', '.java', '.json'];
  var exclude = options.excludeDirs || ['node_modules', '.git', 'bower_components', 'dist', 'tmp', 'vendor'];
  var maxResults = options.maxResults || 50;

  var allFiles = walkDir(projectDir, exts, exclude);
  var queryLower = query.toLowerCase();

  var matches = [];
  for (var i = 0; i < allFiles.length; i++) {
    var rel = path.relative(projectDir, allFiles[i]).replace(/\\/g, '/');
    if (rel.toLowerCase().indexOf(queryLower) !== -1) {
      matches.push(rel);
      if (matches.length >= maxResults) break;
    }
  }
  return matches;
}

// ── grep: search file contents ───────────────────────────

/**
 * Search for a text pattern in files within projectDir.
 * Returns array of { file, line, text } matches.
 */
function grepFiles(projectDir, pattern, options) {
  options = options || {};
  var exts = options.extensions || ['.js', '.hbs', '.css', '.java'];
  var exclude = options.excludeDirs || ['node_modules', '.git', 'bower_components', 'dist', 'tmp', 'vendor'];
  var maxResults = options.maxResults || 100;
  var maxFileSize = options.maxFileSize || 500 * 1024; // 500 KB

  var allFiles = walkDir(projectDir, exts, exclude);
  var patternLower = pattern.toLowerCase();
  var isRegex = options.isRegex || false;
  var regex = null;
  if (isRegex) {
    try { regex = new RegExp(pattern, 'gi'); } catch (e) { /* fall back to string search */ }
  }

  var results = [];
  for (var i = 0; i < allFiles.length; i++) {
    if (results.length >= maxResults) break;

    var filePath = allFiles[i];
    var stat;
    try { stat = fs.statSync(filePath); } catch (e) { continue; }
    if (stat.size > maxFileSize) continue;

    var content;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch (e) { continue; }

    var lines = content.split('\n');
    for (var j = 0; j < lines.length; j++) {
      if (results.length >= maxResults) break;

      var matches = false;
      if (regex) {
        regex.lastIndex = 0;
        matches = regex.test(lines[j]);
      } else {
        matches = lines[j].toLowerCase().indexOf(patternLower) !== -1;
      }

      if (matches) {
        results.push({
          file: path.relative(projectDir, filePath).replace(/\\/g, '/'),
          line: j + 1,
          text: lines[j].trim().substring(0, 200)
        });
      }
    }
  }

  return results;
}

// ── read a specific file ─────────────────────────────────

/**
 * Read a file within projectDir. Returns null if outside boundary.
 * @param {string} projectDir
 * @param {string} relativePath
 * @param {number} [startLine] - 1-based
 * @param {number} [endLine]   - 1-based inclusive
 */
function readFile(projectDir, relativePath, startLine, endLine) {
  var fullPath = path.resolve(projectDir, relativePath);
  if (!isInsideRoot(projectDir, fullPath)) {
    return { error: 'Path is outside project directory' };
  }
  if (!fs.existsSync(fullPath)) {
    return { error: 'File not found: ' + relativePath };
  }

  var content;
  try { content = fs.readFileSync(fullPath, 'utf-8'); } catch (e) {
    return { error: 'Cannot read file: ' + e.message };
  }

  var lines = content.split('\n');
  var totalLines = lines.length;

  if (startLine || endLine) {
    var s = Math.max(1, startLine || 1) - 1;
    var e = Math.min(totalLines, endLine || totalLines);
    lines = lines.slice(s, e);
    return {
      file: relativePath,
      totalLines: totalLines,
      startLine: s + 1,
      endLine: e,
      content: lines.join('\n')
    };
  }

  // Full file but cap at 500 lines
  if (totalLines > 500) {
    return {
      file: relativePath,
      totalLines: totalLines,
      startLine: 1,
      endLine: 500,
      content: lines.slice(0, 500).join('\n'),
      truncated: true
    };
  }

  return {
    file: relativePath,
    totalLines: totalLines,
    content: content
  };
}

// ── analyze: keyword-based analysis for a bug ────────────

/**
 * Given bug keywords, search the project for relevant files and return
 * a structured analysis context.
 *
 * @param {string} projectDir
 * @param {string[]} keywords - extracted from bug title/description
 * @param {object} options
 * @returns {object} { relevantFiles, codeMatches, fileContents }
 */
function analyzeForBug(projectDir, keywords, options) {
  options = options || {};
  var exts = options.extensions || ['.js', '.hbs', '.css', '.java'];
  var exclude = options.excludeDirs || ['node_modules', '.git', 'bower_components', 'dist', 'tmp', 'vendor'];

  var allCodeMatches = [];
  var fileScores = {};   // file → { keyword: true }
  var fileNameHit = {};  // file → true if filename matched

  // Search each keyword
  keywords.forEach(function (kw) {
    if (!kw || kw.length < 2) return;

    // Filename matches
    var fileHits = searchFiles(projectDir, kw, { extensions: exts, excludeDirs: exclude, maxResults: 10 });
    fileHits.forEach(function (f) {
      if (!fileScores[f]) fileScores[f] = {};
      fileScores[f][kw] = true;
      fileNameHit[f] = true;
    });

    // Content matches
    var grepHits = grepFiles(projectDir, kw, { extensions: exts, excludeDirs: exclude, maxResults: 20 });
    grepHits.forEach(function (hit) {
      allCodeMatches.push(hit);
      if (!fileScores[hit.file]) fileScores[hit.file] = {};
      fileScores[hit.file][kw] = true;
    });
  });

  // Score each file: code-identifier keyword matches are worth 2 points, plain word matches 0.5
  var codeKwSet = keywords._codeKeywords || {};
  var scored = Object.keys(fileScores).map(function (f) {
    var matchedKws = Object.keys(fileScores[f]);
    var kwCount = matchedKws.length;
    var codeKwCount = 0;
    var score = 0;
    matchedKws.forEach(function (kw) {
      if (codeKwSet[kw.toLowerCase()]) {
        score += 2; // code identifier match is high value
        codeKwCount++;
      } else {
        score += 0.5; // plain word match is low value
      }
    });
    if (fileNameHit[f]) score += 1;
    return { file: f, score: score, kwCount: kwCount, codeKwCount: codeKwCount };
  });

  // Sort by score descending
  scored.sort(function (a, b) { return b.score - a.score; });

  // Relevance filter: prefer files matching code-identifier keywords.
  // Files matching only plain-word keywords are low quality.
  var hasCodeKws = Object.keys(codeKwSet).length > 0;
  var relevant;
  if (hasCodeKws) {
    // Must match at least 1 code-identifier keyword
    relevant = scored.filter(function (s) { return s.codeKwCount >= 1; });
    if (relevant.length === 0) {
      // Fallback: require at least 2 keyword matches of any type
      relevant = scored.filter(function (s) { return s.kwCount >= 2; });
    }
  } else {
    // No code identifiers extracted — use plain word threshold
    var minKw = keywords.length >= 3 ? 2 : 1;
    relevant = scored.filter(function (s) { return s.kwCount >= minKw; });
  }
  if (relevant.length === 0) relevant = scored; // ultimate fallback
  relevant = relevant.slice(0, 15);

  var relevantSet = {};
  var relevantFiles = relevant.map(function (s) { relevantSet[s.file] = true; return s.file; });

  // Filter codeMatches to only relevant files
  var codeMatches = allCodeMatches.filter(function (m) { return relevantSet[m.file]; });

  // Read the first N relevant files (up to 10)
  var fileContents = [];
  relevantFiles.slice(0, 10).forEach(function (f) {
    var result = readFile(projectDir, f);
    if (!result.error) {
      fileContents.push(result);
    }
  });

  return {
    keywords: keywords,
    relevantFiles: relevantFiles,
    codeMatches: codeMatches.slice(0, 50),
    fileContents: fileContents,
    fileScores: relevant.map(function (s) { return { file: s.file, score: s.score, keywords: Object.keys(fileScores[s.file]) }; })
  };
}

/**
 * Decode HTML entities.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/&#([0-9]+);/g, function (_, dec) {
      return String.fromCharCode(parseInt(dec, 10));
    });
}

/**
 * Extract code-like identifiers from text:
 * - camelCase / PascalCase (e.g., "myComponent" → keep as-is + split parts)
 * - file paths (e.g., "app/components/my-widget.js")
 * - dotted names (e.g., "com.example.MyClass")
 * - kebab-case identifiers (e.g., "alert-list-item")
 * - snake_case identifiers (e.g., "alert_list_item")
 */
function extractCodeIdentifiers(text) {
  var identifiers = [];

  // Match file paths (e.g. app/components/my-widget.js or ../foo/bar.hbs)
  var pathRegex = /(?:[a-zA-Z0-9_.\-]+\/)+[a-zA-Z0-9_.\-]+/g;
  var m;
  while ((m = pathRegex.exec(text)) !== null) {
    identifiers.push(m[0]);
    // Also extract the filename without extension
    var parts = m[0].split('/');
    var fileName = parts[parts.length - 1];
    var nameNoExt = fileName.replace(/\.[a-z]+$/i, '');
    if (nameNoExt.length > 4) identifiers.push(nameNoExt);
  }

  // Match dotted identifiers (e.g., Ember.Component, this.get, alertListController.filterAlerts)
  var dottedRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)+/g;
  while ((m = dottedRegex.exec(text)) !== null) {
    identifiers.push(m[0]);
    // Also add individual parts that are meaningful (longer than 4 chars)
    m[0].split('.').forEach(function (part) {
      if (part.length > 4) identifiers.push(part);
    });
  }

  // Match PascalCase identifiers (e.g. AlertListItemComponent, MyService)
  var pascalRegex = /[A-Z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+ /g;
  while ((m = pascalRegex.exec(text)) !== null) {
    var trimmed = m[0].trim();
    if (trimmed.length > 4) identifiers.push(trimmed);
  }
  // Try again without trailing space requirement
  var pascalRegex2 = /[A-Z][a-z]+(?:[A-Z][a-zA-Z0-9]*)+/g;
  while ((m = pascalRegex2.exec(text)) !== null) {
    if (m[0].length > 4) identifiers.push(m[0]);
  }

  // Match camelCase identifiers (e.g. alertListController, filterAlerts)
  var camelRegex = /[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*/g;
  while ((m = camelRegex.exec(text)) !== null) {
    if (m[0].length > 4) identifiers.push(m[0]);
  }

  // Match kebab-case identifiers with 2+ segments (e.g., alert-list-item, alert-list-view)
  var kebabRegex = /[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+/g;
  while ((m = kebabRegex.exec(text)) !== null) {
    if (m[0].length > 5) identifiers.push(m[0]);
  }

  // Match snake_case identifiers with 2+ segments
  var snakeRegex = /[a-zA-Z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+/g;
  while ((m = snakeRegex.exec(text)) !== null) {
    if (m[0].length > 5) identifiers.push(m[0]);
  }

  return identifiers;
}

/**
 * Extract meaningful keywords from bug title, description, and comments.
 * Uses full bug text including comments for richer keyword extraction.
 *
 * @param {string} title - bug title
 * @param {string} description - bug description (may contain HTML)
 * @param {string} [fullText] - full bug text including comments (optional)
 */
function extractKeywords(title, description, fullText) {
  var rawText = (title || '') + ' ' + (description || '');
  if (fullText) rawText += ' ' + fullText;

  // Strip HTML tags, decode entities
  var text = decodeHtmlEntities(rawText.replace(/<[^>]+>/g, ' '));

  // ── Pre-processing: strip attachment metadata before keyword extraction ──
  // Remove attachment lines like "- Screenshot_1770806732984.png (228640 bytes, image/png)"
  text = text.replace(/-\s*\S+\.\w{2,5}\s*\(\s*\d+\s*bytes?,?\s*[a-zA-Z]+\/[a-zA-Z0-9.+-]+\s*\)/g, '');
  // Remove standalone MIME types (image/png, application/json, text/html, etc.)
  text = text.replace(/\b(?:image|text|application|audio|video|font|multipart|model|message)\/[a-zA-Z0-9.+-]+\b/g, '');
  // Remove screenshot-like filenames (Screenshot_12345.png, IMG_1234.jpg, etc.)
  text = text.replace(/\b(?:Screenshot|IMG|screenshot|img)[_\s]?\d+[._]\w{2,5}\b/gi, '');
  // Remove raw byte-size references (228640 bytes)
  text = text.replace(/\b\d{3,}\s*bytes?\b/gi, '');

  // ── Phase 1: Extract code identifiers (high priority) ──
  var codeIds = extractCodeIdentifiers(text);

  // Filter out bare file extensions, very short identifiers, MIME types, and attachment artifacts
  codeIds = codeIds.filter(function (id) {
    // Skip things that are just "name.ext" with short name (e.g., "view.js", "list.hbs", "widget.hbs")
    if (/^[a-zA-Z0-9_-]{1,8}\.[a-z]{1,4}$/.test(id)) return false;
    // Skip MIME-type patterns (image/png, text/html, application/json)
    if (/^(?:image|text|application|audio|video|font|multipart|model|message)\//.test(id)) return false;
    // Skip screenshot/image capture filenames
    if (/^(?:Screenshot|IMG|screenshot|img)[_\s]?\d+/i.test(id)) return false;
    return id.length > 4;
  });

  // ── Phase 2: Extract plain words ──
  // Only filter truly generic English words, NOT code-related terms
  var stopWords = [
    // Articles, prepositions, conjunctions
    'the', 'is', 'at', 'in', 'of', 'and', 'or', 'to', 'a', 'an',
    'for', 'on', 'with', 'as', 'by', 'from', 'it', 'this', 'that', 'be',
    'are', 'was', 'were', 'been', 'has', 'have', 'had', 'not', 'but', 'if',
    'when', 'should', 'would', 'could', 'can', 'will', 'do', 'does', 'did',
    'its', 'all', 'any', 'each', 'some', 'please', 'also', 'just',
    'like', 'only', 'very', 'more', 'most', 'much', 'many', 'such',
    'than', 'then', 'them', 'they', 'their', 'there', 'these', 'those',
    'what', 'which', 'who', 'whom', 'whose', 'where', 'here',
    'how', 'why', 'because', 'about', 'above', 'below',
    'same', 'different', 'other', 'another', 'every',
    'getting', 'without', 'while', 'into', 'between', 'through',
    'still', 'already', 'being', 'able', 'unable', 'properly',
    'sometimes', 'always', 'never', 'once', 'again',
    'after', 'before', 'during', 'until', 'since',
    'will', 'shall', 'must', 'may', 'might',
    // Bug tracker / QA jargon (not useful for code search)
    'need', 'needs', 'bug', 'issue', 'minor', 'major', 'critical', 'blocker',
    'confirmed', 'expected', 'actual', 'behavior', 'behaviour',
    'steps', 'reproduce', 'screenshot', 'attached', 'attachment', 'attachments',
    'note', 'notes', 'comment', 'comments', 'description', 'title',
    'priority', 'severity', 'status', 'resolution', 'assignee',
    'reporter', 'milestone', 'shall', 'feature',
    // Generic nouns/adjectives that match everywhere in code
    'configuration', 'configure', 'configured', 'config',
    'provided', 'provider', 'providing', 'provide',
    'handling', 'handle', 'handled', 'handler',
    'implement', 'implementation', 'implemented', 'implementing',
    'required', 'require', 'requirement', 'requirements',
    'specific', 'specified', 'specify',
    'possible', 'possibly', 'particular', 'particularly',
    'following', 'currently', 'available', 'details',
    'contains', 'contain', 'existing', 'exists',
    'certain', 'related', 'correct', 'correctly',
    'process', 'processing', 'processed',
    'appears', 'appear', 'appropriate',
    'support', 'supports', 'supported', 'supporting',
    'created', 'creating', 'creation',
    'based', 'basic', 'bytes',
    'soar', 'info', 'task', 'case', 'used', 'uses', 'using',
    'time', 'date', 'number', 'string', 'object', 'array',
    // Generic actions/verbs that match everywhere in code
    'click', 'open', 'close', 'closed', 'check', 'display', 'show',
    'showing', 'shown', 'work', 'working', 'works', 'broken',
    'data', 'file', 'files', 'page', 'pages', 'source',
    'new', 'old', 'get', 'set', 'add', 'remove', 'update', 'delete',
    'list', 'item', 'items', 'value', 'values', 'name', 'type', 'text',
    'user', 'users', 'button', 'form', 'input', 'output', 'result',
    'select', 'selected', 'change', 'changed', 'changes',
    'load', 'loading', 'loaded', 'save', 'saved', 'saving',
    'enable', 'enabled', 'disable', 'disabled', 'visible', 'hidden',
    'start', 'stop', 'run', 'running', 'reset', 'clear',
    'true', 'false', 'null', 'undefined',
    'default', 'custom', 'first', 'last', 'next', 'prev', 'previous',
    'index', 'count', 'total', 'size', 'length',
    'error', 'errors', 'warning', 'success', 'failed', 'failure',
    'analysis', 'analyze', 'analysed', 'analysing',
    'test', 'tests', 'spec', 'specs',
    'view', 'views', 'copy', 'copied', 'paste',
    'section', 'panel', 'modal', 'dialog', 'popup',
    'header', 'footer', 'body', 'content', 'wrapper',
    'message', 'notification', 'alert', 'confirm',
    'callback', 'response', 'request', 'fetch',
    'render', 'rendering', 'rendered'
  ];

  var plainWords = text.toLowerCase()
    .replace(/[^a-zA-Z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter(function (w) {
      return w.length > 3 && stopWords.indexOf(w) === -1;
    });

  // ── Phase 3: Merge and prioritize ──
  // Code identifiers get higher priority (added first)
  var seen = {};
  var prioritized = [];
  var normal = [];

  // Add code identifiers first (they're the most specific)
  // Sort by length descending so longer identifiers go first
  codeIds.sort(function (a, b) { return b.length - a.length; });

  codeIds.forEach(function (id) {
    var key = id.toLowerCase();
    if (seen[key]) return;
    // Skip if this is a substring of an already-added identifier
    var isSubstring = false;
    for (var i = 0; i < prioritized.length; i++) {
      if (prioritized[i].toLowerCase().indexOf(key) !== -1) {
        isSubstring = true;
        break;
      }
    }
    if (isSubstring) return;
    seen[key] = true;
    prioritized.push(id);
  });

  // Then add plain words (skip if substring of an existing code identifier)
  plainWords.forEach(function (w) {
    if (seen[w]) return;
    // Skip if this plain word is a substring of any prioritized code identifier
    var isSubPart = false;
    for (var i = 0; i < prioritized.length; i++) {
      if (prioritized[i].toLowerCase().indexOf(w) !== -1) {
        isSubPart = true;
        break;
      }
    }
    if (isSubPart) return;
    seen[w] = true;
    normal.push(w);
  });

  // Tag keywords so scoring can differentiate code identifiers vs plain words
  var codeKeywordSet = {};
  prioritized.forEach(function (id) { codeKeywordSet[id.toLowerCase()] = true; });

  // Code identifiers first (up to 8), then plain words (up to 4), max 12 total
  var result = prioritized.slice(0, 8).concat(normal.slice(0, 4));
  result = result.slice(0, 12);
  // Attach metadata for scoring
  result._codeKeywords = codeKeywordSet;
  return result;
}

/**
 * Get project directory stats.
 */
function getProjectStats(projectDir, options) {
  options = options || {};
  var exts = options.extensions || ['.js', '.hbs', '.css', '.java', '.json'];
  var exclude = options.excludeDirs || ['node_modules', '.git', 'bower_components', 'dist', 'tmp', 'vendor'];

  if (!projectDir || !fs.existsSync(projectDir)) {
    return { valid: false, error: 'Directory does not exist' };
  }

  var files = walkDir(projectDir, exts, exclude, 10000);
  var byExt = {};
  files.forEach(function (f) {
    var ext = path.extname(f).toLowerCase() || '(no ext)';
    byExt[ext] = (byExt[ext] || 0) + 1;
  });

  return {
    valid: true,
    totalFiles: files.length,
    byExtension: byExt,
    projectDir: projectDir
  };
}

module.exports = {
  searchFiles: searchFiles,
  grepFiles: grepFiles,
  readFile: readFile,
  analyzeForBug: analyzeForBug,
  extractKeywords: extractKeywords,
  getProjectStats: getProjectStats,
  walkDir: walkDir
};
