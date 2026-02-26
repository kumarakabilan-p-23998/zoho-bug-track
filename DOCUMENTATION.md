# Zoho Bug Track — Technical Documentation

> **Version:** 1.0.0  
> **Runtime:** Node.js ≥ 8.0.0 (zero dependencies — uses only built-in modules)  
> **License:** Private  
> **Last Updated:** February 2026

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Getting Started](#3-getting-started)
4. [Server — server.js](#4-server--serverjs)
5. [Agent — agent.js](#5-agent--agentjs)
6. [Core Libraries](#6-core-libraries)
7. [AI Integration](#7-ai-integration)
8. [Analysis Pipeline](#8-analysis-pipeline)
9. [Patch System](#9-patch-system)
10. [Logging System](#10-logging-system)
11. [Frontend — public/](#11-frontend--public)
12. [Copilot Bridge Extension](#12-copilot-bridge-extension)
13. [Data Storage](#13-data-storage)
14. [Environment Variables](#14-environment-variables)
15. [API Reference](#15-api-reference)
16. [Troubleshooting](#16-troubleshooting)

---

## 1. Overview

**Zoho Bug Track** is a full-stack application that connects to Zoho Projects, fetches bug reports, scans your project codebase, and uses AI to analyze root causes and generate code fixes — all in a single workflow.

### Key Capabilities

| Feature | Description |
|---------|-------------|
| **Zoho Integration** | OAuth2 login, bug listing with filters, milestone/assignee filtering, attachment & screenshot download |
| **Code Scanning** | Keyword extraction from bug titles/descriptions → file search → grep → weighted scoring → relevant file content |
| **AI Analysis & Fix** | 3 AI providers (GitHub Models API, Anthropic Claude, VS Code Copilot Bridge) generate root cause analysis + code fixes |
| **Smart Patching** | LCS-based line-level diff → unified diff parsing → fuzzy context matching → safe merge with backup/revert |
| **Bug Reproduction** | Playwright-based automated browser tests to confirm bugs (Layer 2) |
| **Git Integration** | View changed files, diffs, stage & commit directly from the UI |
| **Structured Logging** | JSONL logs per session + per day + per bug with full AI prompt/response capture |
| **Zero Dependencies** | Everything runs on Node.js built-in modules (http, https, fs, path, os, crypto, child_process, url, querystring) |

---

## 2. Architecture

### System Components

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (SPA)                        │
│         public/index.html + app.js + style.css          │
│    Tabs: Bugs | Code Search | Logs | Settings           │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP
                         ▼
┌─────────────────────────────────────────────────────────┐
│              Server — server.js (port 3000)              │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌─────────────────────┐   │
│  │  OAuth    │  │  REST    │  │  Analysis Pipeline  │   │
│  │  Layer    │  │  API     │  │  (6-Step Engine)    │   │
│  └──────────┘  └──────────┘  └─────────────────────┘   │
│                                                         │
│  Libraries:                                             │
│  zoho-auth · zoho-client · bug-service · code-analyzer  │
│  fix-prompt · patch-utils · logger · user-store         │
│  agent-proxy · env-config                               │
└──────┬───────────────┬───────────────┬──────────────────┘
       │               │               │
       ▼               ▼               ▼
┌────────────┐  ┌────────────┐  ┌──────────────────┐
│  Agent.js  │  │ AI Clients │  │ Zoho Projects    │
│ (port 4000)│  │            │  │ API              │
│            │  │ GitHub API │  │                  │
│ Code scan  │  │ Claude API │  │ Bugs, milestones │
│ Git ops    │  │ Copilot    │  │ attachments,     │
│ Playwright │  │ Bridge     │  │ comments         │
└────────────┘  └────────────┘  └──────────────────┘
```

### Four Architectural Layers

| Layer | Component | Port | Responsibility |
|-------|-----------|------|----------------|
| **Frontend** | `public/app.js` | — | Vanilla JS SPA with 4 tabs: Bugs, Code Search, Logs, Settings |
| **Server** | `server.js` | 3000 | HTTP server, OAuth, 6-step analysis pipeline, patch/revert API, log viewer API |
| **Agent** | `agent.js` | 4000 | Runs on developer's machine — code scanning, file tree, grep, git, template resolution, Playwright |
| **AI** | 3 providers | — | GitHub Models API (models.github.ai), Anthropic Claude (api.anthropic.com), Copilot Bridge (localhost:3001) |

### Data Flow

```
User clicks "Analyze & Fix"
        │
        ▼
   ┌─────────┐     ┌──────────┐     ┌─────────────┐
   │ Browser  │────▶│ Server   │────▶│ Zoho API    │  Fetch bug details
   └─────────┘     │          │     └─────────────┘
                   │          │────▶│ Agent         │  Scan codebase
                   │          │     └───────────────┘
                   │          │────▶│ AI Provider   │  Analyze + generate fix
                   │          │     └───────────────┘
                   │          │
                   │  Parse AI response → extract fix
                   │  Preview diff → user reviews
                   │  Apply patch (with backup) → done
                   └──────────┘
```

---

## 3. Getting Started

### Prerequisites

- **Node.js** ≥ 8.0.0 (tested on v8.1.4+)
- **Zoho Projects** account with OAuth2 app credentials
- **AI Provider** (at least one):
  - GitHub Personal Access Token (for GPT-4.1, DeepSeek, Grok, etc.)
  - Anthropic API Key (for direct Claude access)
  - VS Code with Copilot Bridge extension (free with Copilot subscription)

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd zoho-bug-track

# No npm install needed — zero dependencies!

# Configure environment
cp .env.example .env   # Edit with your Zoho OAuth credentials
```

### Running the Server

```bash
# Start the web server (default port 3000)
node server.js

# Or with custom port
node server.js --port 8080
```

### Running the Agent (on your dev machine)

```bash
# Point to your project's source code directory
node agent.js --dir "/path/to/your/project/app"

# With custom options
node agent.js \
  --dir "/path/to/project" \
  --port 4000 \
  --name "MyMachine" \
  --extensions ".js,.hbs,.css,.java,.json,.xml" \
  --exclude "node_modules,.git,dist,tmp,vendor"
```

### First-Time Setup

1. Open `http://localhost:3000` in your browser
2. Click **"Sign in with Zoho"** → authenticate via OAuth
3. Go to **Settings** tab:
   - Enter your **Agent URL** (e.g., `http://192.168.1.50:4000`) — click "Test" to verify
   - Set your **Zoho Portal** name and **Project ID**
   - Choose an **AI Model** and enter the required API key
   - Click **Save Settings**
4. Switch to **Bugs** tab → your bugs will load automatically

---

## 4. Server — server.js

**Lines:** ~2,200 | **Port:** 3000 (configurable) | **Protocol:** HTTP

The server is the central orchestrator. It handles authentication, serves the SPA, proxies requests to the agent, routes AI calls, and exposes the full REST API.

### Startup Sequence

1. Load environment config (`lib/env-config.js`)
2. Initialize logger session (`lib/logger.js`)
3. Register SIGINT/SIGTERM handlers for graceful shutdown
4. Start HTTP server on configured port
5. Route incoming requests through the request handler

### Request Routing

All requests are handled by a single `requestHandler(req, res)` function that:
1. Parses URL pathname and query parameters
2. Serves static files for the SPA (`public/` directory)
3. Routes API calls based on path prefix matching
4. Authenticates protected endpoints via session cookie

### Session Management

- Sessions stored in `data/sessions.json`
- Session token set as `token` cookie (7-day expiry)
- Session validation on every `/api/*` request (except public endpoints)

---

## 5. Agent — agent.js

**Lines:** ~2,400 | **Port:** 4000 (configurable) | **Protocol:** HTTP

The agent runs **on the developer's machine** where the source code lives. It provides a REST API for code scanning, file operations, git commands, and Playwright test execution.

### CLI Arguments

| Flag | Alias | Default | Description |
|------|-------|---------|-------------|
| `--dir` | `-d` | (required) | Project directory to scan |
| `--port` | `-p` | `4000` | Port to listen on |
| `--name` | `-n` | `os.hostname()` | Machine/user display name |
| `--extensions` | `-e` | `.js,.hbs,.css,.java,.json,.xml` | File extensions to scan |
| `--exclude` | `-x` | `node_modules,.git,bower_components,dist,tmp,vendor,third-party` | Directories to exclude |
| `--allow-origins` | | `*` | CORS allowed origins |

### Key Features

| Feature | Details |
|---------|---------|
| **File List Cache** | Rebuilt every 30 seconds (TTL 30,000ms) for fast searches |
| **Weighted Scoring** | Code identifiers = 2 pts, plain words = 0.5 pts, filename match = +1 pt |
| **Ember Template Resolution** | Routes → HBS templates → nested components → JS files → services/mixins/helpers |
| **Playwright Integration** | Auto-installs `puppeteer-core@2.1.1`; finds Chrome/Edge on system; generates & executes tests |
| **Settings Persistence** | Stored at `~/.zoho-bug-track/settings.json` (outside repo) |
| **Git Operations** | Status, diff, stage + commit — all via child_process `git` commands |

### Route Detection

The agent has an intelligent route matcher that:
1. Parses bug title, description, and module fields
2. Extracts URL paths, page names, and navigation references
3. Parses structured QA descriptions (Page, Steps, Expected, Actual)
4. Matches against known Ember routes with confidence scoring

---

## 6. Core Libraries

### lib/zoho-auth.js (209 lines)

**Purpose:** Handles the complete Zoho OAuth2 flow.

| Function | Description |
|----------|-------------|
| `getAuthUrl()` | Builds authorization URL with client_id, scope, redirect_uri |
| `exchangeCode(code, cb)` | Exchanges auth code for access_token + refresh_token |
| `refreshAccessToken(refreshToken, cb)` | Refreshes an expired access token |
| `fetchUserProfile(accessToken, cb)` | Fetches user identity (Strategy 1: OAuth user/info, Strategy 2: Portal Users API) |

**OAuth Details:**
- **Auth Base:** `https://accounts.zoho.in/oauth/v2`
- **Scope:** `ZohoProjects.bugs.READ`, `ZohoProjects.bugs.UPDATE`, `ZohoProjects.users.READ`, `ZohoProjects.milestones.READ`
- **Access Type:** `offline` (provides refresh token)
- **Redirect URI:** `http://localhost:{PORT}/oauth/callback`

---

### lib/zoho-client.js (210 lines)

**Purpose:** Authenticated HTTP client for Zoho Projects REST API.

| Function | Description |
|----------|-------------|
| `getTokenForUser(userId, cb)` | Returns valid access token; auto-refreshes if expired |
| `apiBase(userId)` | Builds API base URL from user's portal/project config |
| `zohoGet(userId, apiPath, cb)` | Authenticated GET with auto-refresh on 401, retry on 5xx (max 2 retries) |
| `zohoDownload(userId, url, cb)` | Downloads binary data; follows 302 redirects; returns `(err, buffer, contentType)` |

**Configuration:** Timeout 15s, Max retries 2

---

### lib/bug-service.js (669 lines)

**Purpose:** Business logic for bug operations with caching and pagination.

| Function | Description |
|----------|-------------|
| `listBugs(userId, filters, cb)` | Lists bugs with in-memory caching (2-min TTL), parallel page fetching (5 pages × 200 = 1,000/batch, max 3,000 bugs) |
| `listMyBugs(userId, filters, cb)` | Lists current user's own bugs via `/mybugs/` endpoint |
| `getBugDetails(userId, bugId, cb)` | Full bug details + attachments + first 5 comments → text summary |
| `downloadBugImages(userId, attachments, cb)` | Downloads image attachments as base64 for AI vision (max 3 images, 5 MB total) |
| `listMilestones(userId, cb)` | Fetches milestones sorted: active first |
| `detectZuid(userId, assigneeName, cb)` | Auto-detects ZUID from bug data by name matching |

---

### lib/code-analyzer.js (603 lines)

**Purpose:** Local filesystem code analysis (used when agent is not available).

| Function | Description |
|----------|-------------|
| `walkDir(dir, exts, exclude, maxFiles)` | Recursive file walker (max 5,000 files) |
| `searchFiles(projectDir, query, opts)` | Filename search (case-insensitive, max 50 results) |
| `grepFiles(projectDir, pattern, opts)` | Content search with regex support (max 100 results, 500 KB file size limit) |
| `readFile(projectDir, relativePath, startLine, endLine)` | Reads file with optional line range (caps at 500 lines) |
| `analyzeForBug(projectDir, keywords, opts)` | Full keyword-based analysis: search + grep each keyword, score files, return top 15 with up to 10 file contents |
| `extractKeywords(title, description, fullText)` | Sophisticated 3-phase extraction: (1) code identifiers, (2) plain words filtered against 200+ stop words, (3) merge (max 8 code + 4 plain = 12) |
| `getProjectStats(projectDir, opts)` | Returns `{ totalFiles, byExtension }` |

---

### lib/agent-proxy.js (284 lines)

**Purpose:** HTTP proxy that forwards requests from the server to the remote agent.

All functions accept `(agentUrl, ...params, callback)` and support both `http://` and `https://` protocols.

| Function | Timeout | Agent Endpoint |
|----------|---------|----------------|
| `checkHealth` | 5s | `GET /health` |
| `getStats` | 15s | `GET /stats` |
| `searchFiles` | 15s | `GET /search` |
| `grepFiles` | 15s | `GET /grep` |
| `readFile` | 15s | `GET /read-file` |
| `analyzeForBug` | 60s | `GET /analyze` |
| `writeFile` | 15s | `POST /write-file` |
| `applyPatch` | 30s | `POST /apply-patch` |
| `revertFile` | 15s | `POST /revert-file` |
| `gitStatus` | 15s | `GET /git/status` |
| `gitDiff` | 15s | `GET /git/diff` |
| `gitCommit` | 30s | `POST /git/commit` |
| `getTemplateContext` | 10s | `GET /template-context` |
| `playwrightGenerate` | 15s | `POST /playwright/generate` |
| `playwrightRun` | 90s | `POST /playwright/run` |
| `playwrightVerify` | 90s | `POST /playwright/verify` |
| `promptSave` | 15s | `POST /prompts/save` |
| `promptLoad` | 10s | `GET /prompts/:bugId` |
| `saveSettings` | 10s | `POST /settings` |
| `loadSettings` | 10s | `GET /settings` |

---

### lib/fix-prompt.js (471 lines)

**Purpose:** Builds the AI analysis prompt with strict coding standards and structured output format.

#### Prompt Structure (in order)

| # | Section | Content |
|---|---------|---------|
| 1 | **Role** | "Senior Full-Stack Developer" expert in Ember.js 1.13.15 + Java 8 |
| 2 | **Bug Details** | Title, status, severity, description, attachments, comments |
| 3 | **Structured QA Data** | Parsed page, reproduction steps, expected vs actual behavior |
| 4 | **Additional Context** | User-provided extra description/notes |
| 5 | **Analysis Summary** | Keywords searched, relevant files, top scores |
| 6 | **Page Files for Route** | Route template (HBS), component templates + JS, route/controller, services, mixins, helpers |
| 7 | **Relevant Files** | Grep-based file list |
| 8 | **Code Matches** | Grep results (up to 30 matches) |
| 9 | **File Contents** | Full source of top relevant files |
| 10 | **Reproduction Evidence** | Playwright test results (if Layer 2 ran) |
| 11 | **What You Must Do** | Analyze → Identify Root Cause → Provide Fix |
| 12 | **Coding Standards** | Strict Ember.js 1.13.15 + Java 8 rules |
| 13 | **Required Output Format** | 7 sections: Root Cause, Affected Files, Fix Strategy, Code Fix, Test Cases, Regression Risks, Summary |
| 14 | **Code Block Rules** | 5 strict rules for parseable code blocks |

#### Coding Standards Enforced

**Ember.js 1.13.15 (Legacy):**
- `Ember.Component.extend({})` syntax (NOT ES6 classes)
- `this.get("prop")` / `this.set("prop", val)` (NOT direct property access)
- `{{curly-bracket}}` handlebars (NOT `<AngleBracket />` components)
- `this.$()` for jQuery inside components
- Closure actions (NOT `sendAction`)
- `Ember.run.scheduleOnce` for DOM updates
- Clean up listeners in `willDestroyElement`

**Java 8:**
- Null safety with `Optional<T>`
- Proper exception handling
- Optimized DB queries (no N+1)
- Thread safety considerations
- `try-with-resources` for I/O

#### Key Functions

| Function | Description |
|----------|-------------|
| `buildPrompt(bugDetails, analysis, extraDescription, templateContext, parsedDesc)` | Assembles the complete AI prompt from all sections |
| `generatePrompt(userId, bugDetails, extraDescription, parsedDesc)` | Full local analysis workflow: extract keywords → scan project → build prompt |
| `generatePromptViaAgent(userId, bugDetails, agentUrl, extraDescription, cb, templateContext, parsedDesc)` | Agent-based analysis: extract keywords → send to agent → build prompt |

---

### lib/user-store.js (243 lines)

**Purpose:** Manages user data and sessions with file-based persistence.

**Storage Locations:**
- Users: `data/users/{sanitized-id}.json`
- Sessions: `data/sessions.json`

| Function | Description |
|----------|-------------|
| `createSession(userId, userInfo)` | Creates 32-byte hex session token; purges sessions > 7 days |
| `validateSession(token)` | Returns `{ userId, email, name }` or null |
| `destroySession(token)` | Deletes session |
| `getUser(userId)` | Reads user config from JSON file |
| `saveUser(userId, partial)` | Merges partial data into existing config |
| `findExistingUser(skipUserId, matchName)` | Finds previous user config by name (for inheriting settings on re-login) |
| `getUserPublic(userId)` | Returns config without sensitive tokens |

**User Config Fields:** `userId`, `name`, `email`, `projectDir`, `agentUrl`, `zohoTokens` (access, refresh, expiresAt), `githubToken`, `claudeApiKey`, `aiModel`, `defaultAssignee`, `zohoZuid`, `zohoPortal`, `zohoProjectId`, `fileExtensions`, `excludeDirs`, `devServerUrl`, `testUsername`, `testPassword`, `createdAt`, `updatedAt`

---

### lib/env-config.js (50 lines)

**Purpose:** Loads environment variables from `.env` file.

Parses `.env` manually (no `dotenv` dependency). Supports `KEY=VALUE` format with `#` comments.

---

## 7. AI Integration

### Provider Routing Priority

When a user clicks "Analyze & Fix", the server chooses the AI provider in this order:

```
1. Is the model a Claude model?
   ├── YES → Is Copilot Bridge running on port 3001?
   │         ├── YES → Use Copilot Bridge (FREE with Copilot license)
   │         └── NO  → Does user have Anthropic API key?
   │                   ├── YES → Use Anthropic Direct API
   │                   └── NO  → ERROR: No Claude provider available
   │
   └── NO → Use GitHub Models API (requires GitHub PAT)
```

### Provider Comparison

| Provider | Module | Endpoint | Auth | Cost | Models |
|----------|--------|----------|------|------|--------|
| **GitHub Models** | `lib/github-ai-client.js` | `models.github.ai` | GitHub PAT | Free tier / Pay | GPT-4.1, DeepSeek, Grok, Llama, Mistral |
| **Anthropic** | `lib/claude-client.js` | `api.anthropic.com` | `sk-ant-...` key | Pay per token | Claude Opus/Sonnet 4, 3.5 Sonnet |
| **Copilot Bridge** | `lib/copilot-bridge-client.js` | `localhost:3001` | Copilot subscription | Free | Claude + GPT-4o (via VS Code) |

### Supported Models

#### GitHub Models API

| Model ID | Display Name |
|----------|-------------|
| `openai/gpt-4.1` | ⭐ GPT-4.1 (OpenAI) — **Default** |
| `openai/gpt-4.1-mini` | GPT-4.1 Mini |
| `openai/gpt-4.1-nano` | GPT-4.1 Nano |
| `openai/gpt-4o` | GPT-4o |
| `openai/gpt-4o-mini` | GPT-4o Mini |
| `deepseek/DeepSeek-R1` | DeepSeek R1 |
| `meta/llama-4-scout-17b-16e-instruct` | Llama 4 Scout (Meta) |
| `mistralai/mistral-large-2411` | Mistral Large |
| `xai/grok-3` | Grok 3 (xAI) |
| `xai/grok-3-mini` | Grok 3 Mini (xAI) |

#### Claude Models (via Copilot Bridge or Anthropic API)

| Model ID | Display Name | Copilot Family |
|----------|-------------|---------------|
| `claude-opus-4-6` | Claude Opus 4.6 | `claude-opus-4` |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | `claude-sonnet-4` |
| `claude-sonnet-4-20250514` | Claude Sonnet 4 | `claude-sonnet-4` |
| `claude-3-5-sonnet-20241022` | Claude 3.5 Sonnet | `claude-3.5-sonnet` |

### Common AI Parameters

| Parameter | Value |
|-----------|-------|
| Max Tokens | 16,384 |
| Timeout | 120 seconds (2 minutes) |
| Image Support | Yes (multimodal) — max 3 bug screenshots |
| Temperature | Default (not explicitly set) |

---

## 8. Analysis Pipeline

The core analysis happens in 6 steps when the user clicks "Analyze & Fix":

### Step 1/6 — Initialize

- Validate user settings (portal, project ID, code access mode)
- Resolve code access: Agent (remote) vs Local (filesystem)
- Log: `logger.analyzeStart(bugId, userId, opts)`

### Step 2/6 — Fetch Bug Details

- Call Zoho API for full bug data: title, description, status, severity
- Fetch attachments list + first 5 comments
- If "Include Screenshots" enabled: download bug images as base64 (max 3, 5 MB)
- Log: `logger.bugFetched(bugId, bugData, duration)`

### Step 3/6 — Auto-Detect Route

- Parse bug description for URL paths, page names, navigation references
- Parse structured QA format (Page:, Steps:, Expected:, Actual:)
- Match against Ember routes via agent `/routes/match`
- Fetch page template context (HBS + components + JS) for matched route
- Log: `logger.routeDetected(bugId, route, method, score)`

### Step 4/6 — Scan Codebase

- Extract keywords from bug data (code identifiers + plain words)
- Via **Agent**: Send keywords to `GET /analyze` → weighted file scoring
- Via **Local**: Use `code-analyzer.analyzeForBug()` directly
- Build AI prompt via `fix-prompt.buildPrompt()` with all context
- Log: `logger.codeScanComplete(bugId, result, duration)`

### Step 5/6 — Send to AI

- Route to appropriate AI provider (see routing priority above)
- Send complete prompt with optional screenshots
- Full prompt saved to `bugs/<bugId>_<title>/prompt_analyze_<timestamp>.txt`
- Log: `logger.aiPromptSent(bugId, prompt, opts)`

### Step 6/6 — Parse & Return Response

- Parse AI response text to extract:
  - Root cause analysis
  - Affected files
  - Code fixes (with file paths)
  - Test cases and regression risks
- 4 file detection strategies: explicit `FILE:` path, diff header (`---/+++`), content matching, best-effort
- Full response saved to `bugs/<bugId>_<title>/response_analyze_<timestamp>.txt`
- Log: `logger.aiResponseReceived(bugId, result, duration)`
- Return structured result to frontend

### Layer 2 — Bug Reproduction (Optional)

If the server has reproduction context (route template, interaction steps):

1. **Generate test script** — Ask AI for Playwright interaction steps or parse structured QA steps from bug description
2. **Build Playwright script** — Agent generates a `.js` test file with login → navigate → interact → assert sequence
3. **Execute test** — Agent runs Playwright against the user's dev server URL
4. **Evaluate results** — Check assertion pass/fail counts, capture screenshots
5. **Retry if inconclusive** — If first attempt fails (navigation errors, no assertions), regenerate with corrected steps
6. **Inject evidence** — Add "Reproduction Evidence" section to AI prompt before final analysis

---

## 9. Patch System

**Module:** `lib/patch-utils.js` (849 lines)

The patch system provides Copilot-like line-level file patching instead of full-file overwrites.

### Smart Merge Strategies

When AI returns code, `applySmartMerge()` automatically selects the best strategy:

| Strategy | When Used | How It Works |
|----------|-----------|--------------|
| **`patch`** | AI returns unified diff with `@@` markers | Parse hunks → apply with fuzzy context matching (±50 lines) |
| **`line-patch`** | AI returns full/near-full file content | Compute LCS diff against original → extract hunks → apply only changed lines (handles truncation via overlap detection) |
| **`snippet-patch`** | AI returns partial code snippet | Locate snippet in original via anchor lines → splice in → diff → apply hunks |

### Diff Algorithm

1. **LCS Table** — Compute Longest Common Subsequence between original and new file
2. **Edit Operations** — Backtrack to produce `equal`/`add`/`remove` operations
3. **Hunk Building** — Group consecutive edits with 3-line context into unified diff hunks
4. **Output** — Standard unified diff format (`---`, `+++`, `@@`, `+`, `-`, ` `)

### Fuzzy Context Matching

When applying hunks, the system doesn't require exact line positions:
1. Try exact match at expected line position
2. Search ±50 lines from expected position
3. Try trimmed matching (ignoring leading/trailing whitespace)
4. If no match found, skip hunk and report it

### Backup System

All file modifications create backups **outside** the project directory:

```
~/Documents/.zoho-bug-track-backups/
└── {md5-hash-of-project-dir}/
    └── path/to/file.js.bak.1772093001725
```

| Function | Description |
|----------|-------------|
| `createBackup(projectDir, relativePath)` | Creates timestamped backup file |
| `restoreFromBackup(projectDir, relativePath)` | Restores from most recent backup |
| `listBackups(projectDir, relativePath)` | Lists all backups sorted by timestamp |

---

## 10. Logging System

**Module:** `lib/logger.js` (941 lines)

### Log Levels

| Level | Numeric | Color | Use Case |
|-------|---------|-------|----------|
| `DEBUG` | 0 | Gray | Verbose diagnostic info |
| `INFO` | 1 | Cyan | Normal operations |
| `WARN` | 2 | Yellow | Unexpected but recoverable |
| `ERROR` | 3 | Red | Operation failures |
| `FATAL` | 4 | Magenta | Unrecoverable errors |

### Categories

| Category | Covers |
|----------|--------|
| `SYSTEM` | Server start/stop, config changes |
| `AUTH` | Login, logout, OAuth events |
| `BUG` | Bug list/detail operations |
| `ANALYZE` | Analysis pipeline (Steps 1–6) |
| `AI_PROMPT` | Full AI prompts sent |
| `AI_RESPONSE` | AI responses received |
| `PATCH` | Preview, apply, revert, backup |
| `AGENT` | Agent proxy communication |
| `REPRO` | Playwright reproduction |
| `API` | Generic API request/response |

### File Structure

```
~/Documents/.zoho-bug-track-logs/
├── sessions/
│   └── 2026-02-26_13-54-25.jsonl          # Per-session structured log
├── daily/
│   └── 2026-02-26.jsonl                   # Daily combined log
└── bugs/
    └── 334688000015993643_sidebar-not-rendering-properly/
        ├── prompt_analyze_2026-02-26_13-54-25.txt    # Full AI prompt
        └── response_analyze_2026-02-26_13-54-25.txt  # Full AI response
```

### Log Entry Format (JSONL)

Each line in `.jsonl` files is one JSON object:

```json
{
  "ts": "2026-02-26T07:56:32.338Z",
  "level": "INFO",
  "cat": "ANALYZE",
  "msg": "Bug details fetched",
  "sid": "2026-02-26_13-54-25",
  "bugId": "334688000015993643",
  "duration": 120,
  "d": {
    "title": "Sidebar not rendering properly",
    "status": "Open",
    "severity": "High"
  }
}
```

### Pipeline Helpers

| Function | Called At | Logs |
|----------|----------|------|
| `analyzeStart(bugId, userId, opts)` | Step 1/6 | Analysis initialization |
| `bugFetched(bugId, bugData, duration)` | Step 2/6 | Bug details + registers bug title for folder naming |
| `routeDetected(bugId, route, method, score)` | Step 3/6 | Route auto-detection result |
| `codeScanComplete(bugId, result, duration)` | Step 4/6 | Code scan results |
| `aiPromptSent(bugId, prompt, opts)` | Step 5/6 | Summary + saves full prompt to file |
| `aiResponseReceived(bugId, result, duration)` | Step 6/6 | Summary + saves full response to file |
| `aiError(bugId, error, opts)` | On failure | AI request errors |
| `reproAttempt(bugId, result)` | Layer 2 | Playwright reproduction results |
| `patchOperation(op, filePath, result)` | Apply/Revert | Patch apply and revert operations |
| `authEvent(action, userId, details)` | Login/Logout | Authentication events |

### Query API

| Function | Description |
|----------|-------------|
| `listLogs()` | Returns sessions, daily logs, and bug prompt directories |
| `queryLogs(type, id, filters)` | Query entries with level/category/bugId/search filters + pagination |
| `readPromptFile(bugId, fileName)` | Read a full prompt/response text file |
| `listPromptFiles(bugId)` | List all prompt/response files for a specific bug |

---

## 11. Frontend — public/

### Technology

- **Vanilla JavaScript** — zero dependencies, IIFE pattern
- **Vanilla CSS** — custom properties (CSS variables) for theming
- **No build step** — served directly as static files

### Files

| File | Lines | Purpose |
|------|-------|---------|
| `index.html` | ~729 | Page structure, all 4 tab contents, 3 modals |
| `app.js` | ~3,498 | All application logic, API calls, DOM manipulation |
| `style.css` | ~2,605 | Complete styling with Zoho Projects–inspired design |

### UI Structure

#### Login Screen
- "Sign in with Zoho" button with error display

#### App Screen — 4 Tabs

**1. Bugs Tab**
- Quick filter chips: All, Open, In Progress, To be Tested, Fixed, Next Release, Closed, Reopen
- Advanced filters: Severity dropdown, searchable milestone picker, assignee text input
- Split-view: bug list table (left) ↔ bug detail panel (right)
- Bug detail: metadata grid, extra description, route detection, screenshot toggle, "Analyze & Fix" button
- Analysis results: accordion sections (Root Cause, Affected Files, Fix Strategy, etc.), file viewer with tabs, code editor
- Git integration: changed files list, diff viewer, commit form

**2. Code Search Tab**
- Search input with type toggle (filename / code content)
- Results display with file path links and line numbers

**3. Logs Tab**
- Filter row: source (session/daily), level, category, search, bug ID
- Session info bar with stats
- Log entry table: Time, Level, Category, Message, Data
- Pagination controls
- Prompt viewer: click AI rows to view full prompts/responses
- Export to JSONL

**4. Settings Tab**
- Code access mode: Agent (remote) / Local
- Agent URL with health check
- Zoho portal/project configuration
- AI model selection with model discovery
- Copilot Bridge status
- API keys (GitHub PAT, Anthropic)
- Scan options (file extensions, exclude dirs)
- Playwright config (dev server URL, test credentials)

#### Modals

| Modal | Purpose |
|-------|---------|
| **Diff Modal** | Full-width side-by-side diff viewer with Apply/Force Apply/Cancel |
| **File Viewer** | Read-only file content display |
| **Commit Modal** | File selection checkboxes + commit message + submit |

---

## 12. Copilot Bridge Extension

**Directory:** `copilot-bridge/`

A VS Code extension that bridges Copilot-licensed AI models to a local HTTP endpoint, allowing the bug tracker to use Claude, GPT-4o, etc. **for free** with a Copilot subscription.

### How It Works

```
Bug Tracker (port 3000)
    │
    │  POST /analyze { prompt, modelFamily }
    ▼
Copilot Bridge (port 3001)
    │
    │  vscode.lm.selectChatModels({ family })
    │  model.sendRequest(messages)
    ▼
VS Code Copilot Language Model API
    │
    ▼
Copilot Backend (Claude, GPT-4o, etc.)
```

### Installation

```bash
cd copilot-bridge/
npx @vscode/vsce package
code --install-extension copilot-bridge-1.0.0.vsix
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ ok, name, port, models[] }` with available model list |
| POST | `/analyze` | `{ prompt, modelFamily, images[] }` → AI response `{ text, model, usage }` |

### VS Code Commands

| Command | Description |
|---------|-------------|
| `copilotBridge.start` | Start the HTTP server |
| `copilotBridge.stop` | Stop the HTTP server |
| `copilotBridge.toggle` | Toggle server on/off |

**Auto-starts** on VS Code startup (activation event: `onStartupFinished`).

---

## 13. Data Storage

### File Locations

| Data | Location | Format |
|------|----------|--------|
| User configs | `data/users/user_{hash}.json` | JSON |
| Sessions | `data/sessions.json` | JSON |
| Agent settings | `~/.zoho-bug-track/settings.json` | JSON |
| Session logs | `~/Documents/.zoho-bug-track-logs/sessions/` | JSONL |
| Daily logs | `~/Documents/.zoho-bug-track-logs/daily/` | JSONL |
| Bug prompt logs | `~/Documents/.zoho-bug-track-logs/bugs/` | TXT |
| Repro scripts | `~/Documents/.zoho-bug-track-logs/reproductions/bug_{id}_repro.js` | JS |
| Repro screenshots | `~/Documents/.zoho-bug-track-logs/reproductions/bug_{id}_screenshot.png` | PNG |
| Saved prompts | `~/Documents/.zoho-bug-track-logs/reproductions/bug_{id}.json` | JSON |
| File backups | `~/Documents/.zoho-bug-track-backups/` | Raw copies |

### User Config Schema

```json
{
  "userId": "string",
  "name": "string",
  "email": "string",
  "projectDir": "/path/to/project",
  "agentUrl": "http://192.168.1.50:4000",
  "zohoTokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1772093001725
  },
  "githubToken": "github_pat_...",
  "claudeApiKey": "sk-ant-api03-...",
  "aiModel": "openai/gpt-4.1",
  "defaultAssignee": "John Doe",
  "zohoZuid": "12345678",
  "zohoPortal": "logmanagementcloud",
  "zohoProjectId": "334688000000017255",
  "fileExtensions": ".js,.hbs,.css,.java,.json,.xml",
  "excludeDirs": "node_modules,.git,dist,tmp",
  "devServerUrl": "https://localhost:4200",
  "testUsername": "test@example.com",
  "testPassword": "••••••••",
  "createdAt": "2026-02-26T07:56:32.338Z",
  "updatedAt": "2026-02-26T07:56:32.338Z"
}
```

---

## 14. Environment Variables

Configure via `.env` file in project root:

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | Server port |
| `ZOHO_CLIENT_ID` | — | **Yes** | Zoho OAuth2 client ID |
| `ZOHO_CLIENT_SECRET` | — | **Yes** | Zoho OAuth2 client secret |
| `ZOHO_PORTAL` | `logmanagementcloud` | No | Default Zoho portal name |
| `ZOHO_PROJECT_ID` | — | No | Default Zoho project ID |
| `SESSION_SECRET` | `default-secret` | No | Session encryption secret |

### Example .env

```ini
PORT=3000
ZOHO_CLIENT_ID=1000.XXXXXXXXXXXXXXXXXXXX
ZOHO_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ZOHO_PORTAL=logmanagementcloud
ZOHO_PROJECT_ID=334688000000017255
SESSION_SECRET=my-secure-random-string
```

---

## 15. API Reference

### Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/auth/login` | None | Redirect to Zoho OAuth |
| GET | `/oauth/callback` | None | OAuth callback handler |
| POST | `/auth/logout` | Cookie | Destroy session |

### User & Settings

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/me` | Cookie | Current user info (no tokens) |
| POST | `/api/settings` | Cookie | Update user settings |
| GET | `/api/ai-models` | Cookie | List available AI models |
| GET | `/api/discover-models` | Cookie | Discover models on user's GitHub token |
| GET | `/api/copilot-bridge-status` | Cookie | Check Copilot Bridge health |
| GET | `/api/check-agent` | Cookie | Test agent connectivity |
| GET | `/api/project-stats` | Cookie | Get file stats from agent/local |

### Bugs

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/bugs` | Cookie | List bugs (with filters: status, severity, assignee, milestone) |
| GET | `/api/bugs/:id` | Cookie | Full bug details |
| POST | `/api/bugs/:id/analyze` | Cookie | **Run analysis pipeline** |
| POST | `/api/bugs/:id/verify` | Cookie | Re-run Playwright verification |
| GET | `/api/bugs/:id/prompt-log` | Cookie | Load saved prompt log |

### Code Operations

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/preview-diff` | Cookie | Preview diff without writing |
| POST | `/api/apply-patch` | Cookie | Apply AI fix with smart merge |
| POST | `/api/revert-file` | Cookie | Restore file from backup |
| POST | `/api/write-file` | Cookie | Write file with backup (legacy) |
| GET | `/api/search` | Cookie | Search filenames |
| GET | `/api/grep` | Cookie | Grep code content |
| GET | `/api/read-file` | Cookie | Read a file |

### Git

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/git/status` | Cookie | Branch + changed files |
| GET | `/api/git/diff` | Cookie | File diffs |
| POST | `/api/git/commit` | Cookie | Stage + commit |

### Milestones

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/milestones` | Cookie | List milestones |

### Logs

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/logs` | Cookie | List all log files |
| GET | `/api/logs/query` | Cookie | Query/filter log entries |
| GET | `/api/logs/prompts/:bugId` | Cookie | List prompt files for a bug |
| GET | `/api/logs/prompts/:bugId/:file` | Cookie | Read specific prompt/response file |
| GET | `/api/logs/session` | Cookie | Current session stats |

---

## 16. Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| **"Login error"** on start | Check `ZOHO_CLIENT_ID` and `ZOHO_CLIENT_SECRET` in `.env` |
| **Agent unreachable** | Ensure `agent.js` is running and the URL is correct in Settings |
| **"No AI provider available"** | Configure at least one: GitHub PAT, Anthropic key, or install Copilot Bridge |
| **Copilot Bridge not detected** | Open VS Code, check extension is installed and status bar shows "Running" |
| **"Token expired" errors** | Re-login via Zoho — refresh tokens auto-rotate |
| **File patches fail** | Check agent is pointing to the correct `--dir`; try "Force Apply" |
| **Logs not appearing** | Check `~/Documents/.zoho-bug-track-logs/` exists and is writable |

### Port Conflicts

| Port | Used By | Fix |
|------|---------|-----|
| 3000 | Server | `node server.js --port 8080` |
| 3001 | Copilot Bridge | Change in `copilot-bridge/extension.js` (BRIDGE_PORT) |
| 4000 | Agent | `node agent.js --port 5000` |

### Debug Tips

1. **Enable DEBUG logs**: Set `logger.setLevel('DEBUG')` in server.js
2. **Check daily log**: View `~/Documents/.zoho-bug-track-logs/daily/YYYY-MM-DD.jsonl`
3. **Full AI prompts**: Check `~/Documents/.zoho-bug-track-logs/bugs/` for exact prompts sent
4. **Agent health**: `curl http://localhost:4000/health`
5. **Bridge health**: `curl http://localhost:3001/health`

---

## File Summary

| File | Lines | Purpose |
|------|-------|---------|
| `server.js` | ~2,200 | Main HTTP server, analysis pipeline, all API endpoints |
| `agent.js` | ~2,400 | Code scanning agent, git, Playwright, template resolution |
| `lib/zoho-auth.js` | 209 | Zoho OAuth2 flow |
| `lib/zoho-client.js` | 210 | Authenticated Zoho API client |
| `lib/bug-service.js` | 669 | Bug operations with caching |
| `lib/code-analyzer.js` | 603 | Local code analysis |
| `lib/agent-proxy.js` | 284 | Agent HTTP proxy |
| `lib/fix-prompt.js` | 471 | AI prompt engineering |
| `lib/github-ai-client.js` | 283 | GitHub Models API client |
| `lib/claude-client.js` | 155 | Anthropic Claude API client |
| `lib/copilot-bridge-client.js` | 167 | Copilot Bridge client |
| `lib/patch-utils.js` | 849 | LCS diff, smart merge, backups |
| `lib/logger.js` | 941 | Structured JSONL logging |
| `lib/user-store.js` | 243 | User/session persistence |
| `lib/env-config.js` | 50 | Environment config loader |
| `public/app.js` | ~3,498 | Frontend SPA logic |
| `public/index.html` | ~729 | HTML structure |
| `public/style.css` | ~2,605 | Styling |
| `copilot-bridge/extension.js` | 227 | VS Code extension |
| **Total** | **~14,000+** | |
