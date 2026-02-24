/* ═══════════════════════════════════════════════════════
   Bug Tracker — Client-Side Application
   Zoho Projects–inspired UI. Vanilla JS, zero deps.
   Features: searchable milestone filter, inline analysis
   play button, diff code viewer modal.
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── DOM helpers ────────────────────────────────────────

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return document.querySelectorAll(s); };

  // ── DOM references ─────────────────────────────────────

  var loginScreen   = $('#login-screen');
  var appScreen     = $('#app-screen');
  var loginError    = $('#login-error');
  var userNameEl    = $('#user-name');
  var userAvatar    = $('#user-avatar');
  var headerProject = $('#header-project');
  var logoutBtn     = $('#logout-btn');

  // Header nav tabs
  var navItems    = $$('.zp-header-tab');
  var tabContents = $$('.tab-content');

  // Quick filters
  var qfChips = $$('.qf-chip');

  // Advanced filters
  var toggleFiltersBtn = $('#toggle-filters-btn');
  var filtersBody      = $('#filters-body');
  var filterSeverity   = $('#filter-severity');
  var filterMilestone  = $('#filter-milestone');      // hidden input
  var milestoneSearch  = $('#milestone-search');       // visible text input
  var milestoneClear   = $('#milestone-clear');
  var milestoneList    = $('#milestone-list');
  var filterAssignee   = $('#filter-assignee');
  var applyFiltersBtn  = $('#apply-filters-btn');
  var clearFiltersBtn  = $('#clear-filters-btn');

  // Bug table
  var bugListEl   = $('#bug-list');
  var bugCountEl  = $('#bug-count');
  var prevPageBtn = $('#prev-page');
  var nextPageBtn = $('#next-page');
  var pageInfoEl  = $('#page-info');
  var pageNumEl   = $('#page-num');

  // Code search
  var codeSearchInput = $('#code-search-input');
  var searchTypeEl    = $('#search-type');
  var codeSearchBtn   = $('#code-search-btn');
  var searchResultsEl = $('#search-results');

  // Settings
  var settingProjectDir = $('#setting-projectDir');
  var settingAgentUrl   = $('#setting-agentUrl');
  var settingPortal     = $('#setting-zohoPortal');
  var settingProjectId  = $('#setting-zohoProjectId');
  var settingDefaultAssignee = $('#setting-defaultAssignee');
  var settingExts       = $('#setting-fileExtensions');
  var settingExclude    = $('#setting-excludeDirs');
  var settingGithubToken  = $('#setting-githubToken');
  var settingClaudeKey    = $('#setting-claudeApiKey');
  var settingAiModel      = $('#setting-aiModel');
  var settingDevServerUrl  = $('#setting-devServerUrl');
  var settingTestUsername   = $('#setting-testUsername');
  var settingTestPassword   = $('#setting-testPassword');
  var claudeKeyGroup      = $('#claude-key-group');
  var githubTokenGroup    = $('#github-token-group');
  var discoverModelsBtn   = $('#discover-models-btn');
  var modelDiscoverStatus = $('#model-discover-status');
  var bridgeStatusDot     = $('#bridge-status-dot');
  var bridgeInfoEl        = $('#bridge-info');
  var checkBridgeBtn      = $('#check-bridge-btn');
  var saveSettingsBtn     = $('#save-settings-btn');
  var settingsStatus    = $('#settings-status');
  var projectStatsEl    = $('#project-stats');
  var statsContentEl    = $('#stats-content');
  var checkAgentBtn     = $('#check-agent-btn');
  var agentStatusDot    = $('#agent-status');
  var agentInfoEl       = $('#agent-info');
  var modeAgentRadio    = $('#mode-agent');
  var modeLocalRadio    = $('#mode-local');
  var agentSettingsEl   = $('#agent-settings');
  var localSettingsEl   = $('#local-settings');

  // Bug detail split-view panel
  var splitView       = $('#split-view');
  var splitLeft       = $('#split-left');
  var splitRight      = $('#split-right');
  var tableView       = $('#table-view');
  var bugNameListEl   = $('#bug-name-list');
  var detailCloseBtn  = $('#detail-close-btn');
  var modalTitle        = $('#modal-title');
  var modalDetails      = $('#modal-details');
  var analyzeBtn        = $('#analyze-btn');
  var analysisSection   = $('#analysis-section');
  var analysisPrompt    = $('#analysis-prompt');
  var copyPromptBtn     = $('#copy-prompt-btn');
  var analysisFilesEl   = $('#analysis-files');
  var relevantFilesList = $('#relevant-files-list');
  var drawerFileTabs    = $('#drawer-file-tabs');
  var drawerCodeView    = $('#drawer-code-view');
  var analysisAccordions = $('#analysis-accordions');
  var fileViewerSection = $('#file-viewer-section');

  // Analysis action buttons
  var editToggleBtn       = $('#edit-toggle-btn');
  var applyChangesBtn     = $('#apply-changes-btn');
  var analysisEditArea    = $('#analysis-edit-area');
  var analysisEditTextarea = $('#analysis-edit-textarea');
  var analysisActionResult = $('#analysis-action-result');
  var currentDrawerFile    = null;
  var isEditMode           = false;

  // Diff section after apply
  var analysisDiffSection  = $('#analysis-diff-section');
  var analysisDiffView     = $('#analysis-diff-view');
  var diffEditBtn          = $('#diff-edit-btn');
  var diffCommitBtn        = $('#diff-commit-btn');
  var diffCommitError      = $('#diff-commit-error');

  // File viewer modal
  var fileModal      = $('#file-modal');
  var fileModalTitle = $('#file-modal-title');
  var fileContent    = $('#file-content');

  // Diff / Analysis modal
  var diffModal      = $('#diff-modal');
  var diffTitle      = $('#diff-title');
  var diffFileList   = $('#diff-file-list');
  var diffFileHeader = $('#diff-file-header');
  var diffCode       = $('#diff-code');
  var diffCopyBtn    = $('#diff-copy-btn');

  // ── State ──────────────────────────────────────────────

  var currentUser       = null;
  var currentBugId      = null;
  var pageIndex         = 0;
  var PAGE_SIZE         = 25;
  var activeStatus      = '';
  var filtersOpen       = false;

  // Milestone dropdown
  var allMilestones = [];

  // Diff modal
  var currentDiffPrompt = '';
  var currentAnalysis   = null;
  var diffFileCache     = {};
  var codeFileCache     = {};
  var editedFiles       = [];  // files edited/applied during this bug session

  // Per-bug extra description cache
  var extraDescCache    = {};

  // Bugs list for split view
  var currentBugs       = [];

  // ── API helper ─────────────────────────────────────────

  function api(method, path, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    if (body && method !== 'GET') {
      xhr.setRequestHeader('Content-Type', 'application/json');
    }
    // Long operations (analyze) can take 2+ minutes
    xhr.timeout = 300000; // 5 minutes
    var called = false;
    function done(status, data) {
      if (called) return;
      called = true;
      callback(status, data);
    }
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var data;
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
      if (xhr.status === 401) { showLogin(); return; }
      if (xhr.status === 0 && !data) {
        // Network error or request aborted
        done(0, { error: 'Network error — server may be unreachable or request was aborted.' });
        return;
      }
      done(xhr.status, data);
    };
    xhr.ontimeout = function () {
      done(0, { error: 'Request timed out after 5 minutes. The server may still be processing.' });
    };
    xhr.onerror = function () {
      done(0, { error: 'Network error — could not reach the server.' });
    };
    xhr.send(body ? JSON.stringify(body) : null);
  }
  function apiGet(p, cb)    { api('GET', p, null, cb); }
  function apiPost(p, b, cb) { api('POST', p, b, cb); }

  // ── Init ───────────────────────────────────────────────

  function init() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('error')) {
      loginError.textContent = 'Login error: ' + params.get('error');
      loginError.style.display = 'block';
      window.history.replaceState({}, '', '/');
    }

    apiGet('/api/me', function (status, data) {
      if (status === 200 && data && data.userId) {
        currentUser = data;
        showApp();
      } else {
        showLogin();
      }
    });

    bindEvents();
  }

  function showLogin() {
    loginScreen.style.display = 'block';
    appScreen.style.display = 'none';
  }

  function showApp() {
    loginScreen.style.display = 'none';
    appScreen.style.display = 'block';

    var displayName = currentUser.name || currentUser.email || currentUser.userId;
    userNameEl.textContent = displayName;
    userAvatar.textContent = displayName.charAt(0).toUpperCase();
    headerProject.textContent = currentUser.zohoPortal || 'Zoho Projects';

    if (!currentUser.configured) {
      switchTab('settings');
    } else {
      // Load milestones first — auto-selects SOAR, then loads bugs
      loadMilestones(true);
    }

    populateSettings();
  }

  // ── Tabs ───────────────────────────────────────────────

  function switchTab(tabName) {
    navItems.forEach(function (item) {
      item.classList.toggle('active', item.getAttribute('data-tab') === tabName);
    });
    tabContents.forEach(function (el) {
      el.classList.toggle('active', el.id === 'tab-' + tabName);
    });
  }

  // ── Events ─────────────────────────────────────────────

  function bindEvents() {
    // Header nav tabs
    navItems.forEach(function (item) {
      item.addEventListener('click', function () {
        switchTab(item.getAttribute('data-tab'));
      });
    });

    // Logout
    logoutBtn.addEventListener('click', function () {
      apiPost('/auth/logout', {}, function () { currentUser = null; showLogin(); });
    });

    // Quick filter chips
    qfChips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        activeStatus = chip.getAttribute('data-qf');
        qfChips.forEach(function (c) { c.classList.toggle('active', c === chip); });
        pageIndex = 0;
        loadBugs();
      });
    });

    // Toggle advanced filters
    toggleFiltersBtn.addEventListener('click', function () {
      filtersOpen = !filtersOpen;
      filtersBody.style.display = filtersOpen ? 'block' : 'none';
      toggleFiltersBtn.parentElement.classList.toggle('filters-body-open', filtersOpen);
    });

    // Apply / Clear filters
    applyFiltersBtn.addEventListener('click', function () { pageIndex = 0; loadBugs(); });
    clearFiltersBtn.addEventListener('click', function () {
      filterSeverity.value = '';
      clearMilestoneSelection();
      filterAssignee.value = '';
      pageIndex = 0;
      loadBugs();
    });

    // Pagination
    prevPageBtn.addEventListener('click', function () {
      if (pageIndex > 0) { pageIndex -= PAGE_SIZE; loadBugs(); }
    });
    nextPageBtn.addEventListener('click', function () {
      pageIndex += PAGE_SIZE; loadBugs();
    });

    // ── Milestone searchable dropdown ──
    milestoneSearch.addEventListener('focus', function () {
      renderMilestoneDropdown(milestoneSearch.value);
      milestoneList.style.display = 'block';
    });
    milestoneSearch.addEventListener('input', function () {
      renderMilestoneDropdown(milestoneSearch.value);
      milestoneList.style.display = 'block';
    });
    milestoneSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        milestoneList.style.display = 'none';
        milestoneSearch.blur();
      }
    });
    milestoneClear.addEventListener('click', function () {
      clearMilestoneSelection();
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#milestone-dropdown')) {
        milestoneList.style.display = 'none';
      }
    });

    // Code search
    codeSearchBtn.addEventListener('click', doCodeSearch);
    codeSearchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doCodeSearch();
    });

    // Settings
    saveSettingsBtn.addEventListener('click', saveSettings);
    checkAgentBtn.addEventListener('click', checkAgent);
    modeAgentRadio.addEventListener('change', updateModeUI);
    modeLocalRadio.addEventListener('change', updateModeUI);

    // Diff modal
    diffCopyBtn.addEventListener('click', copyDiffPrompt);

    // Bug detail split-view panel
    analyzeBtn.addEventListener('click', analyzeBug);
    copyPromptBtn.addEventListener('click', copyPrompt);
    detailCloseBtn.addEventListener('click', closeSplitView);

    // Modal close (file viewer, diff modals)
    document.querySelectorAll('.modal-close').forEach(function (btn) {
      btn.addEventListener('click', closeModals);
    });
    document.querySelectorAll('.modal-backdrop').forEach(function (el) {
      el.addEventListener('click', closeModals);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (splitView.classList.contains('active')) {
          closeSplitView();
        } else {
          closeModals();
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  //  BUGS
  // ═══════════════════════════════════════════════════════

  function loadBugs() {
    bugListEl.innerHTML = '<tr><td colspan="7" class="empty-cell"><span class="spinner"></span> Loading bugs…</td></tr>';

    var params = [];
    if (activeStatus) params.push('status=' + encodeURIComponent(activeStatus));
    if (filterSeverity.value)  params.push('severity=' + encodeURIComponent(filterSeverity.value));
    if (filterMilestone.value) params.push('milestone=' + encodeURIComponent(filterMilestone.value));
    if (filterAssignee.value)  params.push('assignee=' + encodeURIComponent(filterAssignee.value));
    params.push('index=' + pageIndex);
    params.push('range=' + PAGE_SIZE);

    apiGet('/api/bugs?' + params.join('&'), function (status, data) {
      if (status !== 200 || !data) {
        var errMsg = data && data.error ? data.error : 'Unknown error';
        if (status === 429) {
          errMsg = '⏳ ' + errMsg + ' Filters will use cached data once available.';
        }
        bugListEl.innerHTML = '<tr><td colspan="7" class="empty-cell">' + esc(errMsg) + '</td></tr>';
        bugCountEl.textContent = '';
        pageInfoEl.textContent = '';
        prevPageBtn.disabled = true;
        nextPageBtn.disabled = true;
        return;
      }

      // Auto-update user identity from /mybugs/ response
      if (data.loginUser && currentUser) {
        // Always trust /mybugs/ for the login user's identity
        if (currentUser.defaultAssignee !== data.loginUser) {
          currentUser.defaultAssignee = data.loginUser;
          // Persist to server
          apiPost('/api/settings', { defaultAssignee: data.loginUser }, function () {});
        }
        if (!currentUser.name || currentUser.name === 'Zoho User') {
          currentUser.name = data.loginUser;
          userNameEl.textContent = data.loginUser;
          userAvatar.textContent = data.loginUser.charAt(0).toUpperCase();
        }
        // Show the detected user in the assignee filter if empty or stale
        if (!filterAssignee.value || filterAssignee.value !== data.loginUser) {
          filterAssignee.value = data.loginUser;
        }
      }

      var bugs = data.bugs || [];

      // Store for split-view name list
      currentBugs = bugs;

      if (bugs.length === 0) {
        bugListEl.innerHTML = '<tr><td colspan="7" class="empty-cell">No bugs found matching the current filters.</td></tr>';
        bugCountEl.textContent = '';
        pageInfoEl.textContent = '';
        prevPageBtn.disabled = true;
        nextPageBtn.disabled = true;
        return;
      }

      bugListEl.innerHTML = '';
      bugs.forEach(function (bug) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-id', bug.id);

        var shortId = bug.id ? '#' + String(bug.id).slice(-6) : '—';
        var stClass = getStatusClass(bug.status);
        var sevClass = getSeverityClass(bug.severity);
        var dateStr = formatDate(bug.createdTime);

        tr.innerHTML =
          '<td class="td-id">' + shortId + '</td>' +
          '<td class="td-title" title="' + esc(bug.title) + '">' + esc(bug.title) + '</td>' +
          '<td><span class="status-badge ' + stClass + '">' + esc(bug.status) + '</span></td>' +
          '<td><span class="sev-badge ' + sevClass + '"><span class="sev-dot"></span>' + esc(bug.severity) + '</span></td>' +
          '<td class="td-milestone" title="' + esc(bug.milestone || '') + '">' + esc(bug.milestone || '—') + '</td>' +
          '<td class="td-assignee" title="' + esc(bug.assignee) + '">' + esc(bug.assignee) + '</td>' +
          '<td class="td-date">' + dateStr + '</td>';

        // Click row → open bug detail in split view
        tr.addEventListener('click', function () {
          openBug(bug.id);
        });
        bugListEl.appendChild(tr);
      });

      // Pagination
      var totalCount = data.totalCount || bugs.length;
      var totalPages = Math.ceil(totalCount / PAGE_SIZE) || 1;
      var currentPage = Math.floor(pageIndex / PAGE_SIZE) + 1;
      prevPageBtn.disabled = pageIndex === 0;
      nextPageBtn.disabled = (pageIndex + bugs.length) >= totalCount;
      pageNumEl.textContent = currentPage + ' / ' + totalPages;
      pageInfoEl.textContent = 'Showing ' + (pageIndex + 1) + '–' + (pageIndex + bugs.length) + ' of ' + totalCount;
      bugCountEl.textContent = totalCount + ' bugs';
    });
  }

  // ═══════════════════════════════════════════════════════
  //  MILESTONE SEARCHABLE DROPDOWN
  // ═══════════════════════════════════════════════════════

  function loadMilestones(autoLoadBugs) {
    apiGet('/api/milestones', function (status, data) {
      if (status !== 200 || !data) {
        // Even if milestones fail, still load bugs
        if (autoLoadBugs) loadBugs();
        return;
      }
      allMilestones = data || [];

      // The server's /api/bugs now automatically uses /mybugs/ endpoint
      // to list bugs assigned to the logged-in user (no filter needed).
      // If a defaultAssignee is set, show it in the filter box for clarity,
      // but the server doesn't need it — it resolves from the OAuth token.
      var hasDefaultAssignee = currentUser && currentUser.defaultAssignee;
      if (hasDefaultAssignee && !filterAssignee.value) {
        filterAssignee.value = currentUser.defaultAssignee;
      }

      // Auto-select the SOAR milestone ONLY when no defaultAssignee is set
      // (i.e., the user hasn't logged in with Zoho yet or has no bugs).
      if (!hasDefaultAssignee) {
        var soar = allMilestones.filter(function (ms) {
          return ms.name.toLowerCase().indexOf('soar') !== -1;
        })[0];
        if (soar && !filterMilestone.value) {
          selectMilestone(soar.id, soar.name);
        }
      }

      if (autoLoadBugs) loadBugs();
    });
  }

  function renderMilestoneDropdown(query) {
    var q = (query || '').toLowerCase().trim();
    var filtered = allMilestones.filter(function (ms) {
      if (!q) return true;
      return ms.name.toLowerCase().indexOf(q) !== -1;
    });

    milestoneList.innerHTML = '';
    if (filtered.length === 0) {
      milestoneList.innerHTML = '<div class="search-select-empty">No milestones found</div>';
      return;
    }

    filtered.forEach(function (ms) {
      var opt = document.createElement('div');
      opt.className = 'search-select-option' + (filterMilestone.value === ms.id ? ' selected' : '');
      var statusLabel = ms.status === 'notcompleted' ? 'Active' : 'Done';
      var statusClass = ms.status === 'notcompleted' ? 'ms-status-active' : 'ms-status-completed';
      opt.innerHTML =
        '<span>' + esc(ms.name) + '</span>' +
        '<span class="ms-status ' + statusClass + '">' + statusLabel + '</span>';
      opt.addEventListener('click', function () {
        selectMilestone(ms.id, ms.name);
      });
      milestoneList.appendChild(opt);
    });
  }

  function selectMilestone(id, name) {
    filterMilestone.value = id;
    milestoneSearch.value = name;
    milestoneClear.style.display = 'block';
    milestoneList.style.display = 'none';
  }

  function clearMilestoneSelection() {
    filterMilestone.value = '';
    milestoneSearch.value = '';
    milestoneClear.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════
  //  BUG DETAIL MODAL
  // ═══════════════════════════════════════════════════════

  function openBug(bugId) {
    // Save extra description for the previous bug
    var extraInput = document.getElementById('extra-desc-input');
    if (currentBugId && extraInput) {
      extraDescCache[currentBugId] = extraInput.value;
    }
    currentBugId = bugId;
    analysisSection.style.display = 'none';
    analysisPrompt.textContent = '';
    drawerFileTabs.innerHTML = '';
    drawerCodeView.innerHTML = '<div class="code-viewer-empty">Click "Analyze & Fix" to scan your project and get fix suggestions.</div>';
    codeFileCache = {};
    currentAnalysis = null;
    currentDiffPrompt = '';
    editedFiles = [];
    appliedDiffFiles = [];
    parsedDiffBlocks = [];
    // Reset diff section
    analysisDiffSection.style.display = 'none';
    diffCommitError.style.display = 'none';
    // Restore extra description for this bug
    if (extraInput) {
      extraInput.value = extraDescCache[bugId] || '';
    }
    modalDetails.innerHTML = '<div class="loading-text"><span class="spinner"></span> Loading bug details…</div>';
    modalTitle.textContent = 'Bug #' + String(bugId).slice(-6);

    // Activate split view
    splitView.classList.add('active');
    splitRight.style.display = 'block';

    // Render bug name list on the left
    renderBugNameList(bugId);

    apiGet('/api/bugs/' + bugId, function (status, data) {
      if (status !== 200 || !data) {
        modalDetails.innerHTML = '<div class="empty-state">Failed to load bug details.</div>';
        return;
      }

      var bug = data.bug || {};
      var html = '';

      // Properties grid
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Properties</div>';
      html += '<div class="detail-props">';

      var props = [
        ['Status', bug.status ? '<span class="status-badge ' + getStatusClass(bug.status) + '">' + esc(bug.status) + '</span>' : '—'],
        ['Severity', bug.severity ? '<span class="sev-badge ' + getSeverityClass(bug.severity) + '"><span class="sev-dot"></span>' + esc(bug.severity) + '</span>' : '—'],
        ['Milestone', esc(bug.milestone || '—')],
        ['Assignee', esc(bug.assignee || '—')],
        ['Reproducible', esc(bug.reproducible || '—')],
        ['Created', esc(bug.createdTime || '—')],
        ['Modified', esc(bug.lastModified || '—')]
      ];

      props.forEach(function (p) {
        html += '<div class="detail-prop"><span class="detail-prop-label">' + p[0] + '</span><span class="detail-prop-value">' + p[1] + '</span></div>';
      });
      html += '</div></div>';

      // Title
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Title</div>';
      html += '<div style="font-size:15px;font-weight:600;padding:0 12px;">' + esc(bug.title) + '</div>';
      html += '</div>';

      // Description
      html += '<div class="detail-section">';
      html += '<div class="detail-section-title">Description</div>';
      html += '<div class="detail-desc">' + (bug.description || '<em>No description</em>') + '</div>';
      html += '</div>';

      // Comments
      if (data.comments && data.comments.length > 0) {
        html += '<div class="detail-comments"><h3>Comments (' + data.comments.length + ')</h3>';
        data.comments.forEach(function (c) {
          html += '<div class="comment-item"><div class="comment-meta">' + esc(c.author) + ' · ' + esc(c.time) + '</div><div class="comment-body">' + (c.content || '') + '</div></div>';
        });
        html += '</div>';
      }

      // Attachments
      if (data.attachments && data.attachments.length > 0) {
        html += '<div class="detail-attachments"><h3>Attachments (' + data.attachments.length + ')</h3><ul class="attachment-list">';
        data.attachments.forEach(function (a) {
          html += '<li><a href="' + (a.uri || '#') + '" target="_blank">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
            esc(a.name) + '</a> <small style="color:var(--text-muted)">(' + formatBytes(a.size) + ')</small></li>';
        });
        html += '</ul></div>';
      }

      modalDetails.innerHTML = html;
    });
  }

  // ═══════════════════════════════════════════════════════
  //  GIT COMMIT
  // ═══════════════════════════════════════════════════════

  var gitSection     = $('#git-section');
  var gitStatusBtn   = $('#git-status-btn');
  var gitFilesList   = $('#git-files-list');
  var gitBranchBadge = $('#git-branch-badge');
  var commitMsgInput = $('#commit-msg-input');
  var commitBtn      = $('#commit-btn');
  var gitResult      = $('#git-result');
  var gitSelectAll   = $('#git-select-all');

  gitStatusBtn.addEventListener('click', loadGitStatus);
  commitBtn.addEventListener('click', doCommit);
  gitSelectAll.addEventListener('change', function () {
    var checked = gitSelectAll.checked;
    gitFilesList.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.checked = checked;
    });
  });

  function loadGitStatus() {
    gitStatusBtn.disabled = true;
    gitStatusBtn.innerHTML = '<span class="spinner"></span> Loading\u2026';

    apiGet('/api/git/status', function (status, data) {
      gitStatusBtn.disabled = false;
      gitStatusBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 3v6m0 6v6"/></svg> Show Git Changes';

      if (status !== 200 || !data) {
        alert('Failed to get git status: ' + (data ? data.error : 'unknown'));
        return;
      }

      gitBranchBadge.textContent = '\u2387 ' + (data.branch || 'unknown');
      gitResult.style.display = 'none';

      if (!data.files || data.files.length === 0) {
        gitFilesList.innerHTML = '<div class="git-no-changes">No changes detected</div>';
        gitSection.style.display = 'block';
        return;
      }

      var html = '';
      data.files.forEach(function (f) {
        html += '<label class="git-file-item">' +
          '<input type="checkbox" checked data-file="' + esc(f.file) + '" />' +
          '<span class="git-file-status ' + esc(f.label) + '">' + esc(f.status) + '</span>' +
          '<span>' + esc(f.file) + '</span>' +
        '</label>';
      });
      gitFilesList.innerHTML = html;
      gitSelectAll.checked = true;
      gitSection.style.display = 'block';
    });
  }

  function doCommit() {
    var message = commitMsgInput.value.trim();
    if (!message) {
      commitMsgInput.focus();
      commitMsgInput.style.borderColor = '#ef5350';
      setTimeout(function () { commitMsgInput.style.borderColor = ''; }, 2000);
      return;
    }

    // Gather selected files
    var selectedFiles = [];
    gitFilesList.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
      selectedFiles.push(cb.getAttribute('data-file'));
    });

    if (selectedFiles.length === 0) {
      alert('No files selected to commit.');
      return;
    }

    commitBtn.disabled = true;
    commitBtn.innerHTML = '<span class="spinner"></span> Committing\u2026';

    apiPost('/api/git/commit', { message: message, files: selectedFiles }, function (status, data) {
      commitBtn.disabled = false;
      commitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Commit';

      gitResult.style.display = 'block';

      if (status !== 200 || !data) {
        gitResult.className = 'git-result error';
        gitResult.textContent = 'Commit failed: ' + (data ? data.error : 'unknown error');
        return;
      }

      if (data.success) {
        gitResult.className = 'git-result success';
        gitResult.textContent = '\u2713 ' + (data.message || 'Committed successfully');
        commitMsgInput.value = '';
        // Refresh status after a short delay
        setTimeout(loadGitStatus, 1000);
      } else {
        gitResult.className = 'git-result error';
        gitResult.textContent = data.message || 'Nothing to commit';
      }
    });
  }

  function analyzeBug() {
    if (!currentBugId) return;

    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<span class="spinner"></span> Analyzing with AI\u2026';

    var extraDesc = document.getElementById('extra-desc-input').value.trim();
    extraDescCache[currentBugId] = extraDesc;
    var body = { extraDescription: extraDesc };

    apiPost('/api/bugs/' + currentBugId + '/analyze', body, function (status, data) {
      analyzeBtn.disabled = false;
      analyzeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg> Analyze & Fix';

      if (status !== 200 || !data) {
        var errDetail = '';
        if (data && data.error) {
          errDetail = data.error;
        } else if (data && data.aiError) {
          errDetail = data.aiError;
        } else if (status === 0) {
          errDetail = 'Network error — server may be unreachable.';
        } else {
          errDetail = 'Server returned status ' + status + '. Check server console for details.';
        }
        alert('Analysis failed: ' + errDetail);
        return;
      }

      currentDiffPrompt = data.prompt || '';
      currentAnalysis = data.analysis || null;
      codeFileCache = {};
      // Reset diff section on new analysis
      analysisDiffSection.style.display = 'none';
      diffCommitError.style.display = 'none';

      // Pre-populate cache from analysis fileContents
      if (currentAnalysis && currentAnalysis.fileContents) {
        currentAnalysis.fileContents.forEach(function (fc) {
          codeFileCache[fc.file] = fc.content;
        });
      }

      analysisSection.style.display = 'block';
      analysisPrompt.textContent = data.prompt || 'No prompt generated.';

      // ── Build accordion-based analysis view ──
      buildAnalysisAccordions(data, currentAnalysis);

      // Scroll analysis section into view
      analysisSection.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // ═══════════════════════════════════════════════════════
  //  ACCORDION BUILDER — unified analysis view
  // ═══════════════════════════════════════════════════════

  var CHEVRON_SVG = '<svg class="acc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';

  function makeAccordion(id, icon, title, badge, bodyHTML, opts) {
    opts = opts || {};
    var openClass = opts.open ? ' open' : '';
    var darkClass = opts.dark ? ' acc-dark' : '';
    var badgeHTML = badge ? ' <span class="acc-badge' + (opts.badgeColor ? ' ' + opts.badgeColor : '') + '">' + badge + '</span>' : '';
    return '<div class="acc-group' + darkClass + '" id="acc-' + id + '">' +
      '<button class="acc-header' + openClass + '" data-acc="' + id + '">' +
        CHEVRON_SVG +
        '<span class="acc-title">' + icon + ' ' + title + '</span>' +
        badgeHTML +
      '</button>' +
      '<div class="acc-body' + openClass + '">' +
        bodyHTML +
      '</div>' +
    '</div>';
  }

  // Track files that have been applied (written to disk)
  var appliedDiffFiles = [];
  // Store parsed diffs for editing
  var parsedDiffBlocks = [];

  function buildAnalysisAccordions(data, analysis) {
    var bug = data.bug || {};
    var bugStatus = (bug.status || '').toLowerCase();
    var html = '';
    appliedDiffFiles = [];
    parsedDiffBlocks = [];

    // ── 1. Bug Info accordion (open by default) ──
    var bugBody = '<div class="acc-body-inner">';
    bugBody += '<div class="fix-bug-title">' + esc(bug.title || 'Unknown') + '</div>';
    var meta = [];
    if (bug.severity) meta.push('<span class="fix-tag fix-tag-severity">' + esc(bug.severity) + '</span>');
    if (bug.module) meta.push('<span class="fix-tag fix-tag-module">' + esc(bug.module) + '</span>');
    if (bug.status) meta.push('<span class="fix-tag">' + esc(bug.status) + '</span>');
    if (meta.length) bugBody += '<div class="fix-meta-tags">' + meta.join(' ') + '</div>';
    bugBody += '</div>';
    html += makeAccordion('bug', '\uD83D\uDC1B', 'Bug', bug.severity || '', bugBody, { open: true, badgeColor: 'orange' });

    // ── 1.5 Playwright Reproduction Status ──
    if (data.reproduction) {
      var repro = data.reproduction;
      var reproBody = '<div class="acc-body-inner repro-status-body">';
      if (!repro.attempted) {
        // Playwright not available / generation failed
        reproBody += '<div class="repro-result repro-skipped">';
        reproBody += '<span class="repro-icon">\u23ED\uFE0F</span>';
        reproBody += '<span>Playwright reproduction skipped' + (repro.error ? ': ' + esc(repro.error) : '') + '</span>';
        reproBody += '</div>';
      } else if (repro.reproduced) {
        // Bug was reproduced (test failed = bug exists)
        reproBody += '<div class="repro-result repro-reproduced">';
        reproBody += '<span class="repro-icon">\uD83D\uDD34</span>';
        reproBody += '<span><strong>Bug Reproduced</strong> \u2014 Playwright test confirmed the issue exists</span>';
        reproBody += '</div>';
      } else {
        // Test passed = bug not reproduced
        // Status-aware messaging:
        var isFixed = bugStatus === 'fixed' || bugStatus === 'closed' || bugStatus === 'to be tested';
        if (isFixed) {
          reproBody += '<div class="repro-result repro-fixed">';
          reproBody += '<span class="repro-icon">\u2705</span>';
          reproBody += '<span><strong>Verified Fixed</strong> \u2014 Playwright test passed, the bug appears to be resolved</span>';
          reproBody += '</div>';
        } else {
          reproBody += '<div class="repro-result repro-not-reproduced">';
          reproBody += '<span class="repro-icon">\uD83D\uDFE1</span>';
          reproBody += '<span><strong>Could Not Reproduce</strong> \u2014 Playwright test passed, the bug was not triggered</span>';
          reproBody += '</div>';
        }
      }
      if (repro.duration) {
        reproBody += '<div class="repro-meta">Duration: ' + Math.round(repro.duration / 1000) + 's';
        if (repro.testFile) reproBody += ' \u00B7 Test: ' + esc(repro.testFile);
        reproBody += '</div>';
      }
      if (repro.output) {
        reproBody += '<details class="repro-output-details"><summary>Playwright Output</summary>';
        reproBody += '<pre class="repro-output">' + esc(repro.output) + '</pre>';
        reproBody += '</details>';
      }
      reproBody += '</div>';

      var reproBadge = repro.reproduced ? 'Reproduced' : (repro.attempted ? (bugStatus === 'fixed' || bugStatus === 'closed' || bugStatus === 'to be tested' ? 'Fixed' : 'Not Reproduced') : 'Skipped');
      var reproBadgeColor = repro.reproduced ? 'red' : (repro.attempted ? 'green' : '');
      html += makeAccordion('repro', '\uD83C\uDFAD', 'Reproduction', reproBadge, reproBody, { open: true, badgeColor: reproBadgeColor });
    }

    // ── 2. AI Analysis accordion (open by default) ──
    if (data.aiFix && data.aiFix.text) {
      // Parse the AI text to separate explanation from code diffs
      var parsed = parseAIResponse(data.aiFix.text);

      var aiBody = '<div class="acc-body-inner fix-ai-content">';
      aiBody += renderMarkdown(parsed.explanation);
      if (data.aiFix.usage) {
        var inp = data.aiFix.usage.input_tokens || 0;
        var out = data.aiFix.usage.output_tokens || 0;
        aiBody += '<div class="fix-ai-usage">Tokens: ' + inp + ' in / ' + out + ' out</div>';
      }
      aiBody += '</div>';
      var modelBadge = data.aiFix.model || 'AI';
      html += makeAccordion('ai', '\uD83E\uDDE0', 'AI Analysis', modelBadge, aiBody, { open: true });

      // ── 3. Per-file diff accordions with Edit & Apply buttons ──
      if (parsed.diffs.length > 0) {
        parsedDiffBlocks = parsed.diffs;
        parsed.diffs.forEach(function (diff, idx) {
          var diffBody = '<div class="acc-diff-body" id="acc-diff-view-' + idx + '">' + renderCodeDiff(diff.code, diff.lang) + '</div>';
          // Edit textarea (hidden by default)
          diffBody += '<div class="acc-edit-area" id="acc-edit-area-' + idx + '">';
          diffBody += '<textarea class="acc-edit-textarea" id="acc-edit-textarea-' + idx + '">' + esc(diff.code) + '</textarea>';
          diffBody += '</div>';
          // Action bar: Edit, Apply, status
          diffBody += '<div class="acc-diff-actions">';
          diffBody += '<button class="btn btn-outline" id="acc-edit-btn-' + idx + '" data-idx="' + idx + '">';
          diffBody += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit</button>';
          diffBody += '<button class="btn btn-primary" id="acc-apply-btn-' + idx + '" data-idx="' + idx + '" data-file="' + esc(diff.file) + '">';
          diffBody += '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg> Apply</button>';
          diffBody += '<span class="acc-action-status" id="acc-status-' + idx + '"></span>';
          diffBody += '</div>';

          var shortName = diff.file.split('/').pop() || diff.file;
          html += makeAccordion('diff-' + idx, '\uD83D\uDCC4', shortName, diff.lang || 'diff', diffBody, { dark: true, open: true });
        });
      }
    } else if (data.aiError) {
      var errBody = '<div class="acc-body-inner">';
      errBody += '<div class="fix-error-msg">' + esc(data.aiError) + '</div>';
      errBody += '<p class="fix-hint">Check your API key and selected model in Settings \u2192 AI Analysis.</p>';
      errBody += '</div>';
      html += makeAccordion('ai-error', '\u26A0\uFE0F', 'AI Error', '', errBody, { open: true, badgeColor: 'red' });
    }

    // ── Action bar — Commit + Verify buttons ──
    html += '<div id="analysis-commit-bar" class="analysis-commit-bar">';
    html += '<span class="applied-count" id="applied-count"></span>';
    if (parsedDiffBlocks.length > 0) {
      html += '<button class="btn btn-primary btn-sm" id="open-commit-modal-btn" style="gap:6px;">';
      html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Commit Changes</button>';
    }
    html += '<button class="btn btn-outline btn-sm" id="verify-fix-btn" style="gap:6px;">';
    html += '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Verify Fix</button>';
    html += '</div>';

    // Render all accordions
    analysisAccordions.innerHTML = html;

    // Wire accordion toggle
    analysisAccordions.querySelectorAll('.acc-header').forEach(function (hdr) {
      hdr.addEventListener('click', function () {
        hdr.classList.toggle('open');
        var body = hdr.nextElementSibling;
        if (body) body.classList.toggle('open');
      });
    });

    // Wire Edit / Apply buttons for each diff
    parsedDiffBlocks.forEach(function (diff, idx) {
      var editBtn = document.getElementById('acc-edit-btn-' + idx);
      var applyBtn = document.getElementById('acc-apply-btn-' + idx);
      if (editBtn) editBtn.addEventListener('click', function () { toggleDiffEdit(idx); });
      if (applyBtn) applyBtn.addEventListener('click', function () { applyDiffFile(idx); });
    });

    // Wire commit bar button
    var openCommitBtn = document.getElementById('open-commit-modal-btn');
    if (openCommitBtn) openCommitBtn.addEventListener('click', openCommitModal);

    // Wire verify fix button
    var verifyBtn = document.getElementById('verify-fix-btn');
    if (verifyBtn) verifyBtn.addEventListener('click', verifyFix);

    // Hide the old file viewer section (regex results) — we only show AI diffs now
    fileViewerSection.style.display = 'none';
  }

  // Toggle inline editor for a diff block
  function toggleDiffEdit(idx) {
    var editArea = document.getElementById('acc-edit-area-' + idx);
    var editBtn = document.getElementById('acc-edit-btn-' + idx);
    var diffView = document.getElementById('acc-diff-view-' + idx);
    if (!editArea || !editBtn) return;

    var isOpen = editArea.classList.contains('open');
    if (isOpen) {
      // Close editor — update the diff view with edited content
      editArea.classList.remove('open');
      diffView.style.display = '';
      editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit';
      // Update the diff view with edited code
      var textarea = document.getElementById('acc-edit-textarea-' + idx);
      if (textarea && parsedDiffBlocks[idx]) {
        parsedDiffBlocks[idx].code = textarea.value;
        diffView.innerHTML = renderCodeDiff(textarea.value, parsedDiffBlocks[idx].lang);
      }
    } else {
      // Open editor
      editArea.classList.add('open');
      diffView.style.display = 'none';
      editBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Done Editing';
      var textarea2 = document.getElementById('acc-edit-textarea-' + idx);
      if (textarea2) textarea2.focus();
    }
  }

  // Apply a diff block's code to the file on disk
  function applyDiffFile(idx) {
    var diff = parsedDiffBlocks[idx];
    if (!diff) return;
    var applyBtn = document.getElementById('acc-apply-btn-' + idx);
    var statusEl = document.getElementById('acc-status-' + idx);
    var textarea = document.getElementById('acc-edit-textarea-' + idx);
    var code = textarea ? textarea.value : diff.code;

    // Close edit mode if open
    var editArea = document.getElementById('acc-edit-area-' + idx);
    if (editArea && editArea.classList.contains('open')) {
      toggleDiffEdit(idx);
    }

    applyBtn.disabled = true;
    applyBtn.innerHTML = '<span class="spinner"></span> Applying\u2026';
    statusEl.textContent = '';
    statusEl.className = 'acc-action-status';

    apiPost('/api/write-file', { path: diff.file, content: code }, function (status, data) {
      applyBtn.disabled = false;
      applyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/></svg> Apply';

      if (status === 200 && data && data.success) {
        statusEl.textContent = '\u2713 Applied';
        statusEl.className = 'acc-action-status';
        // Track applied file
        if (appliedDiffFiles.indexOf(diff.file) === -1) {
          appliedDiffFiles.push(diff.file);
        }
        updateCommitBar();
      } else {
        statusEl.textContent = '\u2717 ' + (data ? data.error : 'Failed');
        statusEl.className = 'acc-action-status error';
      }
    });
  }

  // Update the commit bar visibility and count
  function updateCommitBar() {
    var bar = document.getElementById('analysis-commit-bar');
    var countEl = document.getElementById('applied-count');
    if (!bar) return;
    if (appliedDiffFiles.length > 0) {
      countEl.textContent = '\u2713 ' + appliedDiffFiles.length + ' file' + (appliedDiffFiles.length > 1 ? 's' : '') + ' applied';
    } else {
      countEl.textContent = '';
    }
  }

  // ═══════════════════════════════════════════════════════
  //  VERIFY FIX (Playwright re-test)
  // ═══════════════════════════════════════════════════════

  function verifyFix() {
    if (!currentBugId) return;
    var btn = document.getElementById('verify-fix-btn');
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Verifying\u2026';

    apiPost('/api/bugs/' + currentBugId + '/verify', {}, function (status, data) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Verify Fix';

      if (status !== 200 || !data) {
        showVerifyResult(false, data ? data.error : 'Verification failed');
        return;
      }

      showVerifyResult(data.passed, data.passed
        ? 'Playwright test passed \u2014 the bug appears to be fixed!'
        : 'Playwright test failed \u2014 the bug may still be present.',
        data.output, data.duration);
    });
  }

  function showVerifyResult(passed, message, output, duration) {
    // Find or create verify result element
    var bar = document.getElementById('analysis-commit-bar');
    var existing = document.getElementById('verify-result');
    if (existing) existing.remove();

    var div = document.createElement('div');
    div.id = 'verify-result';
    div.className = 'verify-result ' + (passed ? 'verify-pass' : 'verify-fail');
    var html = '<span class="verify-icon">' + (passed ? '\u2705' : '\u274C') + '</span>';
    html += '<span class="verify-msg">' + esc(message) + '</span>';
    if (duration) html += '<span class="verify-duration">' + Math.round(duration / 1000) + 's</span>';
    div.innerHTML = html;

    if (bar && bar.parentNode) {
      bar.parentNode.insertBefore(div, bar.nextSibling);
    }

    if (output) {
      var details = document.createElement('details');
      details.className = 'repro-output-details';
      details.style.marginTop = '8px';
      details.innerHTML = '<summary>Playwright Output</summary><pre class="repro-output">' + esc(output) + '</pre>';
      div.appendChild(details);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  COMMIT MODAL (from analysis)
  // ═══════════════════════════════════════════════════════

  function openCommitModal() {
    var modal = document.getElementById('commit-modal');
    var msgInput = document.getElementById('commit-modal-msg');
    var filesEl = document.getElementById('commit-modal-files');
    var resultEl = document.getElementById('commit-modal-result');
    var selectAllCb = document.getElementById('commit-modal-select-all');
    var submitBtn = document.getElementById('commit-modal-submit');
    var cancelBtn = document.getElementById('commit-modal-cancel');
    var closeBtn = document.getElementById('commit-modal-close');

    if (!modal) return;
    resultEl.style.display = 'none';

    // Pre-fill commit message from bug title
    var bugTitle = '';
    var bugEl = document.getElementById('modal-title');
    if (bugEl) bugTitle = bugEl.textContent || '';
    msgInput.value = 'fix: ' + bugTitle;

    // Build file list from applied files
    var html = '';
    appliedDiffFiles.forEach(function (f) {
      html += '<label class="commit-modal-file-item">';
      html += '<input type="checkbox" checked data-file="' + esc(f) + '" />';
      html += '<span class="commit-modal-file-path">' + esc(f) + '</span>';
      html += '<span class="commit-modal-file-status">modified</span>';
      html += '</label>';
    });
    filesEl.innerHTML = html;
    selectAllCb.checked = true;

    // Wire select-all checkbox
    selectAllCb.onchange = function () {
      filesEl.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.checked = selectAllCb.checked;
      });
    };

    // Show modal
    modal.style.display = 'flex';

    // Close handlers
    function closeModal() { modal.style.display = 'none'; }
    cancelBtn.onclick = closeModal;
    closeBtn.onclick = closeModal;
    modal.querySelector('.modal-backdrop').onclick = closeModal;

    // Submit handler
    submitBtn.onclick = function () {
      var message = msgInput.value.trim();
      if (!message) {
        msgInput.focus();
        msgInput.style.borderColor = '#ef5350';
        setTimeout(function () { msgInput.style.borderColor = ''; }, 2000);
        return;
      }

      var selectedFiles = [];
      filesEl.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) {
        selectedFiles.push(cb.getAttribute('data-file'));
      });

      if (selectedFiles.length === 0) {
        resultEl.style.display = 'block';
        resultEl.className = 'git-result error';
        resultEl.textContent = 'No files selected to commit.';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="spinner"></span> Committing\u2026';
      resultEl.style.display = 'none';

      apiPost('/api/git/commit', { message: message, files: selectedFiles }, function (status, data) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Commit Selected';

        resultEl.style.display = 'block';

        if (status === 200 && data && data.success) {
          resultEl.className = 'git-result success';
          resultEl.textContent = '\u2713 ' + (data.message || 'Committed successfully!');
          // Clear applied files for committed ones
          appliedDiffFiles = appliedDiffFiles.filter(function (f) {
            return selectedFiles.indexOf(f) === -1;
          });
          updateCommitBar();
          // Close modal after short delay
          setTimeout(closeModal, 1500);
        } else {
          resultEl.className = 'git-result error';
          resultEl.textContent = '\u2717 ' + (data ? (data.error || data.message) : 'Commit failed');
        }
      });
    };
  }

  /**
   * Parse the AI response text to separate explanation from file-specific code blocks.
   * ALL code blocks are treated as diffs/changes for this bug — the AI was asked
   * specifically about this bug, so every code block is a suggested change.
   * Returns { explanation: string, diffs: [{ file, lang, code }] }
   */
  function parseAIResponse(text) {
    if (!text) return { explanation: '', diffs: [] };

    var diffs = [];
    var explanationParts = [];
    var lines = text.split('\n');
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // Detect fenced code block opening: ```lang or ```
      var codeMatch = line.match(/^```(\w*)\s*$/);
      if (codeMatch) {
        var lang = codeMatch[1] || '';
        var codeLines = [];
        i++;
        // Collect until closing ```
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing ```

        if (codeLines.length === 0) { continue; }

        var codeBlock = codeLines.join('\n');

        // Determine the file name from surrounding context
        var fileName = '';

        // 1. Look at the lines just above the code block for a file reference
        for (var lookback = explanationParts.length - 1; lookback >= Math.max(0, explanationParts.length - 4); lookback--) {
          var prevLine = explanationParts[lookback] || '';
          if (!prevLine.trim()) continue; // skip blank lines

          // Match patterns: **`path/file.js`**, `path/file.js`:, In file.js, ### file.js, path/file.ext:
          var fileMatch = prevLine.match(/[`*"']([^\s`*"']+\.\w{1,5})[`*"']/i) ||
                          prevLine.match(/(?:^|\s)([^\s:,()]+\.\w{1,5})\s*[:)]\s*$/i) ||
                          prevLine.match(/(?:file|in|modify|update|edit|change|create|open)\s+[`*"']?([^\s`*"':,]+\.\w{1,5})[`*"']?/i) ||
                          prevLine.match(/^#+\s+(?:\d+\.\s+)?[`*"']?([^\s`*"':,]+\.\w{1,5})[`*"']?/i);
          if (fileMatch) {
            fileName = fileMatch[1];
            break;
          }
        }

        // 2. Check first line of code for file hints (// file: path/to/file.js)
        if (!fileName && codeLines.length > 0) {
          var firstLineMatch = codeLines[0].match(/^(?:\/\/|#|\/\*|<!--)\s*(?:file|path)?:?\s*([^\s*>]+\.\w{1,5})/i);
          if (firstLineMatch) fileName = firstLineMatch[1];
        }

        // 3. Infer from language if nothing else
        if (!fileName) {
          var extMap = { js: '.js', javascript: '.js', hbs: '.hbs', handlebars: '.hbs', css: '.css', java: '.java', json: '.json', xml: '.xml', ts: '.ts', typescript: '.ts', html: '.html', diff: '' };
          var ext = extMap[lang.toLowerCase()] || '';
          fileName = ext ? ('change' + (diffs.length + 1) + ext) : ('code block ' + (diffs.length + 1));
        }

        // Every code block from the AI is a suggested change for this bug
        var hasDiffMarkers = /^[+-] /m.test(codeBlock) || /^[+-]\t/m.test(codeBlock) || /^@@/m.test(codeBlock);
        diffs.push({
          file: fileName,
          lang: hasDiffMarkers ? 'diff' : (lang || 'code'),
          code: codeBlock
        });
        continue;
      }

      explanationParts.push(line);
      i++;
    }

    return {
      explanation: explanationParts.join('\n'),
      diffs: diffs
    };
  }

  /**
   * Render a code block as a diff view with proper coloring.
   * Handles: unified diff format (+/- lines), and regular code (shown as addition).
   */
  function renderCodeDiff(code, lang) {
    var lines = code.split('\n');
    var html = '';

    if (lang === 'diff' || /^[+-]{3}\s|^@@\s/.test(code)) {
      // ── Unified diff format ──
      var lineNum = 0;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('@@') === 0) {
          html += '<div class="code-line diff-hunk"><span class="code-line-num"></span><span class="code-line-gutter"></span><span class="code-line-text" style="color:#d29922;background:rgba(210,153,34,0.1);">' + esc(line) + '</span></div>';
          var hm = line.match(/\+([0-9]+)/);
          if (hm) lineNum = parseInt(hm[1], 10) - 1;
          continue;
        }
        if (line.indexOf('---') === 0 || line.indexOf('+++') === 0) {
          html += '<div class="code-line diff-meta"><span class="code-line-num"></span><span class="code-line-gutter"></span><span class="code-line-text" style="color:#8b949e;font-weight:600;">' + esc(line) + '</span></div>';
          continue;
        }
        var cls = '';
        var gutter = ' ';
        if (line.charAt(0) === '+') { lineNum++; cls = ' diff-added'; gutter = '+'; }
        else if (line.charAt(0) === '-') { cls = ' diff-removed'; gutter = '-'; }
        else { lineNum++; }
        html += '<div class="code-line' + cls + '">' +
          '<span class="code-line-num">' + (gutter !== '-' ? lineNum : '') + '</span>' +
          '<span class="code-line-gutter">' + gutter + '</span>' +
          '<span class="code-line-text">' + esc(line.length > 1 ? line.substring(1) : line) + '</span></div>';
      }
    } else {
      // ── Regular code — detect inline add/remove comments and show as diff ──
      // AI often writes code with comments like "// ADD THIS" or "// REMOVE"
      // or shows the full replacement code. Render it all as additions (green).
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        var lineClass = ' diff-added';
        var lineGutter = '+';

        // Detect remove hints in comments
        if (/\/\/\s*(?:remove|delete|REMOVE|DELETE)\b/i.test(ln) ||
            /\/\*\s*(?:remove|delete)\b/i.test(ln)) {
          lineClass = ' diff-removed';
          lineGutter = '-';
        }

        html += '<div class="code-line' + lineClass + '">' +
          '<span class="code-line-num">' + (j + 1) + '</span>' +
          '<span class="code-line-gutter">' + lineGutter + '</span>' +
          '<span class="code-line-text">' + esc(ln) + '</span></div>';
      }
    }

    return html;
  }

  /**
   * Build a human-readable fix explanation from analysis data.
   * Shows: what the bug asks → code found → fix approach.
   */
  function buildFixExplanation(data, analysis) {
    var bug = data.bug || {};
    var html = '';

    // ── Section 1: What the bug asks ──
    html += '<div class="fix-section">';
    html += '<div class="fix-section-title">🐛 Bug</div>';
    html += '<div class="fix-bug-title">' + esc(bug.title || 'Unknown') + '</div>';
    var meta = [];
    if (bug.severity) meta.push('<span class="fix-tag fix-tag-severity">' + esc(bug.severity) + '</span>');
    if (bug.module) meta.push('<span class="fix-tag fix-tag-module">' + esc(bug.module) + '</span>');
    if (bug.status) meta.push('<span class="fix-tag">' + esc(bug.status) + '</span>');
    if (meta.length) html += '<div class="fix-meta-tags">' + meta.join(' ') + '</div>';
    html += '</div>';

    if (!analysis) {
      html += '<div class="fix-section">';
      html += '<div class="fix-section-title">⚠️ Analysis</div>';
      if (data.agentError) {
        html += '<div class="fix-error-msg">Agent Error: ' + esc(data.agentError) + '</div>';
        html += '<p class="fix-hint">Could not connect to the code agent. Check that the agent is running and the URL is correct in Settings.</p>';
      } else {
        html += '<p class="fix-hint">No code analysis available. Configure a project directory or agent URL in Settings.</p>';
      }
      html += '<p class="fix-hint">Use the <strong>Copy AI Prompt</strong> button to get a detailed fix from an AI assistant.</p>';
      html += '</div>';
      return html;
    }

    // ── Section 2: What was searched ──
    html += '<div class="fix-section">';
    html += '<div class="fix-section-title">🔍 Search</div>';
    if (analysis.keywords && analysis.keywords.length > 0) {
      html += '<div class="fix-keywords">';
      analysis.keywords.forEach(function (kw) {
        html += '<span class="fix-kw-chip">' + esc(kw) + '</span>';
      });
      html += '</div>';
    }
    var fileCount = (analysis.relevantFiles || []).length;
    var matchCount = (analysis.codeMatches || []).length;
    html += '<div class="fix-stats">';
    html += '<span>' + fileCount + ' file' + (fileCount !== 1 ? 's' : '') + ' found</span>';
    html += '<span class="fix-stats-sep">·</span>';
    html += '<span>' + matchCount + ' code match' + (matchCount !== 1 ? 'es' : '') + '</span>';
    html += '</div>';
    html += '</div>';

    // ── Section 3: AI-powered fix (if available) ──
    if (data.aiFix && data.aiFix.text) {
      html += '<div class="fix-section fix-ai-section">';
      html += '<div class="fix-section-title">🧠 AI Analysis &amp; Fix <span class="fix-ai-badge">' + esc(data.aiFix.model || 'Claude') + '</span></div>';
      html += '<div class="fix-ai-content">' + renderMarkdown(data.aiFix.text) + '</div>';
      if (data.aiFix.usage) {
        var inp = data.aiFix.usage.input_tokens || 0;
        var out = data.aiFix.usage.output_tokens || 0;
        html += '<div class="fix-ai-usage">Tokens: ' + inp + ' in / ' + out + ' out</div>';
      }
      html += '</div>';
    }

    if (matchCount > 0) {
      // ── Section 4: Code matches — the actual evidence ──
      html += '<div class="fix-section">';
      html += '<div class="fix-section-title">📄 Code Found in Project</div>';

      // Group matches by file
      var byFile = {};
      var fileOrder = [];
      (analysis.codeMatches || []).forEach(function (m) {
        if (!byFile[m.file]) { byFile[m.file] = []; fileOrder.push(m.file); }
        byFile[m.file].push(m);
      });

      fileOrder.slice(0, 6).forEach(function (file) {
        var matches = byFile[file];
        var shortName = file.split('/').pop();
        html += '<div class="fix-file-group">';
        html += '<div class="fix-file-name" title="' + esc(file) + '">📁 ' + esc(file) + '</div>';
        html += '<div class="fix-code-matches">';
        matches.slice(0, 5).forEach(function (m) {
          html += '<div class="fix-code-line">';
          html += '<span class="fix-line-num">L' + m.line + '</span>';
          html += '<span class="fix-line-text">' + esc((m.text || '').trim()) + '</span>';
          html += '</div>';
        });
        if (matches.length > 5) {
          html += '<div class="fix-code-more">+ ' + (matches.length - 5) + ' more matches</div>';
        }
        html += '</div></div>';
      });
      if (fileOrder.length > 6) {
        html += '<div class="fix-code-more">+ ' + (fileOrder.length - 6) + ' more files</div>';
      }
      html += '</div>';

      // ── Section 5: Fix approach (only if no AI fix) ──
      if (!data.aiFix || !data.aiFix.text) {
        html += '<div class="fix-section">';
        html += '<div class="fix-section-title">🔧 Fix Approach</div>';
        html += '<div class="fix-approach">';
        html += buildFixApproach(bug, analysis);
        html += '</div>';
        html += '</div>';
      }
    } else {
      // No matches
      html += '<div class="fix-section">';
      html += '<div class="fix-section-title">ℹ️ Result</div>';
      html += '<p class="fix-hint">No matching code was found in the project for the extracted keywords.</p>';
      html += '<p class="fix-hint"><strong>Suggestions:</strong></p>';
      html += '<ul class="fix-hint-list">';
      html += '<li>Add more context in the text box above and re-analyze</li>';
      html += '<li>The code may be in a directory not being scanned</li>';
      html += '<li>Use <strong>Copy AI Prompt</strong> for an AI-assisted fix</li>';
      html += '</ul>';
      html += '</div>';
    }

    return html;
  }

  /**
   * Generate a fix approach description based on the bug title and code matches.
   */
  function buildFixApproach(bug, analysis) {
    var title = (bug.title || '').toLowerCase();
    var lines = [];

    // Detect intent from title keywords
    var isAdd = /\b(add|implement|create|introduce|include|integrate|new|missing)\b/.test(title);
    var isRemove = /\b(remove|delete|drop|deprecate|clean)\b/.test(title);
    var isFix = /\b(fix|bug|broken|error|fail|crash|wrong|incorrect|issue|not\s+work)\b/.test(title);
    var isUpdate = /\b(update|change|modify|replace|refactor|rename|move|migrate)\b/.test(title);

    // Top files
    var topFiles = (analysis.fileScores || []).slice(0, 3);
    var topFileNames = topFiles.map(function (s) { return s.file.split('/').pop(); });

    if (isAdd) {
      lines.push('<p>This bug requires <strong>adding new functionality</strong>.</p>');
      lines.push('<p><strong>Recommended approach:</strong></p>');
      lines.push('<ol>');
      if (topFiles.length > 0) {
        lines.push('<li>The existing code in <code>' + esc(topFileNames[0]) + '</code> shows the current implementation — review the patterns used</li>');
        lines.push('<li>Add the new ' + esc(extractFeatureFromTitle(bug.title)) + ' following the existing code patterns</li>');
      } else {
        lines.push('<li>Identify where the feature should be added based on the module structure</li>');
        lines.push('<li>Implement ' + esc(extractFeatureFromTitle(bug.title)) + '</li>');
      }
      lines.push('<li>Ensure proper event cleanup and error handling</li>');
      lines.push('<li>Test the new functionality end-to-end</li>');
      lines.push('</ol>');
    } else if (isRemove) {
      lines.push('<p>This bug requires <strong>removing or cleaning up code</strong>.</p>');
      lines.push('<p>Review the matched files above and remove the relevant code, ensuring no broken references.</p>');
    } else if (isFix) {
      lines.push('<p>This is a <strong>bug fix</strong> — something isn\'t working correctly.</p>');
      lines.push('<p><strong>Recommended approach:</strong></p>');
      lines.push('<ol>');
      lines.push('<li>Review the code matches above to find the root cause</li>');
      if (topFiles.length > 0) {
        lines.push('<li>The issue is likely in <code>' + esc(topFileNames[0]) + '</code> based on keyword relevance</li>');
      }
      lines.push('<li>Fix the logic error and add guards/validation as needed</li>');
      lines.push('<li>Test the fix against the reproduction steps</li>');
      lines.push('</ol>');
    } else if (isUpdate) {
      lines.push('<p>This bug requires <strong>modifying existing code</strong>.</p>');
      lines.push('<p>Review the matched files, apply the required changes, and ensure backward compatibility.</p>');
    } else {
      lines.push('<p>Review the code matches above to understand the current implementation, then apply the required changes.</p>');
    }

    // Always add the action steps
    lines.push('<div class="fix-next-steps">');
    lines.push('<strong>Next steps:</strong>');
    lines.push('<ol>');
    lines.push('<li>Click on a file tab below to review its full code</li>');
    lines.push('<li>Click <strong>Edit</strong> to modify the file</li>');
    lines.push('<li>Click <strong>Apply Changes</strong> to save → then <strong>Commit</strong></li>');
    lines.push('<li>Or use <strong>Copy AI Prompt</strong> above for a complete AI-generated fix</li>');
    lines.push('</ol>');
    lines.push('</div>');

    return lines.join('\n');
  }

  /**
   * Extract the feature/thing being acted on from a bug title.
   * e.g. "add notification handling for circuit-sdk" → "notification handling for circuit-sdk"
   */
  function extractFeatureFromTitle(title) {
    if (!title) return 'the requested feature';
    var cleaned = title
      .replace(/^\s*(add|implement|create|introduce|include|integrate|fix|update|remove|delete)\s+/i, '')
      .replace(/^(the|a|an)\s+/i, '');
    return cleaned.length > 3 ? cleaned : 'the requested feature';
  }

  function renderDrawerFileTabs(files) {
    drawerFileTabs.innerHTML = '';
    // Build score lookup from analysis
    var scoreMap = {};
    if (currentAnalysis && currentAnalysis.fileScores) {
      currentAnalysis.fileScores.forEach(function (s) { scoreMap[s.file] = s; });
    }
    files.forEach(function (f) {
      var matchCount = getMatchCountForFile(f);
      var scoreInfo = scoreMap[f];
      var kwCount = scoreInfo ? scoreInfo.keywords.length : 0;
      var fileName = f.split('/').pop();
      var tab = document.createElement('button');
      tab.className = 'code-file-tab';
      tab.setAttribute('data-file', f);
      tab.title = f + (scoreInfo ? ' — matched: ' + scoreInfo.keywords.join(', ') : '');
      tab.innerHTML = esc(fileName) +
        (kwCount > 1 ? '<span class="tab-kw-count">' + kwCount + 'kw</span>' : '') +
        (matchCount > 0 ? '<span class="tab-match-count">' + matchCount + '</span>' : '');
      tab.addEventListener('click', function () { selectDrawerFile(f); });
      drawerFileTabs.appendChild(tab);
    });
  }

  function selectDrawerFile(filepath) {
    currentDrawerFile = filepath;
    // Exit edit mode when switching files
    if (isEditMode) toggleEditMode(false);
    // Enable action buttons
    editToggleBtn.disabled = false;
    analysisActionResult.style.display = 'none';

    // Highlight active tab
    drawerFileTabs.querySelectorAll('.code-file-tab').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-file') === filepath);
    });

    // Check cache first
    if (codeFileCache[filepath]) {
      renderDrawerCode(filepath, codeFileCache[filepath]);
      return;
    }

    // Fetch via API
    drawerCodeView.innerHTML = '<div class="code-viewer-empty"><span class="spinner"></span> Loading file…</div>';

    apiGet('/api/read-file?path=' + encodeURIComponent(filepath), function (status, data) {
      if (status !== 200 || !data || !data.content) {
        drawerCodeView.innerHTML = '<div class="code-viewer-empty">Could not load file: ' + esc(data ? data.error : '') + '</div>';
        return;
      }
      codeFileCache[filepath] = data.content;
      renderDrawerCode(filepath, data.content);
    });
  }

  function renderDrawerCode(filepath, content) {
    var lines = content.split('\n');
    var matchedLines = getMatchLinesForFile(filepath);
    var matchLineNums = Object.keys(matchedLines).map(Number).sort(function(a,b){ return a-b; });
    var CONTEXT = 3;

    var html = '<div class="code-viewer-file-header">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>' +
      esc(filepath) +
      '<span class="diff-match-count">' + matchLineNums.length + ' match' + (matchLineNums.length !== 1 ? 'es' : '') + '</span>' +
      '</div>';

    // If no matches, show full file with no highlights
    if (matchLineNums.length === 0) {
      lines.forEach(function (line, i) {
        html += '<div class="code-line">' +
          '<span class="code-line-num">' + (i + 1) + '</span>' +
          '<span class="code-line-gutter"></span>' +
          '<span class="code-line-text">' + esc(line) + '</span></div>';
      });
      drawerCodeView.innerHTML = html;
      return;
    }

    // Build visible line ranges (match lines ± CONTEXT, merged if overlapping)
    var ranges = [];
    matchLineNums.forEach(function (ln) {
      var start = Math.max(1, ln - CONTEXT);
      var end = Math.min(lines.length, ln + CONTEXT);
      if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
        ranges[ranges.length - 1].end = end; // merge overlapping
      } else {
        ranges.push({ start: start, end: end });
      }
    });

    // Render diff chunks
    ranges.forEach(function (range, ri) {
      // Collapsed separator before first chunk or between chunks
      var hiddenBefore = ri === 0 ? range.start - 1 : range.start - ranges[ri - 1].end - 1;
      if (hiddenBefore > 0) {
        html += '<div class="diff-separator">' +
          '<span class="diff-separator-line"></span>' +
          '<span class="diff-separator-text">⋯ ' + hiddenBefore + ' line' + (hiddenBefore !== 1 ? 's' : '') + ' ⋯</span>' +
          '<span class="diff-separator-line"></span></div>';
      }
      for (var ln = range.start; ln <= range.end; ln++) {
        var isMatch = matchedLines[ln];
        html += '<div class="code-line' + (isMatch ? ' match' : ' context') + '">' +
          '<span class="code-line-num">' + ln + '</span>' +
          '<span class="code-line-gutter">' + (isMatch ? '▎' : '') + '</span>' +
          '<span class="code-line-text">' + esc(lines[ln - 1] || '') + '</span></div>';
      }
    });

    // Trailing collapsed separator
    var lastEnd = ranges[ranges.length - 1].end;
    var hiddenAfter = lines.length - lastEnd;
    if (hiddenAfter > 0) {
      html += '<div class="diff-separator">' +
        '<span class="diff-separator-line"></span>' +
        '<span class="diff-separator-text">⋯ ' + hiddenAfter + ' line' + (hiddenAfter !== 1 ? 's' : '') + ' ⋯</span>' +
        '<span class="diff-separator-line"></span></div>';
    }

    drawerCodeView.innerHTML = html;
  }

  function copyPrompt() {
    var text = analysisPrompt.textContent;
    if (!text) return;
    copyToClipboard(text, copyPromptBtn,
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy'
    );
  }

  // ═══════════════════════════════════════════════════════
  //  ANALYSIS EDIT / APPLY / COMMIT
  // ═══════════════════════════════════════════════════════

  editToggleBtn.addEventListener('click', function () { toggleEditMode(!isEditMode); });
  applyChangesBtn.addEventListener('click', applyAnalysisChanges);
  diffEditBtn.addEventListener('click', function () {
    // Go back to edit mode for the current file
    analysisDiffSection.style.display = 'none';
    diffCommitError.style.display = 'none';
    toggleEditMode(true);
  });
  diffCommitBtn.addEventListener('click', commitDiffChanges);

  function toggleEditMode(on) {
    isEditMode = on;
    if (on) {
      // Populate textarea with current file content
      var content = codeFileCache[currentDrawerFile] || '';
      analysisEditTextarea.value = content;
      drawerCodeView.style.display = 'none';
      analysisEditArea.style.display = 'block';
      applyChangesBtn.disabled = false;
      editToggleBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> View';
      // Hide diff section when editing
      analysisDiffSection.style.display = 'none';
      diffCommitError.style.display = 'none';
    } else {
      analysisEditArea.style.display = 'none';
      drawerCodeView.style.display = '';
      applyChangesBtn.disabled = true;
      editToggleBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit';
    }
  }

  function applyAnalysisChanges() {
    if (!currentDrawerFile) return;
    var newContent = analysisEditTextarea.value;

    applyChangesBtn.disabled = true;
    applyChangesBtn.innerHTML = '<span class="spinner"></span> Saving\u2026';

    apiPost('/api/write-file', { path: currentDrawerFile, content: newContent }, function (status, data) {
      applyChangesBtn.disabled = false;
      applyChangesBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Apply Changes';

      if (status === 200 && data && data.success) {
        // Update cache with new content
        codeFileCache[currentDrawerFile] = newContent;
        // Track this file as edited for this bug session
        if (editedFiles.indexOf(currentDrawerFile) === -1) {
          editedFiles.push(currentDrawerFile);
        }
        // Switch back to view mode
        toggleEditMode(false);
        renderDrawerCode(currentDrawerFile, newContent);

        // Now fetch and display the git diff (only for edited files)
        fetchAndShowDiff();
      } else {
        analysisActionResult.style.display = 'block';
        analysisActionResult.className = 'git-result error';
        analysisActionResult.textContent = 'Save failed: ' + (data ? data.error : 'unknown');
        setTimeout(function () { analysisActionResult.style.display = 'none'; }, 4000);
      }
    });
  }

  function fetchAndShowDiff() {
    analysisDiffView.innerHTML = '<div class="code-viewer-empty"><span class="spinner"></span> Loading diff\u2026</div>';
    analysisDiffSection.style.display = 'block';
    diffCommitError.style.display = 'none';

    // Only show diff for files edited in this bug session
    var diffUrl = '/api/git/diff';
    if (editedFiles.length > 0) {
      diffUrl += '?files=' + encodeURIComponent(editedFiles.join(','));
    }

    apiGet(diffUrl, function (status, data) {
      if (status !== 200 || !data) {
        analysisDiffView.innerHTML = '<div class="code-viewer-empty">Failed to load diff.</div>';
        return;
      }

      var diffText = data.diff || '';
      if (!diffText) {
        analysisDiffView.innerHTML = '<div class="code-viewer-empty">No changes detected (diff is empty).</div>';
        return;
      }

      renderUnifiedDiff(diffText);
    });

    // Scroll diff section into view
    setTimeout(function () {
      analysisDiffSection.scrollIntoView({ behavior: 'smooth' });
    }, 200);
  }

  function renderUnifiedDiff(diffText) {
    var lines = diffText.split('\n');
    var html = '';
    var lineNum = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var lineClass = '';
      var gutterChar = ' ';

      if (line.indexOf('diff --git') === 0) {
        // File header
        html += '<div class="diff-line diff-file-hdr">' +
          '<span class="code-line-num"></span>' +
          '<span class="code-line-gutter"></span>' +
          '<span class="code-line-text" style="font-weight:600;color:#58a6ff;">' + esc(line) + '</span></div>';
        continue;
      }
      if (line.indexOf('---') === 0 || line.indexOf('+++') === 0) {
        html += '<div class="diff-line diff-meta">' +
          '<span class="code-line-num"></span>' +
          '<span class="code-line-gutter"></span>' +
          '<span class="code-line-text" style="color:#8b949e;font-weight:600;">' + esc(line) + '</span></div>';
        continue;
      }
      if (line.indexOf('@@') === 0) {
        html += '<div class="diff-line diff-hunk">' +
          '<span class="code-line-num"></span>' +
          '<span class="code-line-gutter"></span>' +
          '<span class="code-line-text" style="color:#d29922;background:rgba(210,153,34,0.1);">' + esc(line) + '</span></div>';
        // Extract line number from @@ -x,y +x,y @@
        var hunkMatch = line.match(/\+([0-9]+)/);
        if (hunkMatch) lineNum = parseInt(hunkMatch[1], 10) - 1;
        continue;
      }
      if (line.indexOf('index ') === 0 || line.indexOf('new file') === 0 || line.indexOf('deleted file') === 0) {
        html += '<div class="diff-line diff-meta">' +
          '<span class="code-line-num"></span>' +
          '<span class="code-line-gutter"></span>' +
          '<span class="code-line-text" style="color:#8b949e;">' + esc(line) + '</span></div>';
        continue;
      }

      if (line.charAt(0) === '+') {
        lineNum++;
        lineClass = ' diff-added';
        gutterChar = '+';
      } else if (line.charAt(0) === '-') {
        lineClass = ' diff-removed';
        gutterChar = '-';
      } else {
        lineNum++;
        lineClass = ' context';
      }

      html += '<div class="code-line' + lineClass + '">' +
        '<span class="code-line-num">' + (gutterChar !== '-' ? lineNum : '') + '</span>' +
        '<span class="code-line-gutter">' + gutterChar + '</span>' +
        '<span class="code-line-text">' + esc(line.substring(1)) + '</span></div>';
    }

    analysisDiffView.innerHTML = html;
  }

  function commitDiffChanges() {
    var message = prompt('Commit message:', 'fix: address bug #' + (currentBugId ? String(currentBugId).slice(-6) : ''));
    if (!message) return;

    diffCommitBtn.disabled = true;
    diffCommitBtn.innerHTML = '<span class="spinner"></span> Committing\u2026';
    diffCommitError.style.display = 'none';

    // Only commit files the user actually edited during this bug session
    var filesToCommit = editedFiles.slice();
    // Also include the current drawer file if not already in the list
    if (currentDrawerFile && filesToCommit.indexOf(currentDrawerFile) === -1) {
      filesToCommit.push(currentDrawerFile);
    }

    apiPost('/api/git/commit', { message: message, files: filesToCommit }, function (status, data) {
      diffCommitBtn.disabled = false;
      diffCommitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Commit';

      if (status === 200 && data && data.success) {
        diffCommitError.style.display = 'block';
        diffCommitError.className = 'git-result success';
        diffCommitError.textContent = '\u2713 ' + (data.message || 'Committed successfully');
        // Hide diff after successful commit
        setTimeout(function () {
          analysisDiffSection.style.display = 'none';
          diffCommitError.style.display = 'none';
        }, 3000);
      } else {
        // Show error message below
        diffCommitError.style.display = 'block';
        diffCommitError.className = 'git-result error';
        diffCommitError.textContent = '\u2717 Commit failed: ' + (data ? (data.message || data.error) : 'unknown error');
      }
    });
  }

  // ═══════════════════════════════════════════════════════
  //  DIFF / ANALYSIS MODAL (kept for code search file viewer)
  // ═══════════════════════════════════════════════════════

  function openDiffModal(bugId, bug) {
    var title = bug ? (bug.title || 'Bug') : 'Bug';
    diffTitle.textContent = 'Analysis: #' + String(bugId).slice(-6) + ' — ' + title;
    diffModal.style.display = 'flex';

    // Build file list from analysis
    var files = [];
    var fileSet = {};

    if (currentAnalysis) {
      (currentAnalysis.relevantFiles || []).forEach(function (f) {
        if (!fileSet[f]) { fileSet[f] = true; files.push(f); }
      });
      (currentAnalysis.codeMatches || []).forEach(function (m) {
        if (m.file && !fileSet[m.file]) { fileSet[m.file] = true; files.push(m.file); }
      });
    }

    renderDiffFileList(files);

    if (files.length > 0) {
      selectDiffFile(files[0]);
    } else {
      diffFileHeader.textContent = 'No relevant files found';
      diffCode.innerHTML =
        '<div class="diff-no-files">' +
          '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">' +
            '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>' +
            '<polyline points="13 2 13 9 20 9"/>' +
          '</svg>' +
          '<span>No relevant code files found for this bug.</span>' +
          '<span style="font-size:12px;color:var(--text-muted)">Make sure the agent is running or project directory is configured.</span>' +
        '</div>';
    }
  }

  function renderDiffFileList(files) {
    diffFileList.innerHTML = '';
    files.forEach(function (f) {
      var matchCount = getMatchCountForFile(f);
      var fileName = f.split('/').pop();
      var item = document.createElement('div');
      item.className = 'diff-file-item';
      item.setAttribute('data-file', f);
      item.innerHTML =
        '<svg class="diff-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
          '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>' +
          '<polyline points="13 2 13 9 20 9"/>' +
        '</svg>' +
        '<span class="diff-file-name" title="' + esc(f) + '">' + esc(fileName) + '</span>' +
        (matchCount > 0 ? '<span class="diff-match-count">' + matchCount + '</span>' : '');
      item.addEventListener('click', function () { selectDiffFile(f); });
      diffFileList.appendChild(item);
    });
  }

  function selectDiffFile(filepath) {
    // Highlight active in sidebar
    diffFileList.querySelectorAll('.diff-file-item').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-file') === filepath);
    });

    diffFileHeader.textContent = filepath;

    // Check cache first
    if (diffFileCache[filepath]) {
      renderDiffCode(filepath, diffFileCache[filepath]);
      return;
    }

    // Fetch via API
    diffCode.innerHTML = '<div class="diff-no-files"><span class="spinner"></span> Loading file…</div>';

    apiGet('/api/read-file?path=' + encodeURIComponent(filepath), function (status, data) {
      if (status !== 200 || !data || !data.content) {
        diffCode.innerHTML = '<div class="diff-no-files">Could not load file: ' + esc(data ? data.error : '') + '</div>';
        return;
      }
      diffFileCache[filepath] = data.content;
      renderDiffCode(filepath, data.content);
    });
  }

  function renderDiffCode(filepath, content) {
    var lines = content.split('\n');
    var matchedLines = getMatchLinesForFile(filepath);
    var matchLineNums = Object.keys(matchedLines).map(Number).sort(function(a,b){ return a-b; });
    var CONTEXT = 3;

    var html = '';

    // If no matches, show full file
    if (matchLineNums.length === 0) {
      lines.forEach(function (line, i) {
        html += '<div class="diff-line">' +
          '<span class="diff-line-num">' + (i + 1) + '</span>' +
          '<span class="diff-line-gutter"></span>' +
          '<span class="diff-line-text">' + esc(line) + '</span></div>';
      });
      diffCode.innerHTML = html;
      return;
    }

    // Build visible ranges
    var ranges = [];
    matchLineNums.forEach(function (ln) {
      var start = Math.max(1, ln - CONTEXT);
      var end = Math.min(lines.length, ln + CONTEXT);
      if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
        ranges[ranges.length - 1].end = end;
      } else {
        ranges.push({ start: start, end: end });
      }
    });

    ranges.forEach(function (range, ri) {
      var hiddenBefore = ri === 0 ? range.start - 1 : range.start - ranges[ri - 1].end - 1;
      if (hiddenBefore > 0) {
        html += '<div class="diff-separator">' +
          '<span class="diff-separator-line"></span>' +
          '<span class="diff-separator-text">\u22ef ' + hiddenBefore + ' line' + (hiddenBefore !== 1 ? 's' : '') + ' \u22ef</span>' +
          '<span class="diff-separator-line"></span></div>';
      }
      for (var ln = range.start; ln <= range.end; ln++) {
        var isMatch = matchedLines[ln];
        html += '<div class="diff-line' + (isMatch ? ' match' : ' context') + '">' +
          '<span class="diff-line-num">' + ln + '</span>' +
          '<span class="diff-line-gutter">' + (isMatch ? '\u258e' : '') + '</span>' +
          '<span class="diff-line-text">' + esc(lines[ln - 1] || '') + '</span></div>';
      }
    });

    var lastEnd = ranges[ranges.length - 1].end;
    var hiddenAfter = lines.length - lastEnd;
    if (hiddenAfter > 0) {
      html += '<div class="diff-separator">' +
        '<span class="diff-separator-line"></span>' +
        '<span class="diff-separator-text">\u22ef ' + hiddenAfter + ' line' + (hiddenAfter !== 1 ? 's' : '') + ' \u22ef</span>' +
        '<span class="diff-separator-line"></span></div>';
    }

    diffCode.innerHTML = html;
  }

  function getMatchCountForFile(filepath) {
    if (!currentAnalysis || !currentAnalysis.codeMatches) return 0;
    var count = 0;
    currentAnalysis.codeMatches.forEach(function (m) {
      if (filePathMatch(m.file, filepath)) count++;
    });
    return count;
  }

  function getMatchLinesForFile(filepath) {
    var lines = {};
    if (!currentAnalysis || !currentAnalysis.codeMatches) return lines;
    currentAnalysis.codeMatches.forEach(function (m) {
      if (filePathMatch(m.file, filepath)) {
        lines[m.line] = true;
      }
    });
    return lines;
  }

  function filePathMatch(a, b) {
    if (a === b) return true;
    var na = a.replace(/\\/g, '/');
    var nb = b.replace(/\\/g, '/');
    return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
  }

  function copyDiffPrompt() {
    if (!currentDiffPrompt) return;
    copyToClipboard(currentDiffPrompt, diffCopyBtn,
      '✓ Copied!',
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy AI Prompt'
    );
  }

  // ═══════════════════════════════════════════════════════
  //  CODE SEARCH
  // ═══════════════════════════════════════════════════════

  function doCodeSearch() {
    var q = codeSearchInput.value.trim();
    if (!q) return;

    searchResultsEl.innerHTML = '<div class="loading-text"><span class="spinner"></span> Searching…</div>';

    var type = searchTypeEl.value;
    var endpoint = type === 'grep' ? '/api/grep' : '/api/search';

    apiGet(endpoint + '?q=' + encodeURIComponent(q), function (status, data) {
      if (status !== 200 || !data) {
        searchResultsEl.innerHTML = '<div class="empty-state">Search failed. ' + esc(data ? data.error : '') + '</div>';
        return;
      }

      if (type === 'grep') {
        var matches = data.matches || [];
        if (matches.length === 0) {
          searchResultsEl.innerHTML = '<div class="empty-state">No matches found for "' + esc(q) + '"</div>';
          return;
        }
        searchResultsEl.innerHTML = '';
        matches.forEach(function (m) {
          var hit = document.createElement('div');
          hit.className = 'search-hit';
          hit.innerHTML =
            '<span class="hit-file">' + esc(m.file) + '</span>' +
            '<span class="hit-line">L' + m.line + '</span>' +
            '<span class="hit-text">' + esc(m.text) + '</span>';
          hit.addEventListener('click', function () { openFile(m.file, m.line); });
          searchResultsEl.appendChild(hit);
        });
      } else {
        var files = data.files || [];
        if (files.length === 0) {
          searchResultsEl.innerHTML = '<div class="empty-state">No files found matching "' + esc(q) + '"</div>';
          return;
        }
        searchResultsEl.innerHTML = '';
        files.forEach(function (f) {
          var hit = document.createElement('div');
          hit.className = 'search-hit';
          hit.innerHTML = '<span class="hit-file">' + esc(f) + '</span>';
          hit.addEventListener('click', function () { openFile(f); });
          searchResultsEl.appendChild(hit);
        });
      }
    });
  }

  function openFile(filePath, lineNum) {
    fileModalTitle.textContent = filePath;
    fileContent.textContent = 'Loading…';
    fileModal.style.display = 'flex';

    var url = '/api/read-file?path=' + encodeURIComponent(filePath);
    if (lineNum) {
      var start = Math.max(1, lineNum - 20);
      var end = lineNum + 30;
      url += '&start=' + start + '&end=' + end;
    }

    apiGet(url, function (status, data) {
      if (status !== 200 || !data) {
        fileContent.textContent = 'Failed to load file.';
        return;
      }
      var header = '// ' + (data.file || filePath) + '  (lines ' + (data.startLine || 1) + '–' + (data.endLine || data.totalLines || '?') + ' of ' + (data.totalLines || '?') + ')\n\n';
      fileContent.textContent = header + (data.content || '');
    });
  }

  // ═══════════════════════════════════════════════════════
  //  SETTINGS
  // ═══════════════════════════════════════════════════════

  function populateSettings() {
    if (!currentUser) return;
    settingProjectDir.value = currentUser.projectDir || '';
    settingAgentUrl.value = currentUser.agentUrl || '';
    settingPortal.value = currentUser.zohoPortal || '';
    settingProjectId.value = currentUser.zohoProjectId || '';
    settingDefaultAssignee.value = currentUser.defaultAssignee || '';
    settingExts.value = (currentUser.fileExtensions || []).join(',');
    settingExclude.value = (currentUser.excludeDirs || []).join(',');
    settingGithubToken.value = '';
    settingGithubToken.placeholder = currentUser.hasGithubToken ? '••••••••  (token saved — enter new value to change)' : 'github_pat_... or ghp_...';
    settingClaudeKey.value = '';
    settingClaudeKey.placeholder = currentUser.hasClaudeKey ? '••••••••  (key saved — enter new value to change)' : 'sk-ant-api03-...';
    settingAiModel.value = currentUser.aiModel || 'claude-opus-4-6';
    // Migrate old Anthropic/ prefix model IDs
    if (!settingAiModel.value || !settingAiModel.selectedOptions.length) {
      var migrated = (currentUser.aiModel || '').replace(/^Anthropic\//i, '');
      settingAiModel.value = migrated;
      if (!settingAiModel.value) settingAiModel.value = 'claude-opus-4-6';
    }
    if (settingDevServerUrl) settingDevServerUrl.value = currentUser.devServerUrl || '';
    if (settingTestUsername) settingTestUsername.value = currentUser.testUsername || '';
    if (settingTestPassword) {
      settingTestPassword.value = '';
      settingTestPassword.placeholder = currentUser.hasTestPassword ? '••••••••  (saved — enter new value to change)' : '••••••••';
    }
    toggleAiKeyFields();
    checkBridge();

    if (currentUser.agentUrl) {
      modeAgentRadio.checked = true;
    } else if (currentUser.projectDir) {
      modeLocalRadio.checked = true;
    } else {
      modeAgentRadio.checked = true;
    }
    updateModeUI();

    if (currentUser.configured) loadProjectStats();
    if (currentUser.agentUrl) setTimeout(checkAgent, 500);
  }

  function updateModeUI() {
    var isAgent = modeAgentRadio.checked;
    agentSettingsEl.style.display = isAgent ? 'block' : 'none';
    localSettingsEl.style.display = isAgent ? 'none' : 'block';
  }

  /**
   * Show/hide the optional Anthropic API key fallback field.
   * Only shown when a Claude/Anthropic model is selected.
   * GitHub PAT is always visible (primary auth for all models).
   */
  function toggleAiKeyFields() {
    var model = settingAiModel.value || '';
    var isClaude = /^claude-/i.test(model);
    claudeKeyGroup.style.display = isClaude ? 'block' : 'none';
  }

  settingAiModel.addEventListener('change', toggleAiKeyFields);

  // Check Copilot Bridge status
  function checkBridge() {
    if (!bridgeStatusDot) return;
    bridgeStatusDot.className = 'agent-dot agent-dot-unknown';
    bridgeInfoEl.style.display = 'none';
    apiGet('/api/copilot-bridge-status', function (status, data) {
      if (data && data.ok) {
        bridgeStatusDot.className = 'agent-dot agent-dot-ok';
        bridgeInfoEl.style.display = 'block';
        var models = (data.models || []).map(function (m) { return m.family || m.name; });
        var unique = models.filter(function (v, i, a) { return a.indexOf(v) === i; });
        bridgeInfoEl.innerHTML = '<small style="color:#27ae60">&check; Connected — Available: ' + (unique.join(', ') || 'checking…') + '</small>';
      } else {
        bridgeStatusDot.className = 'agent-dot agent-dot-error';
        bridgeInfoEl.style.display = 'block';
        bridgeInfoEl.innerHTML = '<small style="color:var(--text-muted)">Not running. Install the extension and restart VS Code.</small>';
      }
    });
  }
  if (checkBridgeBtn) checkBridgeBtn.addEventListener('click', checkBridge);

  // Discover available models for the user's GitHub token
  discoverModelsBtn.addEventListener('click', function () {
    discoverModelsBtn.disabled = true;
    discoverModelsBtn.textContent = '…';
    modelDiscoverStatus.textContent = 'Querying GitHub Models API...';
    modelDiscoverStatus.style.color = '';

    apiGet('/api/discover-models', function (status, data) {
      discoverModelsBtn.disabled = false;
      discoverModelsBtn.textContent = '\uD83D\uDD0D Discover';

      if (!data) {
        modelDiscoverStatus.textContent = '\u2717 Failed. Save your GitHub token first, then try again.';
        modelDiscoverStatus.style.color = '#e74c3c';
        return;
      }

      if (data.discovered && data.models && data.models.length > 0) {
        // Rebuild dropdown grouped by publisher
        var saved = settingAiModel.value;
        settingAiModel.innerHTML = '';

        // Group discovered models by publisher
        var byPublisher = {};
        var publisherOrder = [];
        data.models.forEach(function (m) {
          var pub = m.publisher || 'Other';
          if (!byPublisher[pub]) { byPublisher[pub] = []; publisherOrder.push(pub); }
          byPublisher[pub].push(m);
        });

        // Put Anthropic first if present
        publisherOrder.sort(function (a, b) {
          if (/anthropic/i.test(a)) return -1;
          if (/anthropic/i.test(b)) return 1;
          return a.localeCompare(b);
        });

        publisherOrder.forEach(function (pub) {
          var grp = document.createElement('optgroup');
          grp.label = pub + ' (' + byPublisher[pub].length + ' models)';
          byPublisher[pub].forEach(function (m) {
            var opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label || m.id;
            grp.appendChild(opt);
          });
          settingAiModel.appendChild(grp);
        });

        // Restore previous selection if still available
        settingAiModel.value = saved;
        if (!settingAiModel.value && data.models.length) settingAiModel.value = data.models[0].id;

        // Always append Claude models (they're not on GitHub Models API)
        var claudeGrp = document.createElement('optgroup');
        claudeGrp.label = 'Claude (via Copilot Bridge or Anthropic Key)';
        var claudeModels = [
          { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
          { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
          { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
          { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' }
        ];
        claudeModels.forEach(function (m) {
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.label;
          claudeGrp.appendChild(opt);
        });
        settingAiModel.appendChild(claudeGrp);

        // Re-check saved selection (might be a Claude model)
        if (!settingAiModel.value) settingAiModel.value = saved;
        if (!settingAiModel.value) settingAiModel.value = data.models[0].id;
        toggleAiKeyFields();

        modelDiscoverStatus.textContent = '\u2713 Found ' + data.count + ' models available for your Copilot token!';
        modelDiscoverStatus.style.color = '#27ae60';
      } else {
        modelDiscoverStatus.textContent = (data.message || 'Could not discover models.') + ' Default list is still valid.';
        modelDiscoverStatus.style.color = '#e5a100';
      }
    });
  });

  function checkAgent() {
    var url = settingAgentUrl.value.trim();
    if (!url) {
      agentStatusDot.className = 'agent-dot agent-dot-unknown';
      agentInfoEl.style.display = 'none';
      return;
    }

    agentStatusDot.className = 'agent-dot agent-dot-checking';
    checkAgentBtn.disabled = true;
    checkAgentBtn.textContent = '…';

    apiGet('/api/check-agent?url=' + encodeURIComponent(url), function (status, data) {
      checkAgentBtn.disabled = false;
      checkAgentBtn.textContent = 'Test';

      if (status === 200 && data && data.ok) {
        agentStatusDot.className = 'agent-dot agent-dot-online';
        agentInfoEl.style.display = 'block';
        agentInfoEl.innerHTML =
          '<strong>✓ Connected</strong> — ' + esc(data.name || 'Agent') +
          '<br>Project: ' + esc(data.projectDir || '?') +
          '<br>Time: ' + esc(data.timestamp || '');
      } else {
        agentStatusDot.className = 'agent-dot agent-dot-offline';
        agentInfoEl.style.display = 'block';
        agentInfoEl.innerHTML = '<strong>✗ Cannot reach agent</strong> — ' + esc(data ? data.error : 'unknown') +
          '<br>Make sure <code>node agent.js</code> is running on that machine.';
      }
    });
  }

  function saveSettings() {
    var isAgent = modeAgentRadio.checked;

    var body = {
      zohoPortal: settingPortal.value.trim(),
      zohoProjectId: settingProjectId.value.trim(),
      defaultAssignee: settingDefaultAssignee.value.trim()
    };

    if (isAgent) {
      body.agentUrl = settingAgentUrl.value.trim();
      body.projectDir = '';
    } else {
      body.projectDir = settingProjectDir.value.trim();
      body.agentUrl = '';
    }

    // Only update API keys if user typed a new value
    var githubTokenVal = settingGithubToken.value.trim();
    if (githubTokenVal) body.githubToken = githubTokenVal;
    var claudeKeyVal = settingClaudeKey.value.trim();
    if (claudeKeyVal) body.claudeApiKey = claudeKeyVal;
    body.aiModel = settingAiModel.value;
    if (settingDevServerUrl) body.devServerUrl = settingDevServerUrl.value.trim();
    if (settingTestUsername) body.testUsername = settingTestUsername.value.trim();
    var testPwVal = settingTestPassword ? settingTestPassword.value.trim() : '';
    if (testPwVal) body.testPassword = testPwVal;

    var extsVal = settingExts.value.trim();
    if (extsVal) body.fileExtensions = extsVal.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    var exclVal = settingExclude.value.trim();
    if (exclVal) body.excludeDirs = exclVal.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    saveSettingsBtn.disabled = true;
    saveSettingsBtn.textContent = 'Saving…';

    apiPost('/api/settings', body, function (status, data) {
      saveSettingsBtn.disabled = false;
      saveSettingsBtn.textContent = 'Save Settings';

      if (status === 200 && data) {
        currentUser = data;
        showToast(settingsStatus, '✓ Settings saved successfully!', 'success');
        loadProjectStats();
      } else {
        showToast(settingsStatus, '✗ ' + (data ? data.error : 'Save failed'), 'error');
      }
    });
  }

  function loadProjectStats() {
    apiGet('/api/project-stats', function (status, data) {
      if (status !== 200 || !data || !data.valid) {
        projectStatsEl.style.display = 'none';
        return;
      }

      projectStatsEl.style.display = 'block';
      var html = '<div class="stat-row"><span class="stat-label">Total Files</span><span class="stat-value">' + data.totalFiles + '</span></div>';

      if (data.byExtension) {
        Object.keys(data.byExtension).forEach(function (ext) {
          html += '<div class="stat-row"><span class="stat-label">' + esc(ext) + '</span><span class="stat-value">' + data.byExtension[ext] + '</span></div>';
        });
      }

      statsContentEl.innerHTML = html;
    });
  }

  // ═══════════════════════════════════════════════════════
  //  MODALS
  // ═══════════════════════════════════════════════════════

  function closeSplitView() {
    // Save extra description before closing
    var extraInput = document.getElementById('extra-desc-input');
    if (currentBugId && extraInput) {
      extraDescCache[currentBugId] = extraInput.value;
    }
    splitView.classList.remove('active');
    splitRight.style.display = 'none';
    bugNameListEl.style.display = 'none';
    tableView.style.display = '';
    currentBugId = null;
  }

  function renderBugNameList(activeBugId) {
    bugNameListEl.innerHTML = '';
    currentBugs.forEach(function (bug) {
      var item = document.createElement('div');
      item.className = 'bug-name-item' + (bug.id === activeBugId ? ' active' : '');
      item.setAttribute('data-id', bug.id);
      var shortId = bug.id ? '#' + String(bug.id).slice(-6) : '';
      var stClass = getStatusClass(bug.status);
      item.innerHTML =
        '<span class="bug-name-id">' + shortId + '</span>' +
        '<span class="bug-name-title" title="' + esc(bug.title) + '">' + esc(bug.title) + '</span>' +
        '<span class="bug-name-status"><span class="status-badge ' + stClass + '" style="font-size:9px;padding:2px 6px;">' + esc(bug.status) + '</span></span>';
      item.addEventListener('click', function () {
        openBug(bug.id);
      });
      bugNameListEl.appendChild(item);
    });
  }

  function closeModals() {
    fileModal.style.display = 'none';
    diffModal.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════

  function showToast(el, msg, type) {
    el.textContent = msg;
    el.className = 'settings-toast toast-' + type;
    el.style.display = 'block';
    setTimeout(function () { el.style.display = 'none'; }, 5000);
  }

  function copyToClipboard(text, btnEl, successHtml, resetHtml) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        btnEl.innerHTML = successHtml;
        setTimeout(function () { btnEl.innerHTML = resetHtml; }, 2000);
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* */ }
      document.body.removeChild(ta);
      btnEl.innerHTML = successHtml;
      setTimeout(function () { btnEl.innerHTML = resetHtml; }, 2000);
    }
  }

  function getStatusClass(status) {
    if (!status) return '';
    var s = status.toLowerCase();
    if (s === 'open')              return 'st-open';
    if (s === 'in progress')       return 'st-in-progress';
    if (s === 'to be tested')      return 'st-to-be-tested';
    if (s === 'fixed')             return 'st-fixed';
    if (s === 'next release')      return 'st-next-release';
    if (s === 'immediate next release') return 'st-next-release';
    if (s === 'closed')            return 'st-closed';
    if (s === 'reopen')            return 'st-reopen';
    return 'st-in-progress';
  }

  function getSeverityClass(sev) {
    if (!sev) return '';
    var s = sev.toLowerCase();
    if (s === 'blocker')      return 'sev-blocker';
    if (s === 'critical')     return 'sev-critical';
    if (s === 'major')        return 'sev-major';
    if (s === 'minor')        return 'sev-minor';
    if (s === 'enhancement')  return 'sev-enhancement';
    return 'sev-minor';
  }

  /**
   * Minimal Markdown → HTML renderer for AI responses.
   * Handles: headers, code blocks, inline code, bold, italic, lists, paragraphs.
   */
  function renderMarkdown(text) {
    if (!text) return '';
    var s = String(text);

    // Escape HTML first
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Fenced code blocks  ```lang ... ```
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
      return '<pre class="fix-ai-codeblock"><code>' + code.trim() + '</code></pre>';
    });

    // Inline code `...`
    s = s.replace(/`([^`]+)`/g, '<code class="fix-ai-inline-code">$1</code>');

    // Headers
    s = s.replace(/^#### (.+)$/gm, '<h4 class="fix-ai-h">$1</h4>');
    s = s.replace(/^### (.+)$/gm, '<h3 class="fix-ai-h">$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2 class="fix-ai-h">$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1 class="fix-ai-h">$1</h1>');

    // Bold & italic
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Unordered list items
    s = s.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    // Ordered list items
    s = s.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
    // Wrap consecutive <li> in <ul>
    s = s.replace(/((?:<li>.*?<\/li>\n?)+)/g, '<ul class="fix-ai-list">$1</ul>');

    // Paragraphs: double newlines
    s = s.replace(/\n{2,}/g, '</p><p>');
    s = '<p>' + s + '</p>';

    // Clean up empty paragraphs
    s = s.replace(/<p>\s*<\/p>/g, '');
    // Don't wrap block elements in <p>
    s = s.replace(/<p>(<pre|<h[1-4]|<ul)/g, '$1');
    s = s.replace(/(<\/pre>|<\/h[1-4]>|<\/ul>)<\/p>/g, '$1');

    return s;
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    var parts = dateStr.match(/(\d{2})-(\d{2})-(\d{4})/);
    if (parts) return parts[2] + '/' + parts[1] + '/' + parts[3];
    try {
      var d = new Date(dateStr);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      }
    } catch (e) { /* */ }
    return dateStr.substring(0, 16);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // ── Boot ───────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
