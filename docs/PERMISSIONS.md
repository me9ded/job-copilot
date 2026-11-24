# Permissions

Job Copilot requests the smallest set of permissions that makes each feature work. Site access is **never** granted at install: every host permission is optional and requested only when you turn on a feature that needs it, and can be revoked in **Settings → Privacy** or `chrome://extensions`.

## Required permissions

| Permission | Why | What it does *not* allow |
|---|---|---|
| `storage` | Saves your profile, jobs, applications, résumés and settings in `chrome.storage.local`; per-tab detection results in `chrome.storage.session`. | — |
| `unlimitedStorage` | Your uploaded résumé file (kept for autofill), résumé text, many saved jobs and cached scores can exceed the default 10 MB quota. | — |
| `sidePanel` | Shows the main UI beside the page. | — |
| `activeTab` | When you open the toolbar popup, use the right-click menu or the keyboard shortcut, the extension may access **that one tab** until it navigates away (for **Autofill**). | Reading any other tab, or the same tab after it navigates, without another click. |
| `scripting` | Injects the job extractor into (a) sites you enabled, via a dynamically registered content script, and (b) the active tab after an `activeTab` gesture. Injects the form filler (`form-filler.js`) only when you press a Fill, Continue or Submit button; it is never registered to run on its own. If **Apply** opens another page, the filler is injected again there to continue (which needs that site enabled, or another toolbar click). | Injecting anywhere without host permission or a gesture. |
| `alarms` | Periodic job-feed refresh and hourly follow-up checks, both off by default. | — |
| `contextMenus` | Adds "Autofill with Job Copilot" to the right-click menu, which gives access to that one page and starts Autofill. | — |

Not requested: `tabs`, `history`, `webNavigation`, `webRequest`, `cookies`, `<all_urls>` host access, or any static content script. The extension never sees your browsing history. It only uses tab IDs and the URL of a tab it has access to.

## Optional permissions

| Permission | Requested when | Used for |
|---|---|---|
| `notifications` | You press **Allow notifications** in Settings → Alerts. | Follow-up reminders and strong-new-match alerts. |

## Optional host permissions

Each one is requested individually, from a button you press, with Chrome's permission prompt.

| Origin pattern | Requested when | Used for |
|---|---|---|
| `https://boards.greenhouse.io/*`, `https://job-boards.greenhouse.io/*` | Settings → Job sites → Greenhouse → Enable | Automatic detection on Greenhouse job pages |
| `https://jobs.lever.co/*` | … → Lever → Enable | Lever job pages |
| `https://jobs.ashbyhq.com/*` | … → Ashby → Enable | Ashby job pages |
| `https://apply.workable.com/*` | … → Workable → Enable | Workable job pages |
| `https://jobs.smartrecruiters.com/*` | … → SmartRecruiters → Enable | SmartRecruiters job pages |
| `https://*.myworkdayjobs.com/*` | … → Workday → Enable | Workday job pages |
| `https://boards-api.greenhouse.io/*` | Job Matches → add a Greenhouse board | Public Greenhouse Job Board API |
| `https://api.lever.co/*` | Job Matches → add a Lever board | Public Lever Postings API |
| `https://api.ashbyhq.com/*` | Job Matches → add an Ashby board | Public Ashby Job Posting API |
| `https://<host>/*` (one host at a time; declared as `https://*/*` so any single host *can* be requested) | Settings → Job sites → add a company careers site, or an AI provider / backend on an https host | That one careers site, or that one backend |
| `http://localhost/*`, `http://127.0.0.1/*` | Settings → AI → Grant access, for a local Ollama / OpenAI-compatible server / backend | Calling your local model server |

The `https://*/*` entry is **optional**: it lets Chrome prompt for a specific host you type in. Job Copilot always requests the single origin (e.g. `https://careers.example.com/*`), never the wildcard itself. Restricted job boards (LinkedIn, Indeed, Glassdoor, ZipRecruiter) are rejected when added as custom sites.

## Content Security Policy

```
script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

No remote code, no `eval` or `new Function` (the bundles are checked for both), and no inline scripts. Job descriptions are sanitized with DOMPurify (allowlist, no scripts, handlers, iframes, forms or styles) before they are displayed, and links are forced to `rel="noopener noreferrer"`.

## Toolbar popup

The toolbar icon opens a popup. Opening it is the `activeTab` gesture for the current page, so the side panel can analyze or autofill that page afterwards. Its buttons open the side panel (`sidePanel.open`, called inside the click). The permission set is unchanged by the popup.

## Keyboard shortcut

`Alt+Shift+J` (changeable at `chrome://extensions/shortcuts`) opens the side panel and autofills the current tab. It counts as an `activeTab` gesture.
