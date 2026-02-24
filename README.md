# Zoho Bug Tracker — Per-User Edition

A self-hosted web app where each user logs in with their **Zoho account**, configures their **local project directory**, and can:

- 📋 **Browse bugs** with filters (status, severity, milestone, assignee)
- 🔍 **Search code** in their configured project (file name & grep)
- 📂 **Read files** from their project directly in the browser
- 🤖 **Generate AI fix prompts** — combines bug details + relevant code from the project
- 📋 **Copy prompt to clipboard** — paste into Copilot / Claude / ChatGPT

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (SPA)                        │
│   Login → Settings → Browse Bugs → Analyze → Copy      │
└────────────────────────┬────────────────────────────────┘
                         │  HTTP
┌────────────────────────▼────────────────────────────────┐
│                   server.js (:3000)                     │
│                                                         │
│  /auth/login     → Zoho OAuth redirect                  │
│  /auth/callback  → Token exchange, session creation     │
│  /api/me         → Current user config                  │
│  /api/settings   → Update project dir, portal, etc.     │
│  /api/bugs       → List bugs (filtered)                 │
│  /api/bugs/:id   → Bug details + comments               │
│  /api/bugs/:id/analyze → Code analysis + fix prompt     │
│  /api/search     → Search files in user's project       │
│  /api/grep       → Grep code in user's project          │
│  /api/read-file  → Read a file from user's project      │
└──┬────────────────────┬─────────────────────────────────┘
   │                    │
   ▼                    ▼
┌──────────┐    ┌──────────────────┐
│ Zoho API │    │ User's Local     │
│ (bugs,   │    │ Project Dir      │
│  tokens) │    │ (configured per  │
│          │    │  user in settings)│
└──────────┘    └──────────────────┘

Per-User Data (data/users/<userId>.json):
┌──────────────────────────────────┐
│ { userId, name, email,           │
│   projectDir: "D:/my/project",   │
│   zohoTokens: { access, refresh },│
│   zohoPortal, zohoProjectId,     │
│   fileExtensions, excludeDirs }  │
└──────────────────────────────────┘
```

## Setup

### 1. Create Zoho OAuth App

1. Go to [https://api-console.zoho.in/](https://api-console.zoho.in/)
2. Click **"Add Client"** → select **"Server-based Applications"**
3. Set the **Redirect URI** to: `http://localhost:3000/auth/callback`
4. Copy the **Client ID** and **Client Secret**

### 2. Configure .env

```bash
cp .env.example .env
```

Edit `.env` and fill in:

```
ZOHO_CLIENT_ID=your_client_id_here
ZOHO_CLIENT_SECRET=your_client_secret_here
```

### 3. Start the server

```bash
node server.js
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### 4. Login & Configure

1. Click **"Login with Zoho"**
2. Authorize the app in Zoho
3. Go to **Settings** tab
4. Enter your **Project Directory** (e.g., `D:/Repositories/MyProject/app`)
5. Click **Save Settings**

### 5. Browse & Analyze Bugs

1. Go to **Bugs** tab
2. Use filters to find your bug
3. Click a bug → **Analyze & Generate Fix Prompt**
4. Click **Copy to Clipboard** → paste into your AI assistant

## Per-User Flow

```
User A (Dev)                     User B (QA)
  │                                │
  ├─ Login (Zoho OAuth)            ├─ Login (Zoho OAuth)
  ├─ Settings:                     ├─ Settings:
  │   projectDir: D:/dev/ember     │   projectDir: D:/qa/project
  │   portal: logmanagementcloud   │   portal: logmanagementcloud
  │                                │
  ├─ View bugs (own Zoho tokens)   ├─ View bugs (own Zoho tokens)
  ├─ Analyze → scans D:/dev/ember  ├─ Analyze → scans D:/qa/project
  └─ Copy AI prompt                └─ Copy AI prompt
```

## Tech Stack

- **Runtime:** Node.js 8+ (zero dependencies)
- **Backend:** Pure `http` module, no Express/Koa
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Storage:** JSON files (data/users/, data/sessions.json)
- **Auth:** Zoho OAuth2 (per-user tokens)

## File Structure

```
zoho-bug-track/
├── server.js              # HTTP server (all routes)
├── package.json
├── .env                   # Your Zoho OAuth credentials
├── .env.example
├── .gitignore
├── lib/
│   ├── env-config.js      # .env loader
│   ├── user-store.js      # Per-user config & sessions
│   ├── zoho-auth.js       # Zoho OAuth2 flow
│   ├── zoho-client.js     # Per-user Zoho API client
│   ├── bug-service.js     # Bug list, details, milestones
│   ├── code-analyzer.js   # File search, grep, read
│   └── fix-prompt.js      # AI fix prompt generator
├── public/
│   ├── index.html         # SPA frontend
│   ├── style.css          # Dark theme UI
│   └── app.js             # Client-side JavaScript
└── data/                  # Created at runtime
    ├── sessions.json
    └── users/
        ├── user1.json
        └── user2.json
```
