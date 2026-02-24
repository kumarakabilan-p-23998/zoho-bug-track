'use strict';
/**
 * zoho-auth.js — Per-user Zoho OAuth2 helpers.
 * Builds auth URL, exchanges code for tokens, refreshes tokens.
 * Node 8 compatible. Zero dependencies.
 */
var https = require('https');
var url = require('url');
var querystring = require('querystring');
var config = require('./env-config');

var AUTH_BASE = 'https://accounts.zoho.in/oauth/v2';
var SCOPE = 'ZohoProjects.bugs.READ,ZohoProjects.bugs.UPDATE,ZohoProjects.users.READ,ZohoProjects.milestones.READ';

/**
 * Build the Zoho authorization URL the user should visit.
 */
function getAuthUrl() {
  var params = querystring.stringify({
    response_type: 'code',
    client_id: config.ZOHO_CLIENT_ID,
    scope: SCOPE,
    redirect_uri: config.REDIRECT_URI,
    access_type: 'offline'
  });
  return AUTH_BASE + '/auth?' + params;
}

/**
 * Exchange authorization code for access + refresh tokens.
 * callback(err, { access_token, refresh_token, expires_in })
 */
function exchangeCode(code, callback) {
  var postData = querystring.stringify({
    grant_type: 'authorization_code',
    client_id: config.ZOHO_CLIENT_ID,
    client_secret: config.ZOHO_CLIENT_SECRET,
    redirect_uri: config.REDIRECT_URI,
    code: code
  });
  _post(AUTH_BASE + '/token', postData, callback);
}

/**
 * Refresh an expired access token using a refresh token.
 * callback(err, { access_token, expires_in })
 */
function refreshAccessToken(refreshToken, callback) {
  var postData = querystring.stringify({
    grant_type: 'refresh_token',
    client_id: config.ZOHO_CLIENT_ID,
    client_secret: config.ZOHO_CLIENT_SECRET,
    refresh_token: refreshToken
  });
  _post(AUTH_BASE + '/token', postData, callback);
}

/**
 * Fetch logged-in user's identity.
 * 1) Try Zoho Accounts user/info endpoint (returns the token owner directly).
 * 2) Fallback to portal users API if accounts endpoint fails.
 * callback(err, { users: [{ zuid, email, name }] })
 */
function fetchUserProfile(accessToken, callback) {
  // --- Strategy 1: Zoho Accounts user/info (most reliable for identity) ---
  var accountsUrl = 'https://accounts.zoho.in/oauth/user/info';
  var parsed1 = url.parse(accountsUrl);
  var opts1 = {
    hostname: parsed1.hostname,
    path: parsed1.path,
    method: 'GET',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + accessToken,
      'Accept': 'application/json'
    },
    timeout: 10000
  };
  var done = false; // guard against double-callback from timeout + error/end
  var req1 = https.request(opts1, function (res1) {
    var body1 = '';
    res1.on('data', function (c) { body1 += c; });
    res1.on('end', function () {
      if (done) return;
      try {
        var d = JSON.parse(body1);
        if (res1.statusCode === 200 && (d.ZUID || d.Email)) {
          var displayName = d.Display_Name || d.First_Name || d.Email || '';
          console.log('Accounts user/info success:', displayName, d.Email);
          done = true;
          return callback(null, {
            users: [{
              zuid: String(d.ZUID || ''),
              email: d.Email || '',
              name: displayName
            }]
          });
        }
      } catch (e) { /* fall through */ }
      console.log('Accounts user/info failed (status ' + res1.statusCode + ', body: ' + body1.substring(0, 200) + '), trying portal users API...');
      done = true;
      _fetchPortalUsers(accessToken, callback);
    });
  });
  req1.on('error', function (e) {
    if (done) return;
    console.log('Accounts user/info network error:', e.message);
    done = true;
    _fetchPortalUsers(accessToken, callback);
  });
  req1.on('timeout', function () {
    if (done) return;
    req1.abort();
    console.log('Accounts user/info timeout');
    done = true;
    _fetchPortalUsers(accessToken, callback);
  });
  req1.end();
}

/**
 * Fallback: Fetch users from the Zoho Projects portal API.
 */
function _fetchPortalUsers(accessToken, callback) {
  var portal = config.ZOHO_PORTAL || 'logmanagementcloud';
  var apiUrl = 'https://projectsapi.zoho.in/restapi/portal/' + portal + '/users/?status=active&index=0&range=100';
  var parsed = url.parse(apiUrl);
  var options = {
    hostname: parsed.hostname,
    path: parsed.path,
    method: 'GET',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + accessToken,
      'Accept': 'application/json'
    },
    timeout: 15000
  };
  var req = https.request(options, function (res) {
    var body = '';
    res.on('data', function (chunk) { body += chunk; });
    res.on('end', function () {
      try {
        var data = JSON.parse(body);
        console.log('Portal Users API response status:', res.statusCode);
        if (data.users && data.users.length > 0) {
          var users = data.users.map(function (u) {
            return {
              zuid: u.id || u.id_string || '',
              email: u.email || '',
              name: u.name || ''
            };
          });
          callback(null, { users: users });
        } else {
          console.log('Portal Users API response body:', body.substring(0, 500));
          callback(new Error('No users returned from portal'));
        }
      } catch (e) {
        callback(new Error('Profile parse error: ' + e.message));
      }
    });
  });
  req.on('error', function (e) { callback(e); });
  req.on('timeout', function () { req.abort(); callback(new Error('Profile request timeout')); });
  req.end();
}

// ── internal POST helper ─────────────────────────────────

function _post(fullUrl, postData, callback) {
  var parsed = url.parse(fullUrl);
  var options = {
    hostname: parsed.hostname,
    path: parsed.path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 15000
  };
  var req = https.request(options, function (res) {
    var body = '';
    res.on('data', function (chunk) { body += chunk; });
    res.on('end', function () {
      try {
        var data = JSON.parse(body);
        if (data.error) {
          callback(new Error(data.error + ': ' + (data.error_description || '')));
        } else {
          callback(null, data);
        }
      } catch (e) {
        callback(new Error('Parse error: ' + body));
      }
    });
  });
  req.on('error', function (e) { callback(e); });
  req.on('timeout', function () { req.abort(); callback(new Error('Request timeout')); });
  req.write(postData);
  req.end();
}

module.exports = {
  getAuthUrl: getAuthUrl,
  exchangeCode: exchangeCode,
  refreshAccessToken: refreshAccessToken,
  fetchUserProfile: fetchUserProfile
};
