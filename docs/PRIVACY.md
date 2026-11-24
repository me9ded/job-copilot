# Privacy

Job Copilot has no account, no analytics, no telemetry and no Job Copilot server. Unless you run the optional backend yourself, nothing you enter is sent anywhere except the services listed below, and only when you trigger them.

## What is stored, and where

All data lives in your Chrome profile (`chrome.storage.local`), on this device:

- Profile: contact details, summary, skills, experience, education, projects, certifications and job preferences
- Résumé versions: the extracted text of uploaded originals, plus tailored versions
- The uploaded PDF / DOCX file itself (so autofill can attach your own file). It's deleted with its résumé version, and included in backups
- Saved jobs: posting text and URL, your notes and corrections
- Applications: status history, dates, notes, contacts, follow-ups
- Cover letters and interview-prep notes
- A local **autofill activity log**: the last 50 runs, each with the time, site host, job title and company, how many fields were filled and why it stopped. It never contains anything typed into a form. It's shown on the panel's Home tab, included in backups and removed by Delete all data
- Settings (including the values you corrected for form autofill and your saved screening-question answers, which may include EEO answers you chose to save), AI usage counters (no prompts or outputs), and caches of match scores and AI results

`chrome.storage.session` holds the detection result for each open tab (cleared when the tab navigates or closes, and when Chrome exits), the last autofill report for a tab, and the job last analyzed in a tab (kept when the tab navigates, so a job's application form knows which job it is for; removed when the tab closes or Chrome exits).

Chrome Sync is **not** used.

## What is read from web pages

- On sites you **enabled** in Settings → Job sites, the extractor runs on page load and reads the job posting (title, company, location, description, salary, dates). For pages that aren't job postings, nothing from the page is kept, only a "no job found" marker for that tab in session storage.
- On any other site, a page is touched only when you press **Autofill** (or use the shortcut or right-click menu), and only that tab.
- LinkedIn, Indeed, Glassdoor and ZipRecruiter pages are never read automatically.
- Browsing history and the URLs of pages you visit are never collected.

Job text is treated as untrusted: it is sanitized before display and never executed.

## What is written into web pages

Only when you press **Autofill** (side panel or on-page button), choose **Autofill with Job Copilot** from the right-click menu or press `Alt+Shift+J`, and only in that tab:

- Your profile details (name, email, phone, location, links, current title and company, education), the résumé file you chose and any cover letter saved for that job are put into matching **empty** fields.
- Written questions ("Tell us about…", "Why do you want…") get a **suggested answer** in the side panel, built from your own résumé lines. It is put into the page only when you press **Use this answer**, after you've read and edited it. Drafts never claim a skill your profile doesn't list, and parts only you can write must be replaced first.
- Screening questions (work authorization, sponsorship, salary, start date, how you heard, EEO / demographic questions…) are answered **only** with answers you saved in Settings → Applications or in the side panel. Nothing is guessed; unanswered questions are listed for you. "I agree / I certify" boxes are ticked only if you turned that on.
- It presses the page's own buttons the way you would: **Apply** to open the form, **Next / Continue** between steps, and options in pickers. It never presses the final **Submit**: you check the page and press it yourself.
- It stops at CAPTCHAs and sign-in pages, and never fills passwords, ID or Social Security / Insurance numbers, dates of birth or payment details.
- The values stay in the extension's isolated content-script world until they are put into the form. Once there they belong to that page, as if you had typed them, and the site may read them before you submit.
- Autofill is refused on LinkedIn, Indeed, Glassdoor and ZipRecruiter.

## What leaves your device, and when

| Data | Destination | When |
|---|---|---|
| A company identifier (e.g. `acme`) | `boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com` | When you add a job feed and when it refreshes (manually, or on the schedule you enabled). No profile data is sent. |
| Job text + relevant profile text | The AI provider **you** configured for that feature | Only when you press an AI button (e.g. "Draft with AI", or "Improve with AI" on a suggested answer, which also sends that question and draft). Off by default for every feature. |
| Full backup (profile, résumés, jobs, applications, settings, **without** the backend token) | Your own backend | Only when you press **Upload backup**. |

For AI:
- **Ollama / local OpenAI-compatible server**: the request goes to a server on your own machine.
- **Your backend**: you must tick a consent checkbox before anything is sent. The backend forwards the request to the provider it is configured with (e.g. Anthropic or OpenAI). That provider's own data policy then applies. The backend stores only usage counts (feature, model, token counts, errors), never prompts or outputs.
- Provider API keys never live in the extension. Hosted providers are reached only through your backend.

## Your controls

- **Settings → Data → Export backup**: a complete JSON copy of your data
- **Settings → Data → Delete all data**: removes everything from this browser (typed confirmation)
- **Settings → Privacy**: lists granted permissions and site access, with **Revoke** buttons
- Removing the extension deletes all of its local data

## Factual integrity

Job Copilot never adds employers, titles, dates, skills, metrics or credentials to your résumé. Tailoring only reorders, selects and trims your existing content. AI suggestions are checked against your profile; numbers and skills that don't appear in it are flagged, and nothing is applied without your explicit choice.
