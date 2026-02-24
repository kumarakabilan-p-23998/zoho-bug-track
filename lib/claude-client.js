'use strict';
/**
 * claude-client.js — Call Anthropic's Claude Messages API.
 * Node 8 compatible. Zero dependencies (uses built-in https).
 *
 * Sends the generated fix prompt to Claude and returns the AI analysis.
 */
var https = require('https');

var ANTHROPIC_API_HOST = 'api.anthropic.com';
var ANTHROPIC_API_PATH = '/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';
var MODEL = 'claude-sonnet-4-20250514';
var MAX_TOKENS = 4096;
var TIMEOUT_MS = 120000; // 2 minutes — large prompts take time

/**
 * Send a prompt to Claude and get the AI response.
 *
 * @param {string} apiKey   - Anthropic API key (sk-ant-...)
 * @param {string} prompt   - The full fix prompt text
 * @param {object} [opts]   - Optional: { model, maxTokens, timeoutMs }
 * @param {function} callback - (err, { text, model, usage })
 */
function analyze(apiKey, prompt, opts, callback) {
  if (typeof opts === 'function') {
    callback = opts;
    opts = {};
  }
  opts = opts || {};

  if (!apiKey) {
    return callback(new Error('No Claude API key configured. Add it in Settings.'));
  }

  var model = opts.model || MODEL;
  var maxTokens = opts.maxTokens || MAX_TOKENS;
  var timeoutMs = opts.timeoutMs || TIMEOUT_MS;

  var requestBody = JSON.stringify({
    model: model,
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  var requestOptions = {
    hostname: ANTHROPIC_API_HOST,
    port: 443,
    path: ANTHROPIC_API_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Length': Buffer.byteLength(requestBody)
    }
  };

  console.log('[claude] Sending request — model:', model, 'prompt length:', prompt.length, 'chars');

  var req = https.request(requestOptions, function (res) {
    var body = '';
    res.on('data', function (chunk) { body += chunk; });
    res.on('end', function () {
      try {
        var parsed = JSON.parse(body);
      } catch (e) {
        console.error('[claude] Failed to parse response:', body.substring(0, 200));
        return callback(new Error('Invalid JSON response from Claude API'));
      }

      if (res.statusCode !== 200) {
        var errMsg = (parsed.error && parsed.error.message) || ('API returned ' + res.statusCode);
        console.error('[claude] API error:', res.statusCode, errMsg);
        return callback(new Error(errMsg));
      }

      // Extract text from response
      var text = '';
      if (parsed.content && Array.isArray(parsed.content)) {
        parsed.content.forEach(function (block) {
          if (block.type === 'text') text += block.text;
        });
      }

      console.log('[claude] Response received — length:', text.length, 'chars, model:', parsed.model);

      callback(null, {
        text: text,
        model: parsed.model || model,
        usage: parsed.usage || {},
        stopReason: parsed.stop_reason || ''
      });
    });
  });

  req.on('error', function (err) {
    console.error('[claude] Request error:', err.message);
    callback(new Error('Claude API request failed: ' + err.message));
  });

  req.setTimeout(timeoutMs, function () {
    req.abort();
    callback(new Error('Claude API request timed out after ' + (timeoutMs / 1000) + 's'));
  });

  req.write(requestBody);
  req.end();
}

module.exports = {
  analyze: analyze
};
