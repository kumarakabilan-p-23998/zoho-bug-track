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
function buildPrompt(bugDetails, analysis, extraDescription, templateContext, parsedDesc) {
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

  // ── Structured QA Data (from parsed description format) ──
  if (parsedDesc) {
    var structLines = ['## 🎯 Structured Bug Report (from QA)', ''];

    if (parsedDesc.page) {
      structLines.push('**Page:** ' + parsedDesc.page);
      structLines.push('');
    }

    if (parsedDesc.steps && parsedDesc.steps.length > 0) {
      structLines.push('### Reproduction Steps');
      structLines.push('> These are the **exact steps from QA** to reproduce this bug. Follow them precisely.');
      structLines.push('');
      for (var si = 0; si < parsedDesc.steps.length; si++) {
        structLines.push((si + 1) + '. ' + parsedDesc.steps[si]);
      }
      structLines.push('');
    }

    if (parsedDesc.expected) {
      structLines.push('**Expected:** ' + parsedDesc.expected);
    }
    if (parsedDesc.actual) {
      structLines.push('**Actual:** ' + parsedDesc.actual);
    }
    if (parsedDesc.expected || parsedDesc.actual) {
      structLines.push('');
    }

    sections.push(structLines.join('\n'));
  }

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

  // ── Page-specific files from route template context (Layer 2) ──
  // These are the ACTUAL files for the bug's page — highest priority for fixes
  if (templateContext && templateContext.hasTemplate) {
    var pageLines = [
      '## 🎯 Page Files for Route: `' + (templateContext.route ? templateContext.route.path : '') + '`',
      '',
      '> **IMPORTANT:** These are the exact files that render the page where this bug occurs.',
      '> Focus your fix suggestions on these files first. The grep results below are supplementary.',
      ''
    ];

    // Main route template
    if (templateContext.template) {
      pageLines.push('### Route Template: `' + templateContext.template.path + '`');
      pageLines.push('```hbs');
      var tContent = templateContext.template.content;
      if (tContent.length > 6000) tContent = tContent.substring(0, 6000) + '\n{{!-- truncated --}}';
      pageLines.push(tContent);
      pageLines.push('```');
      pageLines.push('');
    }

    // Component templates + JS
    if (templateContext.componentTemplates && templateContext.componentTemplates.length > 0) {
      pageLines.push('### Component Templates (nested in this page)');
      pageLines.push('');
      templateContext.componentTemplates.forEach(function (ct) {
        pageLines.push('#### `' + (ct.path || ct.name) + '`');
        pageLines.push('```hbs');
        var cContent = ct.content;
        if (cContent.length > 4000) cContent = cContent.substring(0, 4000) + '\n{{!-- truncated --}}';
        pageLines.push(cContent);
        pageLines.push('```');
        if (ct.jsContent) {
          pageLines.push('**Component JS:** `' + (ct.jsPath || ct.name + '/component.js') + '`');
          pageLines.push('```js');
          var jsC = ct.jsContent;
          if (jsC.length > 4000) jsC = jsC.substring(0, 4000) + '\n// ... truncated ...';
          pageLines.push(jsC);
          pageLines.push('```');
        }
        pageLines.push('');
      });
    }

    // Route/Controller JS
    if (templateContext.routeJS && templateContext.routeJS.length > 0) {
      pageLines.push('### Route & Controller JS');
      pageLines.push('');
      templateContext.routeJS.forEach(function (rj) {
        pageLines.push('#### `' + rj.path + '` (' + rj.type + ')');
        pageLines.push('```js');
        pageLines.push(rj.content);
        pageLines.push('```');
        pageLines.push('');
      });
    }

    sections.push(pageLines.join('\n'));
  }

  // Code context (grep-based — supplementary to page files above)
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
function generatePrompt(userId, bugDetails, extraDescription, parsedDesc) {
  var user = userStore.getUser(userId);
  var analysis = null;
  var desc = bugDetails.bug.description || '';
  if (extraDescription) desc = desc + ' ' + extraDescription;

  // Use full bug text (includes comments, attachments) for richer keyword extraction
  var fullText = bugDetails.text || '';
  if (extraDescription) fullText = fullText + ' ' + extraDescription;

  if (user.projectDir && require('fs').existsSync(user.projectDir)) {
    console.log('[fix-prompt] Extracting keywords from bug text...');
    var keywords = codeAnalyzer.extractKeywords(
      bugDetails.bug.title,
      desc,
      fullText
    );
    console.log('[fix-prompt] Keywords (' + keywords.length + '):', keywords.join(', '));
    console.log('[fix-prompt] Scanning project:', user.projectDir);
    var _scanStart = Date.now();
    analysis = codeAnalyzer.analyzeForBug(user.projectDir, keywords, {
      extensions: user.fileExtensions,
      excludeDirs: user.excludeDirs
    });
    console.log('[fix-prompt] Scan complete in', (Date.now() - _scanStart) + 'ms');
  }

  var prompt = buildPrompt(bugDetails, analysis, extraDescription, null, parsedDesc || null);
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
function generatePromptViaAgent(userId, bugDetails, agentUrl, extraDescription, callback, templateContext, parsedDesc) {
  var agentProxy = require('./agent-proxy');
  var desc = bugDetails.bug.description || '';
  if (extraDescription) desc = desc + ' ' + extraDescription;

  // Use full bug text (includes comments, attachments) for richer keyword extraction
  var fullText = bugDetails.text || '';
  if (extraDescription) fullText = fullText + ' ' + extraDescription;

  console.log('[fix-prompt] Extracting keywords from bug text...');
  var keywords = codeAnalyzer.extractKeywords(
    bugDetails.bug.title,
    desc,
    fullText
  );

  console.log('[fix-prompt] Keywords (' + keywords.length + '):', keywords.join(', '));
  console.log('[fix-prompt] Sending to agent at', agentUrl, '...');
  if (parsedDesc) console.log('[fix-prompt] 📋 Structured QA data available: page=' + (parsedDesc.page || ''), 'steps=' + (parsedDesc.steps || []).length);

  agentProxy.analyzeForBug(agentUrl, keywords).then(function (analysis) {
    console.log('[fix-prompt] Agent returned:', (analysis.relevantFiles || []).length, 'files,', (analysis.codeMatches || []).length, 'matches');
    if (templateContext && templateContext.hasTemplate) {
      console.log('[fix-prompt] 🎯 Injecting page template context:', templateContext.totalTemplates, 'templates,', (templateContext.routeJS || []).length, 'JS files');
    }
    console.log('[fix-prompt] Building AI prompt...');
    var prompt = buildPrompt(bugDetails, analysis, extraDescription, templateContext || null, parsedDesc || null);
    console.log('[fix-prompt] Prompt built:', prompt.length, 'chars');
    callback(null, { prompt: prompt, analysis: analysis });
  }).catch(function (err) {
    console.error('[fix-prompt] ❌ Agent error:', err.message || err);
    console.log('[fix-prompt] Building prompt without code context...');
    var prompt = buildPrompt(bugDetails, null, extraDescription, templateContext || null, parsedDesc || null);
    callback(null, { prompt: prompt, analysis: null, agentError: err.message || 'Agent connection failed' });
  });
}

module.exports = {
  buildPrompt: buildPrompt,
  generatePrompt: generatePrompt,
  generatePromptViaAgent: generatePromptViaAgent
};
