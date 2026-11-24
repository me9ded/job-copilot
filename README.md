# Job Copilot

A personal, local-first job application assistant that lives entirely in Chrome (no website, no account). It keeps your whole career history as a **Career Profile** built from your résumé, fills job applications from it (including repeatable work-history sections and written questions, which it drafts from your own résumé lines and tailors to the job, for you to review), shows how well a job matches you, and tracks every application.

- **Toolbar popup**: Autofill this application, this page's match score, profile completeness, recent applications.
- **Side panel**: **Home · Job · Autofill · Profile · Tracker**, plus **Settings** (gear). **Expand** opens the full-page dashboard for Résumé Studio, interview prep, job feeds and advanced settings.

Everything works without an AI subscription. AI is optional, per feature, and only runs when you press an AI button.

```
job-copilot/
├── extension/   Chrome MV3 extension (WXT + React + TypeScript)  ← the product
├── backend/     Optional FastAPI server (hosted AI keys, limits, backup sync)
└── docs/        Architecture, permissions, privacy, troubleshooting, roadmap
```

## What it does

| Area | Features |
|---|---|
| **Career Profile** | Upload or drop a PDF, DOCX or plain-text résumé. It's read on this device; a scanned PDF with no text is detected and explained instead of producing a blank profile. It extracts contact details, every role (title, company, dates, location, type such as internship / co-op), what you did (split into achievements and responsibilities), skills grouped as languages / frameworks / tools, education, certifications and academic / personal projects. Review and edit each item in place, add or remove skill chips, choose which file Autofill attaches. Nothing is saved until you've seen it: a **Check what was found** screen lists every field and entry, editable, with what's new, what's already in your profile and what differs. For differences you choose whether to keep yours or use the résumé's; nothing you already have is overwritten silently. It is saved only when you press **Save to profile**. Nothing is ever invented. |
| **Written answers** | For questions like “Tell us about your Python experience”, “Describe your previous work experience”, “Describe a challenging project”, “Why do you want to work here?” or “How many years of Linux?”, Autofill drafts an answer from your own résumé lines, picking those most relevant to the question and to the job's requirements (systems roles surface Python / Linux work, frontend roles TypeScript / React). Each draft shows the résumé lines it used. Years are counted from the dates of roles that mention the skill. A skill your résumé doesn't mention gets **no** draft. Parts only you can write (your personal reason for applying) are marked `[like this]` and must be replaced before the answer can be used. Nothing is typed into the page until you press **Use this answer**. Optional AI polishing is off by default and its output is checked for numbers and skills that aren't in your profile. |
| **Detection** | Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday and any company careers site you add (JSON-LD, microdata, semantic HTML). Incomplete extraction is flagged and every field can be corrected. LinkedIn, Indeed, Glassdoor and ZipRecruiter are **not** read automatically because their terms prohibit it — paste the posting with **Add job** in Saved Jobs. |
| **Matching** | Job tab: **reasons to apply** and **potential gaps** in plain language, matching and missing skills, most relevant experience. 0–100 score from required skills, preferred skills, experience, seniority, location and education with configurable weights, a "How this score is calculated" breakdown, hard and soft deal-breakers, relevant experience and suggestions. A missing *preferred* skill never rules a job out. The score is coverage of the posting, **not** a hiring probability. |
| **Jobs** | Save / unsave / dismiss, duplicate detection across URLs, search, filter, sort, stale and expired indicators, last-verified time, CSV and JSON export. |
| **Job feeds** | Follow company boards via the documented public Greenhouse, Lever and Ashby job-board APIs; optional background refresh and new-match alerts. |
| **Tracker** | Side panel: Saved / Applied / Interview / Offer / Rejected with the application link and saved / applied dates. Dashboard: Discovered → Saved → To review → Preparing → Ready to apply → Applied → Interviewing → Offer / Rejected / Withdrawn. Table and Kanban board, dates, notes, contacts, follow-up reminders, résumé version and cover letter per application. "Applied" requires your explicit confirmation — nothing is ever submitted for you. |
| **Application autofill** | One click works through the whole application the way you would: opens the form behind **Apply**, types your details, picks options in dropdowns, radio buttons, checkboxes and pickers, attaches your uploaded résumé (or a generated PDF) and your saved cover letter, fills repeatable **work experience** sections (pressing **Add** for each role, ticking “I currently work here”, month / year dates, description), drafts written answers for review (above), and presses **Next / Continue** step by step. Site hints for Workday, Greenhouse, Lever, Ashby, SmartRecruiters and Workable (open shadow DOM, Yes / No button groups and follow-up questions included). It works on forms it has no site rules for: custom dropdowns (including ones rendered elsewhere on the page), type-ahead pickers, masked fields, rich-text editors, follow-up questions that appear after an answer, sections that load late, pages that reload on **Next**, and applications that open in a new tab. Every value is checked after filling and again once the page settles. Only fields that kept their value count as filled; the rest are listed under **Couldn't fill** with the reason and outlined in red. It fills embedded iframes it has access to and tells you about the ones it doesn't, with a button to allow them. Options are matched strictly ("Java" never picks "JavaScript"); when two options are equally close it asks. Screening questions (work authorization, sponsorship, salary, start date, EEO…) are answered **only** from answers you saved in Settings → Applications or in the side panel; anything else is listed for you to answer, grouped by topic. It never signs or initials for you. It stops before the final **Submit**, which you press on the page yourself, and only says the last step is yours when no required field, invalid value or page error remains. It stops at CAPTCHAs and logins, never fills passwords or ID numbers, and is off on LinkedIn, Indeed, Glassdoor and ZipRecruiter. |
| **Résumé Studio** | Import PDF / DOCX / text (parsed locally, including two-column LaTeX layouts and hyperlinked LinkedIn / GitHub words), review before saving, structured editor, tailored versions that only reorder and trim your own content, diff against the original, bullet hints, ATS-friendly DOCX / PDF / text export, cover letters. |
| **Interview prep** | Technical, role, gap, behavioral (STAR) questions and questions to ask, grounded in your experience; notes and practice tracking. |
| **AI (optional)** | Local Ollama, a local OpenAI-compatible server, or your own backend (for hosted providers). Fenced untrusted input, schema validation, a factual guard that flags numbers and skills not in your profile, caching, daily / monthly limits, timeouts, retries and a usage log. |
| **Data** | All data in `chrome.storage.local`, versioned schema with migrations, full backup export / import, delete-everything. |

## Quick start (extension)

Requirements: Node.js 20+ and Chrome 116+.

```bash
cd extension
npm install
npm run build          # → extension/dist/chrome-mv3
```

Load it:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `extension/dist/chrome-mv3`.
4. Pin Job Copilot from the puzzle-piece menu.

First run:

1. Click the toolbar icon and press **Upload résumé**. The side panel opens on **Profile**. Choose your PDF or Word file and check what was read; anything *not found* or wrong, fix with the pencil next to it.
2. Optional: **Settings** (gear in the panel) → common screening answers (work authorization, sponsorship…).
3. On a job posting: toolbar icon → **Analyze job**, or the panel's **Job** tab, to see your match, reasons to apply and gaps. **Save job** adds it to the tracker.
4. On the application: toolbar icon → **Autofill this application**. The panel's **Autofill** tab fills every step and lists **suggested answers** for written questions. Edit them, press **Use this answer**, then **Continue autofill**. Check the page and press the site's own **Submit**. Then press **I submitted it** to record it as Applied.

Chrome only lets Job Copilot into a page after you open its popup on that page (or right-click → **Autofill with Job Copilot**, or `Alt+Shift+J`). If Autofill says it has no access, click the toolbar icon while on the application and press **Continue autofill**.

Résumé Studio, interview prep, job feeds and advanced settings are in the full-page dashboard (**Expand** in the panel header).

Development with hot reload: `npm run dev` (opens a Chrome instance with the extension loaded).

### Build a ZIP

```bash
cd extension
npm run zip            # → extension/dist/job-copilot-extension-<version>-chrome.zip
```

The ZIP can be loaded by unzipping it and using **Load unpacked**, or uploaded to the Chrome Web Store developer dashboard.

### Tests

```bash
cd extension
npm run check          # typecheck + unit tests (Vitest)
npx playwright install chromium   # once
npm run e2e            # builds an E2E variant and drives the real extension in Chromium
```

The E2E suite also exercises the real backend if `backend/.venv` exists (see below). `SCREENSHOTS=/some/dir npx playwright test` captures screenshots of the popup, each panel tab and the dashboard.

## Optional backend

Only needed for hosted AI providers (so API keys never live in the extension) or backup sync. See [backend/README.md](backend/README.md).

```bash
cd backend
python3.13 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env    # set APP_TOKEN, AI_PROVIDER and keys
.venv/bin/uvicorn --factory app.main:create_app --port 8787
```

Then in the extension: **Settings → AI**, pick "Your Job Copilot backend" for a feature, enter the URL and `APP_TOKEN`, grant access and confirm the data-sharing checkbox.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data flow, service-worker lifecycle, storage schema, matching algorithm
- [docs/PERMISSIONS.md](docs/PERMISSIONS.md): every permission and why it's requested
- [docs/PRIVACY.md](docs/PRIVACY.md): what is stored, what leaves the device, and when
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)

## Costs

The extension, matching, tailoring, templates, job feeds and tracker cost nothing to run. Costs only arise if you choose them: a hosted model provider billed by that provider, and hosting for the optional backend. Job Copilot does not state any provider's prices. Enter the current prices from your provider's pricing page in **Settings → AI** to get cost estimates.
