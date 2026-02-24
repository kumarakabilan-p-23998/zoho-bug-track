/* ─────────────────────────────────────────────────────────────────────────────
 *  Copilot Bridge Client
 *  Talks to the Copilot AI Bridge VS Code extension running on port 3001.
 *  Provides health-check and analyze functions.
 *  Node 8+ compatible (var, callbacks, no async/await).
 * ───────────────────────────────────────────────────────────────────────────── */

'use strict';

var http = require('http');

var BRIDGE_HOST = '127.0.0.1';
var BRIDGE_PORT = 3001;
var TIMEOUT_MS  = 120000; // 2 minutes for analysis

/* ── Model family mapping ────────────────────────────────────────────────── */
// Maps our model IDs → Copilot model "family" names used by vscode.lm API

var FAMILY_MAP = {
  'claude-opus-4-6':            'claude-opus-4',
  'claude-sonnet-4-6':          'claude-sonnet-4',
  'claude-sonnet-4-20250514':   'claude-sonnet-4',
  'claude-3-5-sonnet-20241022': 'claude-3.5-sonnet',
  'gpt-4o':                     'gpt-4o',
  'gpt-4o-mini':                'gpt-4o-mini',
  'openai/gpt-4o':              'gpt-4o',
  'openai/gpt-4o-mini':         'gpt-4o-mini'
};

/**
 * Convert a model ID (from our dropdown) to the Copilot family name.
 */
function getModelFamily(modelId) {
  if (!modelId) return 'claude-opus-4';
  // Direct match
  if (FAMILY_MAP[modelId]) return FAMILY_MAP[modelId];
  // Strip publisher prefix (e.g. "openai/gpt-4o" → "gpt-4o") and try again
  var stripped = modelId.replace(/^[^\/]+\//, '');
  if (FAMILY_MAP[stripped]) return FAMILY_MAP[stripped];
  // Use as-is (the extension will attempt fuzzy matching)
  return stripped || modelId;
}

/* ── Health Check ────────────────────────────────────────────────────────── */

/**
 * Check if the Copilot Bridge is running and list available models.
 * callback(err, { ok, name, port, models })
 */
function checkHealth(callback) {
  var req = http.get({
    hostname: BRIDGE_HOST,
    port:     BRIDGE_PORT,
    path:     '/health',
    timeout:  5000
  }, function (res) {
    var body = '';
    res.on('data', function (c) { body += c; });
    res.on('end', function () {
      try {
        var data = JSON.parse(body);
        callback(null, data);
      } catch (e) {
        callback(new Error('Invalid bridge response'));
      }
    });
  });

  req.on('error', function (err) { callback(err); });
  req.on('timeout', function ()  { req.abort(); callback(new Error('Bridge health check timed out')); });
}

/* ── Analyze ─────────────────────────────────────────────────────────────── */

/**
 * Send an analysis prompt to the Copilot Bridge.
 * @param {string} prompt  – Full analysis prompt text
 * @param {string} modelId – Model ID from our dropdown (mapped to family)
 * @param {object} [opts]  – { timeoutMs }
 * @param {function} callback – (err, { text, model, usage })
 */
function analyze(prompt, modelId, opts, callback) {
  if (typeof opts === 'function') { callback = opts; opts = {}; }
  opts = opts || {};

  var family      = getModelFamily(modelId);
  var timeoutMs   = opts.timeoutMs || TIMEOUT_MS;
  var requestBody = JSON.stringify({ prompt: prompt, modelFamily: family });

  console.log('[copilot-bridge] Request — family:', family, '(from:', modelId + ') prompt:', prompt.length, 'chars');

  var req = http.request({
    hostname: BRIDGE_HOST,
    port:     BRIDGE_PORT,
    path:     '/analyze',
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length':  Buffer.byteLength(requestBody)
    },
    timeout: timeoutMs
  }, function (res) {
    var body = '';
    res.on('data', function (c) { body += c; });
    res.on('end', function () {
      var data;
      try { data = JSON.parse(body); } catch (e) {
        return callback(new Error('Invalid bridge response'));
      }
      if (res.statusCode !== 200 || data.error) {
        return callback(new Error(data.error || ('Bridge returned HTTP ' + res.statusCode)));
      }
      console.log('[copilot-bridge] Response —', (data.text || '').length, 'chars, model:', data.model);
      callback(null, {
        text:  data.text  || '',
        model: data.model || family,
        usage: data.usage || {}
      });
    });
  });

  req.on('error', function (err) {
    callback(new Error('Copilot Bridge not reachable: ' + err.message));
  });

  req.on('timeout', function () {
    req.abort();
    callback(new Error('Copilot Bridge request timed out after ' + Math.round(timeoutMs / 1000) + 's'));
  });

  req.write(requestBody);
  req.end();
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  checkHealth:    checkHealth,
  analyze:        analyze,
  getModelFamily: getModelFamily,
  FAMILY_MAP:     FAMILY_MAP,
  BRIDGE_PORT:    BRIDGE_PORT,
  BRIDGE_HOST:    BRIDGE_HOST
};
