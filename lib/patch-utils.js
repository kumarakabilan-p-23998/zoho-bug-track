'use strict';
/**
 * patch-utils.js — Line-level diff, patch application, and backup utilities.
 *
 * Provides:
 *   - computeDiff(oldText, newText)    → unified diff string
 *   - applyPatch(original, patch)      → patched text (from unified diff)
 *   - applySmartMerge(original, aiCode, options) → { result, diff, hunks, strategy }
 *   - createBackup(filePath)           → backup file path
 *   - restoreBackup(filePath)          → restores from backup
 *
 * Handles two AI code formats:
 *   1. Unified diff (@@, +, - markers) → parsed and applied as patch
 *   2. Full/partial file content       → smart merge against original
 *
 * Node 8 compatible. Zero dependencies.
 */
var fs = require('fs');
var path = require('path');
var os = require('os');
var logger = require('./logger');

// ── LCS-based diff ──────────────────────────────────────

/**
 * Compute the Longest Common Subsequence table for two arrays of lines.
 * Returns a 2D array of LCS lengths.
 */
function lcsTable(a, b) {
  var m = a.length;
  var n = b.length;
  // Use flat array for memory efficiency
  var dp = [];
  for (var i = 0; i <= m; i++) {
    dp[i] = [];
    for (var j = 0; j <= n; j++) {
      dp[i][j] = 0;
    }
  }
  for (var i2 = 1; i2 <= m; i2++) {
    for (var j2 = 1; j2 <= n; j2++) {
      if (a[i2 - 1] === b[j2 - 1]) {
        dp[i2][j2] = dp[i2 - 1][j2 - 1] + 1;
      } else {
        dp[i2][j2] = Math.max(dp[i2 - 1][j2], dp[i2][j2 - 1]);
      }
    }
  }
  return dp;
}

/**
 * Backtrack through the LCS table to produce a list of edit operations.
 * Each op is { type: 'equal'|'add'|'remove', line: string }
 */
function diffOps(a, b, dp) {
  var ops = [];
  var i = a.length;
  var j = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: 'equal', line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', line: b[j - 1] });
      j--;
    } else {
      ops.push({ type: 'remove', line: a[i - 1] });
      i--;
    }
  }

  return ops.reverse();
}

/**
 * Group edit operations into hunks with context lines.
 * Each hunk: { oldStart, oldCount, newStart, newCount, lines: [string] }
 */
function buildHunks(ops, contextLines) {
  contextLines = contextLines || 3;
  var hunks = [];
  var oldLine = 0;
  var newLine = 0;

  // Find ranges where changes occur
  var changeRanges = [];
  var idx = 0;
  for (var k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'equal') {
      var start = k;
      while (k < ops.length && ops[k].type !== 'equal') k++;
      changeRanges.push({ start: start, end: k });
    }
  }

  if (changeRanges.length === 0) return [];

  // Merge nearby ranges and build hunks with context
  var merged = [changeRanges[0]];
  for (var r = 1; r < changeRanges.length; r++) {
    var prev = merged[merged.length - 1];
    // If the gap between two change ranges is small, merge them
    if (changeRanges[r].start - prev.end <= contextLines * 2) {
      prev.end = changeRanges[r].end;
    } else {
      merged.push(changeRanges[r]);
    }
  }

  // Build each hunk
  for (var h = 0; h < merged.length; h++) {
    var range = merged[h];
    var ctxStart = Math.max(0, range.start - contextLines);
    var ctxEnd = Math.min(ops.length, range.end + contextLines);

    var hunkOldStart = 0;
    var hunkNewStart = 0;
    var hunkOldCount = 0;
    var hunkNewCount = 0;
    var hunkLines = [];

    // Count lines up to ctxStart
    var oLine = 0;
    var nLine = 0;
    for (var c = 0; c < ctxStart; c++) {
      if (ops[c].type === 'equal') { oLine++; nLine++; }
      else if (ops[c].type === 'remove') { oLine++; }
      else if (ops[c].type === 'add') { nLine++; }
    }
    hunkOldStart = oLine + 1;
    hunkNewStart = nLine + 1;

    for (var c2 = ctxStart; c2 < ctxEnd; c2++) {
      var op = ops[c2];
      if (op.type === 'equal') {
        hunkLines.push(' ' + op.line);
        hunkOldCount++;
        hunkNewCount++;
      } else if (op.type === 'remove') {
        hunkLines.push('-' + op.line);
        hunkOldCount++;
      } else if (op.type === 'add') {
        hunkLines.push('+' + op.line);
        hunkNewCount++;
      }
    }

    hunks.push({
      oldStart: hunkOldStart,
      oldCount: hunkOldCount,
      newStart: hunkNewStart,
      newCount: hunkNewCount,
      lines: hunkLines
    });
  }

  return hunks;
}

/**
 * Compute a unified diff between two text strings.
 * Returns the diff as a string (without file headers).
 */
function computeDiff(oldText, newText, fileName) {
  var oldLines = (oldText || '').split('\n');
  var newLines = (newText || '').split('\n');

  var dp = lcsTable(oldLines, newLines);
  var ops = diffOps(oldLines, newLines, dp);
  var hunks = buildHunks(ops, 3);

  if (hunks.length === 0) return '';

  var result = '';
  if (fileName) {
    result += '--- a/' + fileName + '\n';
    result += '+++ b/' + fileName + '\n';
  }

  for (var i = 0; i < hunks.length; i++) {
    var h = hunks[i];
    result += '@@ -' + h.oldStart + ',' + h.oldCount + ' +' + h.newStart + ',' + h.newCount + ' @@\n';
    result += h.lines.join('\n') + '\n';
  }

  return result;
}

// ── Unified diff parser ─────────────────────────────────

/**
 * Parse a unified diff string into hunks.
 * Returns [{ oldStart, oldCount, newStart, newCount, changes: [{ type, line }] }]
 */
function parseUnifiedDiff(diffText) {
  var lines = diffText.split('\n');
  var hunks = [];
  var current = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    var hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      current = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] || '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] || '1', 10),
        changes: []
      };
      hunks.push(current);
      continue;
    }

    // Skip file headers
    if (line.indexOf('---') === 0 || line.indexOf('+++') === 0) continue;
    if (line.indexOf('diff ') === 0 || line.indexOf('index ') === 0) continue;

    if (!current) continue;

    if (line.charAt(0) === '+') {
      current.changes.push({ type: 'add', line: line.substring(1) });
    } else if (line.charAt(0) === '-') {
      current.changes.push({ type: 'remove', line: line.substring(1) });
    } else if (line.charAt(0) === ' ') {
      current.changes.push({ type: 'context', line: line.substring(1) });
    } else if (line === '' && i === lines.length - 1) {
      // Trailing newline, ignore
    } else {
      // Treat as context (some diffs omit the leading space)
      current.changes.push({ type: 'context', line: line });
    }
  }

  return hunks;
}

// ── Patch application ───────────────────────────────────

/**
 * Apply parsed hunks to original text.
 * Uses fuzzy context matching — tries exact line offset first,
 * then searches ±50 lines around for matching context.
 * Returns { success, result, applied, failed, details }
 */
function applyHunks(originalText, hunks) {
  var original = originalText.split('\n');
  var result = original.slice(); // working copy
  var offset = 0; // cumulative line offset from applied hunks
  var applied = 0;
  var failed = 0;
  var details = [];

  for (var h = 0; h < hunks.length; h++) {
    var hunk = hunks[h];
    // Expected position (0-based)
    var expectedLine = hunk.oldStart - 1 + offset;

    // Gather context lines from the hunk for matching
    var contextLines = [];
    var removeLines = [];
    var addLines = [];
    for (var c = 0; c < hunk.changes.length; c++) {
      var ch = hunk.changes[c];
      if (ch.type === 'context') contextLines.push(ch.line);
      else if (ch.type === 'remove') removeLines.push(ch.line);
      else if (ch.type === 'add') addLines.push(ch.line);
    }

    // Build the lines we expect to find in the original (context + remove lines, in order)
    var expectedOld = [];
    for (var c2 = 0; c2 < hunk.changes.length; c2++) {
      if (hunk.changes[c2].type === 'context' || hunk.changes[c2].type === 'remove') {
        expectedOld.push(hunk.changes[c2].line);
      }
    }

    // Try to find the best match position
    var matchPos = findBestMatch(result, expectedOld, expectedLine);

    if (matchPos === -1) {
      failed++;
      details.push({
        hunk: h + 1,
        status: 'failed',
        reason: 'Could not find matching context at or near line ' + (hunk.oldStart + offset)
      });
      continue;
    }

    // Apply the hunk: remove old lines, insert new lines
    var newLines = [];
    for (var c3 = 0; c3 < hunk.changes.length; c3++) {
      if (hunk.changes[c3].type === 'context' || hunk.changes[c3].type === 'add') {
        newLines.push(hunk.changes[c3].line);
      }
    }

    var removeCount = expectedOld.length;
    result.splice(matchPos, removeCount);
    for (var ins = 0; ins < newLines.length; ins++) {
      result.splice(matchPos + ins, 0, newLines[ins]);
    }

    // Update offset for next hunk
    offset += (newLines.length - removeCount);
    applied++;
    details.push({
      hunk: h + 1,
      status: 'applied',
      at: matchPos + 1,
      linesRemoved: removeCount,
      linesAdded: newLines.length
    });
  }

  return {
    success: failed === 0,
    result: result.join('\n'),
    applied: applied,
    failed: failed,
    details: details
  };
}

/**
 * Find the best position in `lines` array where `expectedLines` match.
 * Tries exact position first, then searches ±50 lines with fuzzy matching.
 * Returns the 0-based index, or -1 if no match found.
 */
function findBestMatch(lines, expectedLines, startPos) {
  if (expectedLines.length === 0) return Math.max(0, Math.min(startPos, lines.length));

  // Try exact position first
  if (matchesAt(lines, expectedLines, startPos)) return startPos;

  // Fuzzy search ± 50 lines
  var searchRadius = 50;
  for (var delta = 1; delta <= searchRadius; delta++) {
    if (startPos - delta >= 0 && matchesAt(lines, expectedLines, startPos - delta)) {
      return startPos - delta;
    }
    if (startPos + delta < lines.length && matchesAt(lines, expectedLines, startPos + delta)) {
      return startPos + delta;
    }
  }

  // Last resort: try trimmed matching (ignore leading/trailing whitespace)
  for (var delta2 = 0; delta2 <= searchRadius; delta2++) {
    var positions = [startPos + delta2, startPos - delta2];
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      if (pos >= 0 && pos < lines.length && matchesAtTrimmed(lines, expectedLines, pos)) {
        return pos;
      }
    }
  }

  return -1;
}

/**
 * Check if expectedLines match exactly at position pos in the lines array.
 */
function matchesAt(lines, expectedLines, pos) {
  if (pos < 0 || pos + expectedLines.length > lines.length) return false;
  for (var i = 0; i < expectedLines.length; i++) {
    if (lines[pos + i] !== expectedLines[i]) return false;
  }
  return true;
}

/**
 * Like matchesAt but compares trimmed lines (whitespace-insensitive).
 */
function matchesAtTrimmed(lines, expectedLines, pos) {
  if (pos < 0 || pos + expectedLines.length > lines.length) return false;
  for (var i = 0; i < expectedLines.length; i++) {
    if (lines[pos + i].trim() !== expectedLines[i].trim()) return false;
  }
  return true;
}

// ── Smart merge (for full/partial file content from AI) ─

/**
 * Detect whether AI code looks like a unified diff.
 */
function isUnifiedDiff(code) {
  return /^@@\s+-\d+/m.test(code) && /^[+-]/m.test(code);
}

/**
 * Detect whether AI code is likely a complete file or a partial snippet.
 * Heuristic: if it has common file-start patterns or is >80% of original size.
 */
function isLikelyFullFile(originalText, aiCode) {
  var origLen = originalText.split('\n').length;
  var aiLen = aiCode.split('\n').length;

  // If AI output is >= 60% of original line count, likely full file
  if (origLen > 0 && aiLen / origLen >= 0.6) return true;

  // If AI output is less than 40% of original, it's almost certainly a snippet,
  // regardless of first-line patterns (avoids misclassifying small code blocks
  // that happen to start with 'function', 'class', etc.)
  if (origLen > 5 && aiLen / origLen < 0.4) return false;

  // Check for common file-start patterns (only when AI code is 40-60% of original)
  var firstLine = aiCode.trim().split('\n')[0] || '';
  if (/^['"]use strict['"]/.test(firstLine)) return true;
  if (/^(import |export |const |var |let |function |class |module\.)/.test(firstLine)) return true;
  if (/^<(!DOCTYPE|html|template|script|style)/i.test(firstLine)) return true;
  if (/^(package |#!\/)/.test(firstLine)) return true;
  if (/^\{/.test(firstLine) && /\}$/.test(aiCode.trim())) return true; // JSON-like

  return false;
}

/**
 * Try to locate a code snippet within the original file by finding
 * matching structural anchor lines (first and last significant lines).
 *
 * Because the snippet contains MODIFIED code, middle lines may differ from
 * the original. We match using:
 *   1. First significant line of snippet → find start position in original
 *   2. Last significant line of snippet → verify end position near expected location
 *   3. If the snippet's line count is very different from the matched range,
 *      use the original's matching structural boundary (e.g., matching closing brace).
 *
 * Returns { startLine, endLine } (0-based, endLine is exclusive) or null if not found.
 */
function findSnippetLocation(originalLines, snippetLines) {
  // Get first significant line from snippet
  var firstAnchor = '';
  var firstAnchorOffset = 0;
  for (var i = 0; i < snippetLines.length; i++) {
    var trimmed = snippetLines[i].trim();
    if (trimmed && trimmed.length > 2) {
      firstAnchor = trimmed;
      firstAnchorOffset = i;
      break;
    }
  }

  // Get last significant line from snippet
  var lastAnchor = '';
  var lastAnchorOffset = 0;
  for (var j = snippetLines.length - 1; j >= 0; j--) {
    var trimmedJ = snippetLines[j].trim();
    if (trimmedJ && trimmedJ.length > 0) {
      lastAnchor = trimmedJ;
      lastAnchorOffset = j;
      break;
    }
  }

  if (!firstAnchor) return null;

  // Search for the first anchor in original
  for (var pos = 0; pos < originalLines.length; pos++) {
    if (originalLines[pos].trim() !== firstAnchor) continue;

    var startLine = pos - firstAnchorOffset; // adjust for any leading empty lines
    if (startLine < 0) startLine = 0;

    // Now find where the original section ends.
    // Look for the last anchor near the expected end position.
    var expectedEnd = startLine + snippetLines.length;

    if (lastAnchor) {
      // Search near expectedEnd for the last anchor
      var bestEnd = -1;
      var searchRadius = Math.max(snippetLines.length, 10);
      for (var k = Math.max(0, expectedEnd - searchRadius); k < Math.min(originalLines.length, expectedEnd + searchRadius); k++) {
        if (originalLines[k].trim() === lastAnchor) {
          // Prefer the match closest to expectedEnd
          if (bestEnd === -1 || Math.abs(k - expectedEnd + 1) < Math.abs(bestEnd - expectedEnd + 1)) {
            bestEnd = k + 1; // exclusive end
          }
        }
      }
      if (bestEnd > startLine) {
        return { startLine: startLine, endLine: bestEnd };
      }
    }

    // Fallback: use snippet length to determine end
    return {
      startLine: startLine,
      endLine: Math.min(originalLines.length, expectedEnd)
    };
  }

  return null;
}

/**
 * Find where the AI code's coverage ends within the original file.
 * When AI truncates output (returns fewer lines), we need to know which part
 * of the original the AI code corresponds to, so we only diff that region.
 *
 * Strategy: match the last few non-empty lines of AI code against the original
 * to find the boundary. Returns a line count (0-based exclusive index).
 */
function findOverlapEnd(originalLines, aiLines) {
  // Find the last few significant lines in AI code
  var tailAnchors = [];
  for (var i = aiLines.length - 1; i >= 0 && tailAnchors.length < 3; i--) {
    var trimmed = aiLines[i].trim();
    if (trimmed && trimmed.length > 2) {
      tailAnchors.unshift({ line: trimmed, aiIdx: i });
    }
  }

  if (tailAnchors.length === 0) return originalLines.length; // Can't determine overlap — don't trim

  // Search for the last anchor in the original
  var lastAnchor = tailAnchors[tailAnchors.length - 1];
  // Search from roughly where we'd expect it (near aiLines.length) outward
  var searchStart = Math.min(aiLines.length + 10, originalLines.length - 1);
  for (var delta = 0; delta <= searchStart; delta++) {
    var positions = [searchStart - delta];
    if (searchStart + delta < originalLines.length && delta > 0) {
      positions.push(searchStart + delta);
    }
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      if (pos >= 0 && pos < originalLines.length && originalLines[pos].trim() === lastAnchor.line) {
        // Verify a preceding anchor matches too
        if (tailAnchors.length >= 2) {
          var prevAnchor = tailAnchors[tailAnchors.length - 2];
          var expectedOrigPos = pos - (lastAnchor.aiIdx - prevAnchor.aiIdx);
          if (expectedOrigPos >= 0 && expectedOrigPos < originalLines.length &&
              originalLines[expectedOrigPos].trim() === prevAnchor.line) {
            return pos + 1; // exclusive end index
          }
        } else {
          return pos + 1;
        }
      }
    }
  }

  // Couldn't find a match — use AI line count as overlap boundary
  return Math.min(aiLines.length, originalLines.length);
}

/**
 * Smart merge: intelligently apply AI-generated code to an original file.
 * Works like Copilot — only the changed lines are modified, the rest stays untouched.
 *
 * Strategy:
 *   1. If AI code is a unified diff → parse and apply as patch hunks
 *   2. If AI code is full file or snippet → diff against original → extract hunks → apply only changed lines
 *
 * In ALL strategies, the original file is the base and only the differing lines
 * are replaced. This ensures untouched code is never lost even if AI truncates output.
 *
 * Returns { success, result, diff, strategy, hunks, details }
 */
function applySmartMerge(originalText, aiCode, options) {
  options = options || {};
  var fileName = options.fileName || '';

  // ── Strategy 1: Unified diff ──
  if (isUnifiedDiff(aiCode)) {
    var parsedHunks = parseUnifiedDiff(aiCode);
    if (parsedHunks.length > 0) {
      var patchResult = applyHunks(originalText, parsedHunks);
      var diffStr = computeDiff(originalText, patchResult.result, fileName);
      return {
        success: patchResult.success,
        result: patchResult.result,
        diff: diffStr,
        strategy: 'patch',
        hunks: parsedHunks.length,
        applied: patchResult.applied,
        failed: patchResult.failed,
        details: patchResult.details
      };
    }
  }

  // ── Strategy 2: AI returned code (full file or snippet) ──
  // Rather than replacing the whole file, we:
  //   a) Diff the AI code against the original
  //   b) Extract only the changed hunks
  //   c) Apply those hunks to the original (preserving everything else)

  var originalLines = originalText.split('\n');
  var aiLines = aiCode.split('\n');

  // Strip any leading comment like "// file: path/to/file.js"
  if (aiLines.length > 0 && /^(?:\/\/|#|\/\*|<!--)\s*file:/i.test(aiLines[0])) {
    aiLines = aiLines.slice(1);
    aiCode = aiLines.join('\n');
  }

  // Determine if it's a full file or a snippet
  var strategyName;
  var targetText; // The AI's "intended result" we'll diff against original
  var diffOriginal = originalText; // The slice of original we'll diff against (may be trimmed)

  if (isLikelyFullFile(originalText, aiCode)) {
    strategyName = 'line-patch';
    targetText = aiCode;

    // If AI code is shorter than original, the AI likely truncated its output.
    // Only diff the overlapping region so the tail is never treated as "deleted".
    if (aiLines.length < originalLines.length) {
      // Find where the AI code's last meaningful line appears in the original
      // to determine the true overlap boundary
      var overlapEnd = findOverlapEnd(originalLines, aiLines);
      if (overlapEnd > 0 && overlapEnd < originalLines.length) {
        // Only diff the region the AI actually covered.
        // Ensure both sides have the same trailing newline handling
        var trimmedOrigLines = originalLines.slice(0, overlapEnd);
        // Strip trailing empty elements from both sides for consistent diffing
        while (trimmedOrigLines.length > 0 && trimmedOrigLines[trimmedOrigLines.length - 1] === '') {
          trimmedOrigLines.pop();
        }
        var trimmedAiLines = aiLines.slice();
        while (trimmedAiLines.length > 0 && trimmedAiLines[trimmedAiLines.length - 1] === '') {
          trimmedAiLines.pop();
        }
        diffOriginal = trimmedOrigLines.join('\n');
        targetText = trimmedAiLines.join('\n');
      }
    }
  } else {
    // Try to locate the snippet within the original file
    var location = findSnippetLocation(originalLines, aiLines);
    if (location) {
      // Build a full-file version with only the snippet section replaced
      var before = originalLines.slice(0, location.startLine);
      var after = originalLines.slice(location.endLine);
      targetText = before.concat(aiLines).concat(after).join('\n');
      strategyName = 'snippet-patch';
    } else {
      // Can't locate it — return diff for review without applying
      var fallbackDiff = computeDiff(originalText, aiCode, fileName);
      var fallbackHunks = (fallbackDiff.match(/^@@/gm) || []).length;
      return {
        success: false,
        result: aiCode,
        diff: fallbackDiff,
        strategy: 'fallback',
        hunks: fallbackHunks,
        applied: 0,
        failed: 1,
        details: [{
          status: 'needs-review',
          reason: 'Could not locate snippet in original file. Review the diff carefully before force-applying.'
        }]
      };
    }
  }

  // Now diff the (possibly trimmed) original against the AI's intended result
  var fullDiff = computeDiff(diffOriginal, targetText, fileName);
  if (!fullDiff) {
    return {
      success: true,
      result: originalText,
      diff: '',
      strategy: 'no-change',
      hunks: 0,
      applied: 0,
      failed: 0,
      details: [{ status: 'no-change', reason: 'AI code is identical to original' }]
    };
  }

  // Parse the computed diff back into hunks, then apply them to the original.
  // This is the key step: instead of replacing the file with targetText (which may
  // have truncated/missing parts from AI), we apply ONLY the real changed hunks.
  // Because we trim the original to the overlap region before diffing, truncation
  // artifacts never appear in the diff at all.
  var computedHunks = parseUnifiedDiff(fullDiff);
  if (computedHunks.length === 0) {
    return {
      success: true,
      result: originalText,
      diff: '',
      strategy: 'no-change',
      hunks: 0,
      applied: 0,
      failed: 0,
      details: [{ status: 'no-change', reason: 'No effective changes found' }]
    };
  }

  // Apply hunks to the FULL original (not the trimmed version).
  // The hunks already have correct line numbers within the overlap region.
  var hunkResult = applyHunks(originalText, computedHunks);
  // Recompute the final diff to show the user what actually changed
  var finalDiff = computeDiff(originalText, hunkResult.result, fileName);
  var finalHunkCount = (finalDiff.match(/^@@/gm) || []).length;

  return {
    success: hunkResult.success,
    result: hunkResult.result,
    diff: finalDiff,
    strategy: strategyName,
    hunks: finalHunkCount,
    applied: hunkResult.applied,
    failed: hunkResult.failed,
    details: hunkResult.details
  };
}

// ── Backup utilities ────────────────────────────────────
// Backups are stored OUTSIDE the project directory to avoid polluting
// the repo. Location: ~/Documents/.zoho-bug-track-backups/<project-hash>/...

/**
 * Get the backup root directory.
 * Uses ~/Documents/.zoho-bug-track-backups/ on all platforms.
 */
function getBackupRoot() {
  var home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  // Prefer Documents if it exists, otherwise use home directly
  var docs = path.join(home, 'Documents');
  if (!fs.existsSync(docs)) {
    // Some systems may not have Documents — fall back to home
    docs = home;
  }
  return path.join(docs, '.zoho-bug-track-backups');
}

/**
 * Create a short stable hash from a project directory path.
 * This ensures each project's backups are in a separate folder.
 */
function projectHash(projectDir) {
  var crypto = require('crypto');
  return crypto.createHash('md5').update(path.resolve(projectDir)).digest('hex').substring(0, 10);
}

/**
 * Create a backup of a file before modifying it.
 * Stored at: ~/Documents/.zoho-bug-track-backups/<project-hash>/<relative-path>.bak.<timestamp>
 * Returns the backup file path, or null if source doesn't exist.
 */
function createBackup(projectDir, relativePath) {
  var srcPath = path.resolve(projectDir, relativePath);
  if (!fs.existsSync(srcPath)) return null;

  var backupBase = path.join(getBackupRoot(), projectHash(projectDir));
  var backupPath = path.join(backupBase, relativePath + '.bak.' + Date.now());
  var backupDir = path.dirname(backupPath);

  // Create backup directory recursively
  mkdirpSync(backupDir);

  fs.writeFileSync(backupPath, fs.readFileSync(srcPath));
  console.log('[patch] Backup created:', backupPath);
  logger.info('PATCH', 'Backup created', { file: relativePath, backupPath: backupPath });
  return backupPath;
}

/**
 * Restore a file from its most recent backup.
 * Returns { restored, backupPath } or { restored: false, error }.
 */
function restoreFromBackup(projectDir, relativePath) {
  var backupBase = path.join(getBackupRoot(), projectHash(projectDir));
  var backupPrefix = path.join(backupBase, relativePath + '.bak.');

  // Find the most recent backup
  var backupDir = path.dirname(backupPrefix);
  var baseName = path.basename(backupPrefix);

  if (!fs.existsSync(backupDir)) {
    return { restored: false, error: 'No backup directory found' };
  }

  var files = fs.readdirSync(backupDir);
  var matching = files.filter(function (f) { return f.indexOf(baseName) === 0; });
  matching.sort(); // Timestamps sort lexicographically

  if (matching.length === 0) {
    return { restored: false, error: 'No backup found for ' + relativePath };
  }

  var latestBackup = path.join(backupDir, matching[matching.length - 1]);
  var destPath = path.resolve(projectDir, relativePath);
  fs.writeFileSync(destPath, fs.readFileSync(latestBackup));
  console.log('[patch] Restored from backup:', latestBackup);
  logger.info('PATCH', 'Restored from backup', { file: relativePath, backupPath: latestBackup });

  return { restored: true, backupPath: latestBackup };
}

/**
 * List all available backups for a file.
 */
function listBackups(projectDir, relativePath) {
  var backupBase = path.join(getBackupRoot(), projectHash(projectDir));
  var backupDir = path.dirname(path.join(backupBase, relativePath));
  var baseName = path.basename(relativePath) + '.bak.';

  if (!fs.existsSync(backupDir)) return [];

  var files = fs.readdirSync(backupDir);
  return files.filter(function (f) { return f.indexOf(baseName) === 0; }).map(function (f) {
    var tsMatch = f.match(/\.bak\.(\d+)$/);
    return {
      file: path.join(backupDir, f),
      timestamp: tsMatch ? parseInt(tsMatch[1], 10) : 0,
      date: tsMatch ? new Date(parseInt(tsMatch[1], 10)).toISOString() : 'unknown'
    };
  }).sort(function (a, b) { return b.timestamp - a.timestamp; });
}

/**
 * Recursive mkdir (Node 8 compatible).
 */
function mkdirpSync(dir) {
  if (fs.existsSync(dir)) return;
  var parent = path.dirname(dir);
  if (parent !== dir) mkdirpSync(parent);
  try { fs.mkdirSync(dir); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

// ── Exports ─────────────────────────────────────────────

module.exports = {
  computeDiff: computeDiff,
  parseUnifiedDiff: parseUnifiedDiff,
  applyHunks: applyHunks,
  applySmartMerge: applySmartMerge,
  isUnifiedDiff: isUnifiedDiff,
  isLikelyFullFile: isLikelyFullFile,
  findSnippetLocation: findSnippetLocation,
  createBackup: createBackup,
  restoreFromBackup: restoreFromBackup,
  listBackups: listBackups,
  getBackupRoot: getBackupRoot
};
