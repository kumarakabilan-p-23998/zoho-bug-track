'use strict';
/**
 * bug-service.js — Fetch and filter bugs from Zoho Projects.
 * Uses per-user tokens via zoho-client.
 * Node 8 compatible. Zero dependencies.
 */
var zohoClient = require('./zoho-client');
var userStore = require('./user-store');

// ── In-memory bug cache ──
// Caches ALL bugs per user per API-param set for 2 minutes.
// Post-filters (status, milestone, assignee) are applied instantly from cache.
// Avoids hitting Zoho's 100-requests-per-2-minutes rate limit.
var _bugCache = {};
var CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

function _cacheKey(userId, apiParts) {
  return userId + '|' + apiParts.slice().sort().join('&');
}

function _getCached(userId, apiParts) {
  var key = _cacheKey(userId, apiParts);
  var entry = _bugCache[key];
  if (entry && (Date.now() - entry.fetchedAt) < CACHE_TTL_MS) {
    return entry.bugs;
  }
  if (entry) delete _bugCache[key];
  return null;
}

function _setCache(userId, apiParts, bugs) {
  var key = _cacheKey(userId, apiParts);
  _bugCache[key] = { bugs: bugs, fetchedAt: Date.now() };
}

/**
 * Fetch the logged-in user's own bugs via /mybugs/ endpoint.
 * This uses the OAuth token identity directly — no ZUID or assignee name needed.
 * filters: { status, milestone, index, range }
 * callback(err, { bugs:[], totalCount, loginUser })
 */
function listMyBugs(userId, filters, callback) {
  filters = filters || {};
  var milestoneFilter = filters.milestone || '';
  var statusFilter = (filters.status || '').trim();
  var index = parseInt(filters.index, 10) || 0;
  var range = parseInt(filters.range, 10) || 25;

  var myBugsCacheKey = ['mybugs', userId];
  var cachedMyBugs = _getCached(userId, myBugsCacheKey);

  if (cachedMyBugs) {
    var filtered = _applyPostFilters(cachedMyBugs, statusFilter, milestoneFilter, '');
    var total = filtered.length;
    var paged = filtered.slice(index, index + range);
    var loginUser = _detectLoginUserFromBugs(cachedMyBugs);
    return callback(null, {
      bugs: paged,
      totalCount: total,
      index: index,
      range: range,
      fromCache: true,
      loginUser: loginUser
    });
  }

  var userObj = userStore.getUser(userId);
  var portal = userObj.zohoPortal || 'logmanagementcloud';
  var projectId = userObj.zohoProjectId || '';

  _fetchMyBugs(userId, portal, projectId, function (err, allBugs) {
    if (err) return callback(err);
    _setCache(userId, myBugsCacheKey, allBugs);

    var filtered = _applyPostFilters(allBugs, statusFilter, milestoneFilter, '');
    var total = filtered.length;
    var paged = filtered.slice(index, index + range);
    var loginUser = _detectLoginUserFromBugs(allBugs);
    callback(null, {
      bugs: paged,
      totalCount: total,
      index: index,
      range: range,
      fromCache: false,
      loginUser: loginUser
    });
  });
}

/**
 * Detect the logged-in user's name from their /mybugs/ results.
 * Since /mybugs/ returns only bugs assigned to the token owner,
 * the most common assignee_name IS the logged-in user.
 */
function _detectLoginUserFromBugs(bugs) {
  if (!bugs || bugs.length === 0) return null;
  // Count assignee occurrences — the most frequent is the logged-in user
  var counts = {};
  bugs.forEach(function (b) {
    if (b.assignee) {
      counts[b.assignee] = (counts[b.assignee] || 0) + 1;
    }
  });
  var maxName = '';
  var maxCount = 0;
  Object.keys(counts).forEach(function (name) {
    if (counts[name] > maxCount) {
      maxCount = counts[name];
      maxName = name;
    }
  });
  return maxName || null;
}

/**
 * Fetch bugs list with optional filters.
 * filters: { status, severity, assignee, milestone, module, index, range }
 * callback(err, { bugs:[], totalCount })
 *
 * Caching: API params (severity, module, reporter, flag) determine cache key.
 * Post-filters (status, milestone, assignee) are applied from cached bug list.
 * Cache TTL = 2 min → first request fetches all bugs, subsequent are instant.
 */
function listBugs(userId, filters, callback) {
  filters = filters || {};
  var milestoneFilter = filters.milestone || '';
  var assigneeFilter = (filters.assignee || '').trim();
  var statusFilter = (filters.status || '').trim();
  var assigneeZuid = (filters.assigneeZuid || '').trim();

  // Build API query params — only params Zoho API actually respects
  var apiParts = [];
  if (filters.severity) apiParts.push('severity=' + encodeURIComponent(filters.severity));
  if (filters.module) apiParts.push('module_id=' + encodeURIComponent(filters.module));
  if (filters.reporter) apiParts.push('reported_person=' + encodeURIComponent(filters.reporter));
  if (filters.flag) apiParts.push('flag=' + encodeURIComponent(filters.flag));

  var index = parseInt(filters.index, 10) || 0;
  var range = parseInt(filters.range, 10) || 25;

  // ── When ZUID is set, use /mybugs/ endpoint for COMPLETE bug list ──
  // The project-level bugs API only returns Open bugs with ZUID filter.
  // /mybugs/ returns ALL statuses (Open, Fixed, Closed, Next Release, etc.)
  if (assigneeZuid) {
    var myBugsCacheKey = ['mybugs', assigneeZuid];
    var cachedMyBugs = _getCached(userId, myBugsCacheKey);

    if (cachedMyBugs) {
      var filtered = _applyPostFilters(cachedMyBugs, statusFilter, milestoneFilter, '');
      var total = filtered.length;
      var paged = filtered.slice(index, index + range);
      return callback(null, {
        bugs: paged,
        totalCount: total,
        index: index,
        range: range,
        fromCache: true
      });
    }

    // Cache miss — fetch from /mybugs/ endpoint
    var userObj = userStore.getUser(userId);
    var portal = userObj.zohoPortal || 'logmanagementcloud';
    var projectId = userObj.zohoProjectId || '';

    _fetchMyBugs(userId, portal, projectId, function (err, allBugs) {
      if (err) return callback(err);
      _setCache(userId, myBugsCacheKey, allBugs);

      var filtered = _applyPostFilters(allBugs, statusFilter, milestoneFilter, '');
      var total = filtered.length;
      var paged = filtered.slice(index, index + range);
      callback(null, {
        bugs: paged,
        totalCount: total,
        index: index,
        range: range,
        fromCache: false
      });
    });
    return;
  }

  // ── Non-ZUID path: project-level bugs API ──
  // Post-filtering needed for status, milestone, or name-based assignee
  var needsPostFilter = milestoneFilter || statusFilter || assigneeFilter;

  if (!needsPostFilter) {
    // Direct API path: single call with pagination
    var simpleParts = apiParts.slice();
    simpleParts.push('index=' + index);
    simpleParts.push('range=' + range);
    var path = 'bugs/?' + simpleParts.join('&');

    zohoClient.zohoGet(userId, path, function (err, data) {
      if (err) return callback(err);
      var bugs = _mapBugs(data.bugs || []);
      callback(null, {
        bugs: bugs,
        totalCount: bugs.length,
        index: index,
        range: range
      });
    });
    return;
  }

  // Post-filter path: check cache first
  var cacheApiParts = apiParts.slice();
  var cached = _getCached(userId, cacheApiParts);
  if (cached) {
    var filtered = _applyPostFilters(cached, statusFilter, milestoneFilter, assigneeFilter);
    var total = filtered.length;
    var paged = filtered.slice(index, index + range);
    return callback(null, {
      bugs: paged,
      totalCount: total,
      index: index,
      range: range,
      fromCache: true
    });
  }

  // Cache miss: parallel page fetch
  _fetchAllBugs(userId, apiParts, function (err, allBugs) {
    if (err) return callback(err);
    _setCache(userId, cacheApiParts, allBugs);

    var filtered = _applyPostFilters(allBugs, statusFilter, milestoneFilter, assigneeFilter);
    var total = filtered.length;
    var paged = filtered.slice(index, index + range);
    callback(null, {
      bugs: paged,
      totalCount: total,
      index: index,
      range: range,
      fromCache: false
    });
  });
}

/**
 * Auto-detect ZUID for a user by fetching one bug and checking assignee_id.
 * callback(err, { zuid, name })
 */
function detectZuid(userId, assigneeName, callback) {
  if (!assigneeName) return callback(null, null);
  // Fetch first page of bugs and look for one matching this assignee name
  zohoClient.zohoGet(userId, 'bugs/?index=0&range=200', function (err, data) {
    if (err) return callback(err);
    var bugs = (data && data.bugs) || [];
    var name = assigneeName.toLowerCase();
    for (var i = 0; i < bugs.length; i++) {
      var b = bugs[i];
      if (b.assignee_name && b.assignee_name.toLowerCase().indexOf(name) !== -1 && b.assignee_id) {
        return callback(null, {
          zuid: String(b.assignee_id),
          name: b.assignee_name
        });
      }
    }
    callback(null, null); // not found
  });
}

/**
 * Apply post-filters (status, milestone, assignee) to a bug list.
 */
function _applyPostFilters(bugs, statusFilter, milestoneFilter, assigneeFilter) {
  var result = bugs;

  if (statusFilter) {
    var sf = statusFilter.toLowerCase();
    result = result.filter(function (bug) {
      return bug.status && bug.status.toLowerCase() === sf;
    });
  }

  if (milestoneFilter) {
    result = result.filter(function (bug) {
      return bug.milestoneId === milestoneFilter;
    });
  }

  if (assigneeFilter) {
    var af = assigneeFilter.toLowerCase();
    result = result.filter(function (bug) {
      return bug.assignee && bug.assignee.toLowerCase().indexOf(af) !== -1;
    });
  }

  return result;
}

/**
 * Fetch ALL user's own bugs via /mybugs/ endpoint.
 * Returns complete bug list including all statuses (Open, Closed, Fixed, etc.).
 * Filters by project_id_string to match the user's configured project.
 * callback(err, allBugs[])
 */
function _fetchMyBugs(userId, portal, projectId, callback) {
  var allBugs = [];
  var CHUNK = 200;
  var MAX_PAGES = 10; // safety: max 2000 bugs

  function fetchPage(idx, pageNum) {
    var myBugsUrl = 'https://projectsapi.zoho.in/restapi/portal/' + portal +
      '/mybugs/?index=' + idx + '&range=' + CHUNK;

    zohoClient.zohoGet(userId, myBugsUrl, function (err, data) {
      if (err) {
        var errMsg = (err.message || '');
        if (errMsg.indexOf('THROTTLE') !== -1 || errMsg.indexOf('throttle') !== -1) {
          return callback(new Error('Zoho API rate limit reached. Please wait and try again.'));
        }
        return callback(err);
      }

      var rawBugs = (data && data.bugs) || [];
      var rawCount = rawBugs.length;

      // Filter by project
      var projectBugs = rawBugs;
      if (projectId) {
        projectBugs = rawBugs.filter(function (b) {
          return b.project_id_string === projectId;
        });
      }

      var mapped = _mapBugs(projectBugs, portal);
      for (var i = 0; i < mapped.length; i++) allBugs.push(mapped[i]);

      if (rawCount < CHUNK || pageNum >= MAX_PAGES) {
        callback(null, allBugs);
      } else {
        fetchPage(idx + CHUNK, pageNum + 1);
      }
    });
  }

  fetchPage(0, 1);
}

/**
 * Fetch ALL bugs (up to 3000) via parallel page scanning.
 * Returns the full mapped bug list (no post-filtering).
 * callback(err, allBugs[])
 */
function _fetchAllBugs(userId, apiParts, callback) {
  var CHUNK = 200;
  var PARALLEL_PAGES = 5;   // 5 pages at once = 1000 bugs per batch
  var MAX_BATCHES = 3;      // up to 3 batches = 3000 bugs max, 15 API calls
  var allBugs = [];
  var batchStart = 0;
  var batchNum = 0;
  var reachedEnd = false;

  function fetchBatch() {
    var pending = PARALLEL_PAGES;
    var batchBugs = new Array(PARALLEL_PAGES);
    var batchRawCounts = new Array(PARALLEL_PAGES);
    var batchError = null;

    for (var p = 0; p < PARALLEL_PAGES; p++) {
      (function (pageIdx, slot) {
        var chunkParts = apiParts.slice();
        chunkParts.push('index=' + pageIdx);
        chunkParts.push('range=' + CHUNK);
        var apiPath = 'bugs/?' + chunkParts.join('&');

        zohoClient.zohoGet(userId, apiPath, function (err, data) {
          if (err && !batchError) batchError = err;

          var rawBugs = (data && data.bugs) || [];
          batchRawCounts[slot] = rawBugs.length;
          batchBugs[slot] = _mapBugs(rawBugs);

          pending--;
          if (pending === 0) onBatchDone();
        });
      })(batchStart + p * CHUNK, p);
    }

    function onBatchDone() {
      if (batchError) {
        // Detect Zoho rate-limit error and return friendly message
        var errMsg = (batchError.message || '') + (batchError.msg || '');
        if (errMsg.indexOf('THROTTLE') !== -1 || errMsg.indexOf('throttle') !== -1) {
          return callback(new Error('Zoho API rate limit reached (100 req / 2 min). Please wait a moment and try again.'));
        }
        return callback(batchError);
      }

      for (var s = 0; s < PARALLEL_PAGES; s++) {
        for (var i = 0; i < batchBugs[s].length; i++) {
          allBugs.push(batchBugs[s][i]);
        }
        if (batchRawCounts[s] < CHUNK) {
          reachedEnd = true;
        }
      }

      batchNum++;
      batchStart += PARALLEL_PAGES * CHUNK;

      if (reachedEnd || batchNum >= MAX_BATCHES) {
        callback(null, allBugs);
      } else {
        fetchBatch();
      }
    }
  }

  fetchBatch();
}

/**
 * Map raw Zoho bug objects to our normalized format.
 */
function _mapBugs(rawBugs, portal) {
  return rawBugs.map(function (b) {
    // Web link: project-level bugs have link.web.url; mybugs don't — construct it
    var webLink = '';
    if (b.link && b.link.web && b.link.web.url) {
      webLink = b.link.web.url;
    } else if (portal && b.project_id_string) {
      webLink = 'https://projects.zoho.in/portal/' + portal +
        '#zp/projects/' + b.project_id_string +
        '/issue-detail/' + (b.id_string || b.id);
    }
    return {
      id: b.id_string || String(b.id || ''),
      title: b.title || '',
      status: (b.status && b.status.type) || '',
      severity: (b.severity && b.severity.type) || '',
      classification: (b.classification && b.classification.type) || '',
      module: (b.module && b.module.name) || '',
      assignee: b.assignee_name || '',
      reporter: b.reported_person || '',
      milestoneId: (b.milestone && (b.milestone.id_string || String(b.milestone.id || ''))) || '',
      milestone: (b.milestone && b.milestone.name) || '',
      reproducible: (b.reproducible && b.reproducible.type) || '',
      createdTime: b.created_time || '',
      lastModified: b.last_modified_time || '',
      flag: b.flag || '',
      link: webLink
    };
  });
}

/**
 * Fetch full bug details + attachments + first 3 comments.
 * callback(err, { bug, attachments, comments, text })
 */
function getBugDetails(userId, bugId, callback) {
  console.log('[bug-service] Fetching bug', bugId, 'from Zoho...');
  zohoClient.zohoGet(userId, 'bugs/' + bugId + '/', function (err, bugRes) {
    if (err) { console.error('[bug-service] ❌ Zoho API error:', err.message); return callback(err); }

    var bugs = bugRes.bugs || [];
    var bug = bugs[0];
    if (!bug) return callback(new Error('Bug not found: ' + bugId));
    console.log('[bug-service] ✅ Bug fetched:', (bug.title || '').substring(0, 60));
    console.log('[bug-service] Fetching attachments...');

    var details = {
      id: bug.id_string || String(bug.id || bugId),
      title: bug.title || '',
      description: bug.description || 'No description',
      status: (bug.status && bug.status.type) || '',
      severity: (bug.severity && bug.severity.type) || '',
      classification: (bug.classification && bug.classification.type) || '',
      module: (bug.module && bug.module.name) || '',
      assignee: bug.assignee_name || '',
      reporter: bug.reported_person || '',
      milestone: (bug.milestone && bug.milestone.name) || '',
      reproducible: (bug.reproducible && bug.reproducible.type) || '',
      createdTime: bug.created_time || '',
      lastModified: bug.last_modified_time || '',
      link: bug.link && bug.link.web && bug.link.web.url || ''
    };

    // Fetch attachments
    zohoClient.zohoGet(userId, 'bugs/' + bugId + '/attachments/', function (attErr, attRes) {
      var attachments = [];
      if (!attErr && attRes && attRes.attachment_details) {
        attachments = attRes.attachment_details.map(function (a) {
          return {
            name: a.file_name || '',
            size: a.file_size || 0,
            type: a.file_type || '',
            uri: a.file_uri || ''
          };
        });
      }

      // Fetch comments
      console.log('[bug-service] Attachments:', attachments.length, '| Fetching comments...');
      zohoClient.zohoGet(userId, 'bugs/' + bugId + '/comments/?index=0&range=5', function (cmtErr, cmtRes) {
        var comments = [];
        if (!cmtErr && cmtRes) {
          var list = cmtRes.comments || cmtRes.comment_details || [];
          comments = list.slice(0, 5).map(function (c) {
            return {
              content: c.content || c.description || '',
              author: (c.created_by && typeof c.created_by === 'object') ? c.created_by.name : (c.created_by || ''),
              time: c.created_time || ''
            };
          });
        }

        // Build text summary
        console.log('[bug-service] Comments:', comments.length, '| Building text summary...');
        var lines = [
          '**Title:** ' + details.title,
          '**Status:** ' + details.status,
          '**Severity:** ' + details.severity,
          '**Type:** ' + details.classification,
          '**Module:** ' + details.module,
          '**Assignee:** ' + details.assignee,
          '**Reporter:** ' + details.reporter,
          '**Milestone:** ' + details.milestone,
          '**Created:** ' + details.createdTime,
          '',
          '### Description',
          details.description
        ];

        if (attachments.length > 0) {
          lines.push('', '### Attachments');
          attachments.forEach(function (a) {
            lines.push('- ' + a.name + ' (' + a.size + ' bytes, ' + a.type + ')');
          });
        }

        if (comments.length > 0) {
          lines.push('', '### Comments');
          comments.forEach(function (c, i) {
            lines.push('**Comment ' + (i + 1) + '** by ' + c.author + ' (' + c.time + '):');
            lines.push(c.content);
            lines.push('');
          });
        }

        callback(null, {
          bug: details,
          attachments: attachments,
          comments: comments,
          text: lines.join('\n')
        });
      });
    });
  });
}

/**
 * Fetch milestones for the user's project (for filter dropdowns).
 */
function listMilestones(userId, callback) {
  // Use relative path — zohoClient.apiBase() already includes portal/project
  zohoClient.zohoGet(userId, 'milestones/?index=0&range=200&status=all', function (err, data) {
    if (err) return callback(err);
    var milestones = (data.milestones || []).map(function (m) {
      return {
        id: m.id_string || String(m.id || ''),
        name: m.name || '',
        status: m.status || '',
        owner: m.owner_name || ''
      };
    });
    // Sort: active (notcompleted) first, then by name
    milestones.sort(function (a, b) {
      if (a.status === 'notcompleted' && b.status !== 'notcompleted') return -1;
      if (a.status !== 'notcompleted' && b.status === 'notcompleted') return 1;
      return a.name.localeCompare(b.name);
    });
    callback(null, milestones);
  });
}

module.exports = {
  listBugs: listBugs,
  listMyBugs: listMyBugs,
  getBugDetails: getBugDetails,
  listMilestones: listMilestones,
  detectZuid: detectZuid
};
