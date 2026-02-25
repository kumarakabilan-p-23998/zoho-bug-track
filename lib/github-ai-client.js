'use strict';
/**
 * github-ai-client.js — Call GitHub Models Inference API.
 * Node 8 compatible. Zero dependencies (uses built-in https).
 *
 * Uses the user's GitHub Personal Access Token (PAT) with models:read scope
 * to call the GitHub Models chat/completions endpoint.
 *
 * Endpoint : POST https://models.github.ai/inference/chat/completions
 * Auth     : Authorization: Bearer <GitHub PAT>
 * Model IDs: {publisher}/{model_name}  e.g. "openai/gpt-4.1"
 */
var https = require('https');

var API_HOST = 'models.github.ai';
var API_PATH = '/inference/chat/completions';
var API_VERSION = '2022-11-28';
var MAX_TOKENS = 4096;
var TIMEOUT_MS = 120000; // 2 minutes

/**
 * Models available on GitHub Models API (use Copilot PAT).
 * Claude is NOT on GitHub Models — it needs the Copilot Bridge or Anthropic API key.
 */
var GITHUB_MODELS = [
  { id: 'openai/gpt-4.1',       label: '⭐ GPT-4.1 (OpenAI)',      publisher: 'OpenAI' },
  { id: 'openai/gpt-4.1-mini',  label: 'GPT-4.1 Mini (OpenAI)',    publisher: 'OpenAI' },
  { id: 'openai/gpt-4.1-nano',  label: 'GPT-4.1 Nano (OpenAI)',    publisher: 'OpenAI' },
  { id: 'openai/gpt-4o',        label: 'GPT-4o (OpenAI)',          publisher: 'OpenAI' },
  { id: 'openai/gpt-4o-mini',   label: 'GPT-4o Mini (OpenAI)',     publisher: 'OpenAI' },
  { id: 'deepseek/DeepSeek-R1', label: 'DeepSeek R1',              publisher: 'DeepSeek' },
  { id: 'meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout (Meta)', publisher: 'Meta' },
  { id: 'mistralai/mistral-large-2411',        label: 'Mistral Large',        publisher: 'Mistral' },
  { id: 'xai/grok-3',           label: 'Grok 3 (xAI)',             publisher: 'xAI' },
  { id: 'xai/grok-3-mini',      label: 'Grok 3 Mini (xAI)',        publisher: 'xAI' }
];

/** Claude models — accessed via Copilot Bridge (free) or Anthropic API key. */
var CLAUDE_MODELS = [
  { id: 'claude-opus-4-6',            label: 'Claude Opus 4.6 (Anthropic)',   publisher: 'Anthropic' },
  { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6 (Anthropic)', publisher: 'Anthropic' },
  { id: 'claude-sonnet-4-20250514',   label: 'Claude Sonnet 4 (Anthropic)',   publisher: 'Anthropic' },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Anthropic)', publisher: 'Anthropic' }
];

var AVAILABLE_MODELS = GITHUB_MODELS.concat(CLAUDE_MODELS);
var DEFAULT_MODEL = 'openai/gpt-4.1';

/**
 * Send a prompt to GitHub Models and get the AI response.
 *
 * @param {string}   githubToken - GitHub Personal Access Token (ghp_... or github_pat_...)
 * @param {string}   prompt      - The full fix prompt text
 * @param {object}   [opts]      - Optional: { model, maxTokens, timeoutMs }
 * @param {function} callback    - (err, { text, model, usage })
 */
function analyze(githubToken, prompt, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  opts = opts || {};

  if (!githubToken) {
    return callback(new Error('No GitHub token configured. Add it in Settings → AI Analysis.'));
  }

  var model = opts.model || DEFAULT_MODEL;
  var maxTokens = opts.maxTokens || MAX_TOKENS;
  var timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  var images = opts.images || [];

  // Build message content — multimodal if images present
  var content;
  if (images.length > 0) {
    content = [];
    // Add images first
    images.forEach(function (img) {
      content.push({
        type: 'image_url',
        image_url: {
          url: 'data:' + (img.mediaType || 'image/png') + ';base64,' + img.base64,
          detail: 'auto'
        }
      });
    });
    content.push({
      type: 'text',
      text: prompt + '\n\n> NOTE: ' + images.length + ' bug screenshot(s) attached above. '
        + 'Analyze the visual evidence to identify the exact UI issue and its root cause in code.'
    });
    console.log('[github-ai] Including', images.length, 'image(s) in multimodal prompt');
  } else {
    content = prompt;
  }

  var requestBody = JSON.stringify({
    model: model,
    messages: [
      {
        role: 'user',
        content: content
      }
    ],
    max_tokens: maxTokens
  });

  var requestOptions = {
    hostname: API_HOST,
    port: 443,
    path: API_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + githubToken,
      'X-GitHub-Api-Version': API_VERSION,
      'Content-Length': Buffer.byteLength(requestBody)
    }
  };

  console.log('[github-ai] Sending request — model:', model, 'prompt length:', prompt.length, 'chars');

  var req = https.request(requestOptions, function (res) {
    var body = '';
    res.on('data', function (chunk) { body += chunk; });
    res.on('end', function () {
      try {
        var parsed = JSON.parse(body);
      } catch (e) {
        console.error('[github-ai] Failed to parse response:', body.substring(0, 300));
        return callback(new Error('Invalid JSON response from GitHub Models API'));
      }

      if (res.statusCode !== 200) {
        var errMsg = '';
        if (parsed.error && parsed.error.message) {
          errMsg = parsed.error.message;
        } else if (parsed.message) {
          errMsg = parsed.message;
        } else {
          errMsg = 'API returned HTTP ' + res.statusCode;
        }
        console.error('[github-ai] API error:', res.statusCode, errMsg);
        return callback(new Error(errMsg));
      }

      // Extract text from chat completion response
      var text = '';
      if (parsed.choices && parsed.choices.length > 0) {
        var msg = parsed.choices[0].message;
        if (msg && msg.content) {
          text = msg.content;
        }
      }

      if (!text) {
        console.error('[github-ai] Empty response — choices:', JSON.stringify(parsed.choices || []).substring(0, 200));
        return callback(new Error('No content in AI response'));
      }

      console.log('[github-ai] Response received — length:', text.length, 'chars, model:', parsed.model || model);

      callback(null, {
        text: text,
        model: parsed.model || model,
        usage: parsed.usage || {},
        finishReason: (parsed.choices && parsed.choices[0]) ? parsed.choices[0].finish_reason : ''
      });
    });
  });

  req.on('error', function (err) {
    console.error('[github-ai] Request error:', err.message);
    callback(new Error('GitHub Models API request failed: ' + err.message));
  });

  req.setTimeout(timeoutMs, function () {
    req.abort();
    callback(new Error('GitHub Models API request timed out after ' + (timeoutMs / 1000) + 's'));
  });

  req.write(requestBody);
  req.end();
}

/**
 * Check if a model ID is a Claude/Anthropic model.
 */
function isClaudeModel(modelId) {
  return /^claude-/i.test(modelId || '');
}

/**
 * Discover available models by querying the GitHub Models API.
 * Uses the user's GitHub PAT to see which models they can access.
 *
 * @param {string}   githubToken - GitHub PAT (from Copilot subscription etc.)
 * @param {function} callback    - (err, { discovered, models, count, message })
 */
function discoverModels(githubToken, callback) {
  if (!githubToken) {
    return callback(null, { discovered: false, models: AVAILABLE_MODELS, message: 'No GitHub token. Save your token first, then discover.' });
  }

  var requestOptions = {
    hostname: API_HOST,
    port: 443,
    path: '/catalog/models',
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + githubToken,
      'Accept': 'application/json'
    }
  };

  console.log('[github-ai] Discovering available models...');

  var req = https.request(requestOptions, function (res) {
    var body = '';
    res.on('data', function (chunk) { body += chunk; });
    res.on('end', function () {
      if (res.statusCode !== 200) {
        console.log('[github-ai] Model discovery HTTP', res.statusCode);
        return callback(null, { discovered: false, models: AVAILABLE_MODELS, message: 'API returned HTTP ' + res.statusCode + '. Using default model list.' });
      }
      try {
        var parsed = JSON.parse(body);
        var list = Array.isArray(parsed) ? parsed : (parsed.data || parsed.models || []);
        if (!Array.isArray(list) || list.length === 0) {
          return callback(null, { discovered: false, models: AVAILABLE_MODELS, message: 'Empty response. Using default list.' });
        }
        var models = list.map(function (m) {
          return {
            id: m.id || m.name || '',
            label: m.friendly_name || m.name || m.id || '',
            publisher: m.publisher || m.owned_by || ''
          };
        }).filter(function (m) { return m.id; });

        console.log('[github-ai] Discovered', models.length, 'models');
        callback(null, { discovered: true, models: models, count: models.length });
      } catch (e) {
        console.error('[github-ai] Failed to parse discovery response');
        callback(null, { discovered: false, models: AVAILABLE_MODELS, message: 'Could not parse response. Using defaults.' });
      }
    });
  });

  req.on('error', function (err) {
    console.error('[github-ai] Discovery error:', err.message);
    callback(null, { discovered: false, models: AVAILABLE_MODELS, message: 'Connection error: ' + err.message });
  });

  req.setTimeout(15000, function () {
    req.abort();
    callback(null, { discovered: false, models: AVAILABLE_MODELS, message: 'Request timed out. Using defaults.' });
  });

  req.end();
}

module.exports = {
  analyze: analyze,
  discoverModels: discoverModels,
  isClaudeModel: isClaudeModel,
  AVAILABLE_MODELS: AVAILABLE_MODELS,
  GITHUB_MODELS: GITHUB_MODELS,
  CLAUDE_MODELS: CLAUDE_MODELS,
  DEFAULT_MODEL: DEFAULT_MODEL
};
