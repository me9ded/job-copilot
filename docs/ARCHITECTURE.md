# Architecture

```
┌────────────── Chrome ─────────────────────────────────────────────────────────┐
│                                                                               │
│  Job page (enabled site, or active tab after a click)                         │
│   └─ job-detector.js  ── extract (JSON-LD → microdata → site adapter → DOM)   │
│        │  closed-shadow-root pill (score · Save · Details)                    │
│        │  runtime.sendMessage (validated, size-limited)                       │
│        ▼                                                                      │
│  Service worker (background.js) — stateless, recovers after suspension        │
│   ├─ router: sender checks + zod validation for every message                 │
│   ├─ detection → storage.session  tab:<id>                                    │
│   ├─ badge, alarms, notifications; jobContext:<id> on a successful analysis   │
│   ├─ right-click menu / Alt+Shift+J → storage.session request:autofill        │
│   ├─ scripting.registerContentScripts for granted origins only                │
│   └─ job feeds (Greenhouse / Lever / Ashby public APIs)                       │
│                                                                               │
│  Extension pages (React)                                                      │
│   ├─ popup.html       toolbar popup (grants activeTab) → opens the panel      │
│   ├─ sidepanel.html   Home · Job · Autofill · Profile · Tracker (+ Settings)  │
│   └─ dashboard.html   "Expand": jobs, tracker board, studio, prep, settings   │
│        ├─ autofill: executeScript(form-filler.js) on click, never submits     │
│        ├─ matching engine, tailoring, exports, PDF/DOCX parsing (local)       │
│        └─ AI client → Ollama / local OpenAI-compatible / your backend         │
│                                                                               │
│  chrome.storage.local   versioned schema (meta.schemaVersion), per-record keys│
└───────────────────────────────────────────────────────────────────────────────┘
                     │ only on explicit AI / sync actions
                     ▼
          backend/ (optional FastAPI) ── Anthropic · OpenAI-compatible · Ollama
```

## Source layout (`extension/src`)

| Path | Responsibility |
|---|---|
| `entrypoints/background.ts` | Service worker: startup migrations, listeners, menus, commands |
| `entrypoints/job-detector.ts` | Content script (unlisted, IIFE): extraction, SPA URL polling, on-page pill |
| `entrypoints/form-filler.ts` | Injected only on an Autofill click. Exposes `fill` (step through the form) and `answer` (one question). It also has `submit` (only in a frame whose last fill ended at the submit button), which the UI no longer calls: you press the page's Submit yourself |
| `entrypoints/{popup,sidepanel,dashboard}` | React roots: `ui/Popup.tsx`, `ui/panel/Panel.tsx` (tabs in `ui/panel/*Tab.tsx`), `ui/App.tsx` |
| `background/` | Message router, content-script registration, tab analysis, alarms, notifications |
| `lib/extraction/` | JSON-LD / microdata parsing, site adapters, section splitting, salary parsing, completeness |
| `lib/matching/` | Skill taxonomy and matchers, job / profile analysis, scoring engine, cached service |
| `lib/storage/` | Schema, migrations, repository (locks, CRUD, caches, backup / import / delete) |
| `lib/autofill/` | Field classification and filling (`fill.ts`, runs in the page: open shadow DOM, button groups, follow-up re-scan, date inputs, per-field errors), repeatable work-history / education sections (`history.ts`), per-ATS navigation hints (`sites.ts`), values, résumé choice and injection (`run.ts`), and the answer composer (`answers.ts`, runs in the extension page) |
| `lib/profile/` | Derived views of the profile: skill groups, achievements vs responsibilities, employment type, skill evidence and time spans |
| `lib/matching/fit.ts` | Plain-language reasons to apply and potential gaps from a match result |
| `lib/resume/` | PDF / DOCX text extraction, résumé parser, tailoring, diff, cover-letter template, DOCX / PDF export |
| `lib/ai/` | Provider adapters, client (limits, cache, retries, validation, usage), feature prompts, factual guard |
| `lib/discovery/` | Job-board API adapters and the refresh run |
| `ui/` | Components, hooks, views |

## Activation model

The extension has **no static content scripts and no install-time host access**.

1. **Enabled sites.** When you enable a site, Chrome grants that origin; `syncContentScripts()` registers `job-detector.js` for exactly the granted origins (`scripting.registerContentScripts`, `persistAcrossSessions`). It re-syncs on install, startup, `permissions.onAdded/onRemoved` and custom-site changes.
2. **Any other page.** Opening the toolbar popup (`openPanelOnActionClick` is off; the popup's buttons call `sidePanel.open` synchronously inside the click), the right-click **Autofill with Job Copilot** item or `Alt+Shift+J` grants `activeTab` for that tab. Autofill then injects `form-filler.js` with `scripting.executeScript`. The menu item and shortcut store `request:autofill` (tab id + time) in session storage; the panel picks it up once, within 30 s. The popup's **Autofill** button stores the same request. When Autofill fails for lack of access it stores `request:autofill-access`; opening the popup on that tab within 2 min (which grants access) shows **Continue autofill**.
3. **Restricted sites** (LinkedIn, Indeed, Glassdoor, ZipRecruiter) are refused before injection. The user pastes the posting with **Add job**.

## Service-worker lifecycle

MV3 workers are terminated after ~30 s idle. The worker keeps no in-memory state that matters:

- Per-tab detections live in `storage.session` (`tab:<id>`). UI requests ("open the panel on view X") use `ui:request`, and context-menu text uses `pending:manual`. These survive worker restarts and are cleared on navigation or tab close.
- All persistent state is in `storage.local`. Every message handler waits for the migration promise before reading.
- Alarms (feed refresh, follow-ups) are re-created idempotently on startup. Chrome may delay alarms while the machine sleeps, and a missed periodic alarm fires once on wake. The UI says so.
- **AI calls run in the extension page that requested them, not in the worker.** They can take 30–90 s and the worker might be suspended mid-request. The page also holds the user gesture needed for a permission prompt.
- Recovery is covered by a unit test (module reset between messages) and an E2E test that kills the worker through CDP and checks that detection still works.

## Messaging

`runtime.sendMessage` payloads are validated with zod (`lib/messages.ts`) before routing:

- Content-script messages must come from a tab's top frame, not an extension page. Their reported URL must match the sender tab's origin. Payloads are size-limited.
- Page messages must come from this extension's own pages (`sender.id` and URL prefix).
- Responses are always `{ ok: true, data } | { ok: false, error }`.

## Storage

`chrome.storage.local`, schema version `2` in `meta`:

| Key | Content |
|---|---|
| `profile` | Canonical profile (`version` bumps on every save → invalidates cached matches) |
| `settings` | Weights, sites, discovery, notifications, AI configuration |
| `job:<id>` | One record per job (per-record keys avoid lost updates across contexts) |
| `app:<id>` | One record per application |
| `file:<resumeId>` | The uploaded original résumé file (base64), used by autofill |
| `resumes`, `coverLetters`, `interviewPrep` | Collections |
| `aiUsage` | Daily / monthly counters and the last 40 calls |
| `matchCache`, `analysisCache`, `aiCache` | Derived data, excluded from backups |

Writes within one context are serialized with `withLock(key)`. Migrations (`lib/storage/migrations.ts`) are pure functions over a snapshot, run once at startup and never downgrade. Imports run backups from older versions through the same migrations and validate every record.

## Matching algorithm

1. **Job analysis.** Requirements are split into required and preferred, sentence by sentence (cues like "nice to have", "bonus", "preferred"). If no requirements section exists, skills are inferred from the full text and the UI says so. The analysis also extracts minimum years (the largest "N+ years" found), seniority, education level, work arrangement, sponsorship and clearance statements, and flags prompt-injection-like text.
2. **Skills.** A taxonomy of ~200 skills with aliases matches on word boundaries. Short or ambiguous names (Go, TS, Excel, Swift, Express…) need exact-case or contextual forms. A related skill in the same family gets 0.4 credit and is labelled as transferable.
3. **Components** (default weights): required skills 4.5, preferred skills 1.5, experience 1.5, seniority 1, location / arrangement 1, education 0.5. Components that don't apply to a posting are dropped and their weight is redistributed. Weights are editable in Settings.
4. **Deal-breakers.** Hard ones (sponsorship needed but unavailable, arrangement mismatch, excluded keyword, salary below your minimum) cap the score at 40 (configurable). Soft ones (experience gap, seniority, location, education, clearance) are warnings only. Missing preferred skills never cap.
5. **Output.** Score, per-component breakdown with explanations, matched / missing skills with evidence, most relevant experience, suggestions and a plain-language explanation. The UI always says that the score measures coverage of the posting, not a hiring probability.
6. **Caching.** `fingerprint | profile.version | hash(weights, cap) | taxonomyVersion`.

## AI pipeline

`runAi()` in `lib/ai/client.ts` processes each request in this order:

1. Resolve the provider for the feature. This step fails clearly if AI is off, consent is missing, the token is missing, the URL is non-local for the OpenAI-compatible option, or host permission is missing.
2. Check the cache (TTL configurable, skipped by "regenerate").
3. Enforce the daily request and monthly token limits.
4. Call the provider with a timeout (AbortController), bounded retries with backoff that honours `Retry-After`, and no retries on auth errors.
5. Extract JSON, then validate it with zod. One repair attempt follows invalid output.
6. Record usage and cost estimate, then cache the result.

Prompt-injection defence: job and profile text is placed inside `<job_posting>` / `<candidate_profile>` fences (closing tags inside the text are neutralised). The system prompt marks fenced content as untrusted data, and outputs are validated and checked:

- `checkClaims` flags numbers and skills absent from the source.
- `evidenceSupported` drops "evidence" quotes that aren't in the profile.

## Backend (optional)

FastAPI with SQLAlchemy (SQLite by default, PostgreSQL via `DATABASE_URL`):

- Bearer-token auth with constant-time comparison.
- Server-side input and output limits, plus daily and monthly limits.
- Usage log without prompt content.
- Backup store at `/v1/sync`.
- Provider adapters: Anthropic (official SDK, refusal fallback enabled), any OpenAI-compatible API, Ollama and an offline mock.

There is no CORS middleware: extension pages with host permission aren't subject to CORS, and websites have no business calling it. Redis, queues and vector databases are deliberately absent; nothing here needs them.

## Written answers (`lib/autofill/answers.ts`)

Two phases, so nothing generated reaches a page unreviewed:

1. The in-page filler fills structured fields and returns every question it has no saved answer for, with its kind (text, textarea, select, radio, button group…), the page's options and `maxlength`.
2. In the side panel, `classifyQuestion` puts each written question into a type (years of X, skill experience, work experience, project, motivation, fit, strength, cover letter, other) and finds the skills it asks about. `composeAnswer` ranks every résumé bullet (asked skill, the job's required and preferred skills, keyword overlap, measurable results, recency) and builds first-person sentences around the **verbatim** bullets ("As a {title} at {company}, I …"). Years are computed from the merged date ranges of roles that mention the skill, rounded down. If the profile doesn't mention an asked skill, there is no draft. Motivation answers contain a `[bracketed]` part that blocks **Use** until replaced. The user edits and presses **Use this answer**, which calls the filler's `answer(label, value)`.

The job used for tailoring is `jobContext:<tabId>` (session storage), written whenever a job is analyzed in that tab and kept across navigation, so Apply → form still knows the job; or one the user picks from saved jobs. Optional AI (`aiAnswerQuestion`, feature `applicationAnswers`, off by default) gets the question, the draft and its evidence inside fenced blocks. Its output goes through `checkClaims` / `evidenceSupported`; flagged numbers or skills must be acknowledged before **Use**.

## Repeatable sections (`lib/autofill/history.ts`)

Experience / education entries are found by an anchor field (job title / school) whose container holds at least three recognised fields. Each profile entry is filled into the next container; when there are none left, the section's **Add** button (by its own label or its nearest heading) is pressed and the new entry awaited. Date fields are told apart by the nearest "From / To / Start / End" text, and split month / year inputs get `MM` / `YYYY` (month names for selects). The current role ticks "I currently work here" instead of an end date. Filled controls are claimed so the generic pass doesn't touch them again.
