'use strict';
/**
 * env-config.js — Load .env and export server-level config.
 * Node 8 compatible. Zero dependencies.
 */
var fs = require('fs');
var path = require('path');

// ── manual .env parser ──────────────────────────────────

function loadEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    var lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var eq = line.indexOf('=');
      if (eq === -1) continue;
      var key = line.substring(0, eq).trim();
      var val = line.substring(eq + 1).trim();
      if ((val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
          (val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")) {
        val = val.substring(1, val.length - 1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) { /* ignore */ }
}

loadEnv(path.resolve(__dirname, '..', '.env'));

// ── export ───────────────────────────────────────────────

var PORT = parseInt(process.env.PORT, 10) || 3000;

module.exports = {
  PORT: PORT,
  ZOHO_CLIENT_ID: (process.env.ZOHO_CLIENT_ID || '').trim(),
  ZOHO_CLIENT_SECRET: (process.env.ZOHO_CLIENT_SECRET || '').trim(),
  ZOHO_PORTAL: (process.env.ZOHO_PORTAL || 'logmanagementcloud').trim(),
  ZOHO_PROJECT_ID: (process.env.ZOHO_PROJECT_ID || '').trim(),
  SESSION_SECRET: (process.env.SESSION_SECRET || 'default-secret').trim(),
  REDIRECT_URI: 'http://localhost:' + PORT + '/oauth/callback'
};
