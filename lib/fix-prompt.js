'use strict';
/**
 * fix-prompt.js — Generate structured AI fix prompts.
 * Combines bug details + code analysis context into a copy-pasteable prompt.
 * Node 8 compatible. Zero dependencies.
 */
var codeAnalyzer = require('./code-analyzer');
var userStore = require('./user-store');

var CODING_STANDARDS = [
  '## Coding Standards (STRICT)',
  '',
  '### Ember.js 1.13.15',
  '- Define in order: Service injections → Properties → Computed → Hooks → Functions → Actions',
  '- Use `Ember.Component.extend({})` syntax (NOT ES6 classes)',
  '- Use `this.get("prop")` / `this.set("prop", val)` (NOT `this.prop`)',
  '- Use `Ember.computed()` (NOT @computed decorators)',
  '- Templates use `{{}}` (NOT `<AngleBracket />` syntax)',
  '- Clean event listeners in `willDestroyElement`',
  '- Use `this.$()` inside components (not global `$()`)',
  '- Avoid `sendAction` — use closure actions',
  '- Use `Ember.run.scheduleOnce` for DOM updates, avoid `run.later`',
  '- Create mutable objects in `init()` with `Ember.Object.create()`',
  '',
  '### Java 8 Backend',
  '- Null safety — check all parameters, use Optional',
  '- Proper exception handling — no swallowed exceptions',
  '- Optimized DB queries — avoid N+1',
  '- Thread safety — synchronize shared state',
  '- Use try-with-resources for AutoCloseable',
  ''
].join('\n');

/**
 * Build a complete fix prompt for a bug.
 * @param {object} bugDetails - { bug, text } from bug-service
 * @param {object} analysis   - result from code-analyzer.analyzeForBug
 * @returns {string} the prompt
 */
function buildPrompt(bugDetails, analysis, extraDescription) {
  var bug = bugDetails.bug || {};
  var sections = [];

  // Role
  sections.push([
    '## Role',
    '',
    'You are a **Senior Full-Stack Developer** expert in:',
    '- **Ember.js 1.13.15** (legacy Ember with globals, `Ember.Component.extend()`)',
    '- **Java 8** backend',
    '- Large-scale enterprise codebases',
    ''
  ].join('\n'));

  // Bug details
  sections.push([
    '## Bug Details (ID: ' + bug.id + ')',
    '',
    bugDetails.text || '',
    ''
  ].join('\n'));

  // Extra description / context from user
  if (extraDescription) {
    sections.push([
      '## Additional Context (provided by developer)',
      '',
      extraDescription,
      ''
    ].join('\n'));
  }

  // Analysis summary
  if (analysis) {
    var summaryLines = ['## Analysis Summary', ''];
    if (analysis.keywords && analysis.keywords.length > 0) {
      summaryLines.push('**Keywords searched:** ' + analysis.keywords.join(', '));
    }
    if (analysis.relevantFiles) {
      summaryLines.push('**Relevant files found:** ' + analysis.relevantFiles.length);
    }
    if (analysis.codeMatches) {
      summaryLines.push('**Code matches found:** ' + analysis.codeMatches.length);
    }
    if (analysis.fileScores && analysis.fileScores.length > 0) {
      summaryLines.push('');
      summaryLines.push('**Top files by relevance:**');
      analysis.fileScores.slice(0, 5).forEach(function (s) {
        summaryLines.push('- `' + s.file + '` (score: ' + s.score + ', keywords: ' + (s.keywords || []).join(', ') + ')');
      });
    }
    summaryLines.push('');
    sections.push(summaryLines.join('\n'));
  }

  // Code context
  if (analysis && analysis.relevantFiles && analysis.relevantFiles.length > 0) {
    sections.push([
      '## Relevant Files Found in Project',
      '',
      analysis.relevantFiles.map(function (f) { return '- `' + f + '`'; }).join('\n'),
      ''
    ].join('\n'));
  }

  if (analysis && analysis.codeMatches && analysis.codeMatches.length > 0) {
    sections.push([
      '## Code Matches (grep results)',
      '',
      analysis.codeMatches.slice(0, 30).map(function (m) {
        return '`' + m.file + ':' + m.line + '` — ' + m.text;
      }).join('\n'),
      ''
    ].join('\n'));
  }

  if (analysis && analysis.fileContents && analysis.fileContents.length > 0) {
    sections.push('## File Contents\n');
    analysis.fileContents.forEach(function (fc) {
      sections.push([
        '### `' + fc.file + '`' + (fc.truncated ? ' (truncated)' : ''),
        '```',
        fc.content,
        '```',
        ''
      ].join('\n'));
    });
  }

  // Task
  sections.push([
    '## What You Must Do',
    '',
    '### 1. Analyze',
    '- Bug name, description, attachments, comments',
    '- Steps to reproduce',
    '- Expected vs Actual behavior',
    '',
    '### 2. Identify Root Cause',
    '- Frontend (Ember) / Backend (Java) / Integration / State issue',
    '- Regression, performance, or memory-leak risk',
    '',
    '### 3. Provide Fix',
    '- Root cause explanation',
    '- Code-level fix (following coding standards)',
    '- Refactored code if needed',
    '- Test case suggestions',
    ''
  ].join('\n'));

  // Standards
  sections.push(CODING_STANDARDS);

  // Output format
  sections.push([
    '## Required Output Format',
    '',
    '1. 🧠 **Root Cause Analysis** — What is causing this bug and why',
    '2. 🔍 **Affected Files** — All files that need changes (full paths)',
    '3. 💡 **Fix Strategy** — High-level approach',
    '4. 🛠 **Code Fix** — Actual code changes',
    '5. 🧪 **Test Cases** — Manual/automated test suggestions',
    '6. 🚨 **Regression Risks** — What could break',
    '7. 📌 **Summary** — One-paragraph summary',
    ''
  ].join('\n'));

  return sections.join('\n');
}

/**
 * Full analysis: fetch bug context + scan user's project → generate prompt.
 * @param {string} userId
 * @param {object} bugDetails - from bug-service.getBugDetails
 * @returns {object} { prompt, analysis }
 */
function generatePrompt(userId, bugDetails, extraDescription) {
  var user = userStore.getUser(userId);
  var analysis = null;
  var desc = bugDetails.bug.description || '';
  if (extraDescription) desc = desc + ' ' + extraDescription;

  // Use full bug text (includes comments, attachments) for richer keyword extraction
  var fullText = bugDetails.text || '';
  if (extraDescription) fullText = fullText + ' ' + extraDescription;

  if (user.projectDir && require('fs').existsSync(user.projectDir)) {
    var keywords = codeAnalyzer.extractKeywords(
      bugDetails.bug.title,
      desc,
      fullText
    );
    console.log('[analyze] Local mode keywords:', keywords.join(', '));
    analysis = codeAnalyzer.analyzeForBug(user.projectDir, keywords, {
      extensions: user.fileExtensions,
      excludeDirs: user.excludeDirs
    });
  }

  var prompt = buildPrompt(bugDetails, analysis, extraDescription);
  return {
    prompt: prompt,
    analysis: analysis
  };
}

/**
 * Full analysis via remote agent: call agent's /analyze endpoint → generate prompt.
 * @param {string} userId
 * @param {object} bugDetails - from bug-service.getBugDetails
 * @param {string} agentUrl - the agent base URL
 * @param {function} callback - (err, { prompt, analysis })
 */
function generatePromptViaAgent(userId, bugDetails, agentUrl, extraDescription, callback) {
  var agentProxy = require('./agent-proxy');
  var desc = bugDetails.bug.description || '';
  if (extraDescription) desc = desc + ' ' + extraDescription;

  // Use full bug text (includes comments, attachments) for richer keyword extraction
  var fullText = bugDetails.text || '';
  if (extraDescription) fullText = fullText + ' ' + extraDescription;

  var keywords = codeAnalyzer.extractKeywords(
    bugDetails.bug.title,
    desc,
    fullText
  );

  console.log('[analyze] Agent mode — agentUrl:', agentUrl, 'keywords:', keywords.join(', '), 'extraDesc length:', (extraDescription || '').length);

  agentProxy.analyzeForBug(agentUrl, keywords).then(function (analysis) {
    console.log('[analyze] Agent returned:', (analysis.relevantFiles || []).length, 'files,', (analysis.codeMatches || []).length, 'matches');
    var prompt = buildPrompt(bugDetails, analysis, extraDescription);
    callback(null, { prompt: prompt, analysis: analysis });
  }).catch(function (err) {
    // Surface the error instead of silently swallowing
    console.error('[analyze] Agent error:', err.message || err);
    var prompt = buildPrompt(bugDetails, null, extraDescription);
    callback(null, { prompt: prompt, analysis: null, agentError: err.message || 'Agent connection failed' });
  });
}

module.exports = {
  buildPrompt: buildPrompt,
  generatePrompt: generatePrompt,
  generatePromptViaAgent: generatePromptViaAgent
};
