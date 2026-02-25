'use strict';
/**
 * zoho-client.js — Per-user Zoho Projects API client.
 * Uses each user's own tokens (from user-store) instead of global .env tokens.
 * Node 8 compatible. Zero dependencies.
 */
var https = require('https');
var url = require('url');
var userStore = require('./user-store');
var zohoAuth = require('./zoho-auth');

var TIMEOUT_MS = 15000;
var MAX_RETRIES = 2;

/**
 * Get a valid access token for a user — auto-refreshes if expired.
 * callback(err, accessToken)
 */
function getTokenForUser(userId, callback) {
  var user = userStore.getUser(userId);
  var tokens = user.zohoTokens || {};

  // If token exists and not expired, use it
  if (tokens.accessToken && tokens.expiresAt && Date.now() < tokens.expiresAt) {
    return callback(null, tokens.accessToken);
  }

  // Need to refresh
  if (!tokens.refreshToken) {
    return callback(new Error('No refresh token. User must re-login.'));
  }

  zohoAuth.refreshAccessToken(tokens.refreshToken, function (err, data) {
    if (err) return callback(err);
    if (!data.access_token) return callback(new Error('Token refresh failed'));

    // Save refreshed token
    var expiresIn = (data.expires_in || 3600) * 1000;
    userStore.saveUser(userId, {
      zohoTokens: {
        accessToken: data.access_token,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + expiresIn - 60000  // 1 min buffer
      }
    });

    callback(null, data.access_token);
  });
}

/**
 * Build API base URL for a user's portal/project.
 */
function apiBase(userId) {
  var user = userStore.getUser(userId);
  var portal = user.zohoPortal || 'logmanagementcloud';
  var projectId = user.zohoProjectId || '';
  return 'https://projectsapi.zoho.in/restapi/portal/' + portal + '/projects/' + projectId;
}

/**
 * GET request to Zoho API for a specific user.
 * callback(err, parsedJSON)
 */
function zohoGet(userId, apiPath, callback, _attempt) {
  var attempt = _attempt || 0;
  var fullUrl = apiPath.indexOf('http') === 0
    ? apiPath
    : apiBase(userId) + '/' + apiPath;
  fullUrl = fullUrl.replace(/\/+/g, '/').replace(':/', '://');

  getTokenForUser(userId, function (err, token) {
    if (err) return callback(err);

    var parsed = url.parse(fullUrl);
    var options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'Authorization': 'Zoho-oauthtoken ' + token,
        'Accept': 'application/json'
      },
      timeout: TIMEOUT_MS
    };

    var req = https.request(options, function (res) {
      var body = '';
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!body || !body.trim()) {
            // Empty body = no results (common for out-of-range pages)
            return callback(null, {});
          }
          try { callback(null, JSON.parse(body)); }
          catch (e) { callback(new Error('JSON parse error: ' + e.message)); }
          return;
        }
        // 401 → force refresh and retry once
        if (res.statusCode === 401 && attempt === 0) {
          // Invalidate cached token
          userStore.saveUser(userId, {
            zohoTokens: { accessToken: '', expiresAt: 0 }
          });
          return setTimeout(function () {
            zohoGet(userId, apiPath, callback, attempt + 1);
          }, 300);
        }
        // 5xx → retry
        if (res.statusCode >= 500 && attempt < MAX_RETRIES) {
          return setTimeout(function () {
            zohoGet(userId, apiPath, callback, attempt + 1);
          }, 500 * (attempt + 1));
        }
        var errMsg = 'Zoho API ' + res.statusCode;
        try {
          var data = JSON.parse(body);
          var detail = data.message || data.error || data.title
                    || (data.details && data.details.message);
          if (detail && typeof detail === 'object') {
            errMsg += ': ' + (detail.message || JSON.stringify(detail));
          } else if (detail) {
            errMsg += ': ' + detail;
          }
        } catch (e) { errMsg += ': ' + body.substring(0, 300); }
        callback(new Error(errMsg));
      });
    });
    req.on('error', function (e) {
      if (attempt < MAX_RETRIES) {
        return setTimeout(function () { zohoGet(userId, apiPath, callback, attempt + 1); }, 500);
      }
      callback(e);
    });
    req.on('timeout', function () {
      req.abort();
      if (attempt < MAX_RETRIES) {
        return setTimeout(function () { zohoGet(userId, apiPath, callback, attempt + 1); }, 500);
      }
      callback(new Error('Zoho API timeout'));
    });
    req.end();
  });
}

/**
 * Download binary data from Zoho API (e.g., attachments).
 * Returns raw Buffer via callback(err, buffer, contentType).
 */
function zohoDownload(userId, downloadUrl, callback, _attempt) {
  var attempt = _attempt || 0;
  getTokenForUser(userId, function (err, token) {
    if (err) return callback(err);

    var parsed = url.parse(downloadUrl);
    var options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'Authorization': 'Zoho-oauthtoken ' + token
      },
      timeout: 30000
    };

    var req = https.request(options, function (res) {
      // Follow redirects (Zoho may 302 to a CDN)
      if (res.statusCode === 301 || res.statusCode === 302) {
        var location = res.headers.location;
        if (location && attempt < 3) {
          return zohoDownload(userId, location, callback, attempt + 1);
        }
        return callback(new Error('Too many redirects'));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return callback(new Error('Download failed: HTTP ' + res.statusCode));
      }

      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        var buffer = Buffer.concat(chunks);
        var contentType = res.headers['content-type'] || 'application/octet-stream';
        callback(null, buffer, contentType);
      });
    });

    req.on('error', function (e) {
      if (attempt < MAX_RETRIES) {
        return setTimeout(function () { zohoDownload(userId, downloadUrl, callback, attempt + 1); }, 500);
      }
      callback(e);
    });
    req.on('timeout', function () {
      req.abort();
      callback(new Error('Download timeout'));
    });
    req.end();
  });
}

module.exports = {
  zohoGet: zohoGet,
  zohoDownload: zohoDownload,
  getTokenForUser: getTokenForUser,
  apiBase: apiBase
};
