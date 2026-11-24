# Troubleshooting

### A job page isn't detected
- Check that the site is enabled in **Settings → Job sites** (the badge there should say *Enabled*). Company careers sites must be added individually.
- On any other site, paste the posting in the side panel's **Job** tab (**Paste a job**) or **Tracker → Add job**.
- Some careers pages load the posting after a delay. The detector retries at 1.5 s and 4 s and watches for in-page navigation.
- If fields are missing, the job shows *Extraction incomplete* in Saved Jobs. Use **Correct details**, and your corrections are kept on later visits.

### "Automatic reading is off on LinkedIn" (or Indeed, Glassdoor, ZipRecruiter)
This is intentional. Those sites' terms prohibit automated extraction by add-ons. Paste the posting in the side panel's **Job** tab or **Tracker → Add job**.

### Autofill
- **"Chrome hasn't let Job Copilot into this page yet"**: Chrome only lets Job Copilot into a page after you open its toolbar popup on that page, right-click the page → **Autofill with Job Copilot**, or press `Alt+Shift+J`. Pressing Autofill in an already-open panel isn't enough. After that message, click the toolbar icon (within two minutes) and press **Continue autofill**. Access ends when the page moves to another site, so for applications that continue on another site, click the icon again there, or enable the site in the dashboard's **Settings → Job sites** for permanent access.
- **The icon opens a small popup, not the panel**: that's expected. Use **Autofill this application** or **Open side panel** in it. If nothing opens after an upgrade, reload the extension in `chrome://extensions`.
- **It stopped at "Your answers"**: those are questions with no saved answer. Written ones get a **suggested answer** built from your résumé: read it, edit it, press **Use this answer**. Choices (Yes / No, dropdowns) list the page's own options: pick one and press **Fill in**. Then **Continue autofill**. Tick "Remember" to answer the same question automatically next time; saved answers are in the panel's **Settings**.
- **No suggested answer for a question**: the question asks about something your profile doesn't mention (for example a skill you didn't list). Job Copilot won't claim it. Write it yourself, or add the experience to your profile first.
- **"Use this answer" is greyed out**: replace the `[bracketed]` part (only you know why you want the job), or shorten the answer below the page's character limit.
- **Work experience entries weren't filled**: the section needs an **Add** button labelled with the section ("Add Work Experience", or "Add" under a Work Experience heading) and job title / company fields. Unusual layouts may not be recognised; fill those entries by hand. Autofill never deletes entries the page already has.
- **"the form didn't move to the next step"**: the page rejected something (the messages are shown). Fix it on the page and press **Autofill** again.
- **CAPTCHA or sign-in**: do it yourself on the page, then press **Autofill** again. Job Copilot never solves CAPTCHAs or signs in for you.
- **A dropdown wasn't chosen**: the saved answer didn't match any option closely. Use the option's wording, e.g. "Decline to self-identify".
- **Wrong first / last name split**: correct it once under **Answers for application questions → What Autofill types into forms**. It's remembered.
- **Form inside a frame isn't filled**: frames from another site need that site enabled in Settings → Job sites.
- **Résumé not attached**: the upload field may already have a file, accept a different type, or be a custom widget without a file input. Attach it on the page yourself.
- **Some sites ignore the clicks**: a few sites only accept "trusted" input from a real mouse or keyboard. On those, finish the remaining steps yourself.

### Résumé title / company came out swapped or empty
Two-line headers (e.g. "Title ⇥ Dates" over "Company ⇥ City, ST") are supported for PDF and DOCX. If a role is still wrong, press the pencil next to it in the side panel's **Profile** tab and fix it. Your edits are kept.

### The on-page button doesn't appear
It only appears on enabled sites and can be turned off in **Settings → Job sites → On-page button**. Results still show in the toolbar badge and in Saved Jobs.

### Résumé upload fails
- **Legacy `.doc`**: save it as `.docx` or PDF.
- **"No selectable text"**: the PDF is a scanned image. Paste the text instead.
- **Password-protected PDF**: remove the password or upload a DOCX.
- Files over 10 MB are rejected.
Review the extracted result before saving; nothing is stored until you choose *Add to my profile* or *Replace profile*.

### The score seems off
Open **How this score is calculated** under the score. It shows each component's score, weight and reason. Common causes:
- Your profile's skills list is missing something you have. Add it in Résumé Studio → Profile.
- The posting had no explicit requirements section, so requirements were inferred. The panel says *inferred* in that case.
- A hard deal-breaker capped the score; it's listed in red.
You can change the weights and the cap in **Settings → Matching**.

### AI buttons don't appear
AI is off by default. Choose a provider per feature in **Settings → AI**.

### AI errors
| Message | Fix |
|---|---|
| *Allow Job Copilot to reach http://localhost…* | Press **Grant access** (Chrome asks once per origin). |
| *Could not reach the AI provider* | Is Ollama / your server running? For Ollama, start it with `OLLAMA_ORIGINS=chrome-extension://*` so it accepts requests from the extension. |
| *The OpenAI-compatible option is for local servers only* | Hosted providers must go through your backend so keys stay server-side. |
| *Confirm in Settings → AI that you agree…* | Tick the backend consent checkbox. |
| *check your backend token* | The access token doesn't match the backend's `APP_TOKEN`. |
| *Daily AI request limit reached* | Raise the limit in Settings → AI, or wait until tomorrow. |
| *did not return valid JSON* | Small local models sometimes do this. Try again or use a larger model. |

### Background refresh or reminders don't fire on time
Chrome runs alarms only while it's open and may delay them while the computer sleeps. A missed run happens once on wake. Use **Refresh** in Job Matches for an immediate run.

### Job feeds: "Board not found"
Use the identifier from the board URL: `job-boards.greenhouse.io/<id>`, `jobs.lever.co/<id>`, `jobs.ashbyhq.com/<id>`.

### Starting over
**Settings → Data → Export backup** first, then **Delete all data**. Removing the extension also deletes its data.

### Backend
- `APP_TOKEN … placeholder` / `at least 24 characters` at startup: generate one with `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
- `AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY`: set the key in `.env`.
- 502 *API key was rejected*: the provider rejected the server's key (this is not the extension token).
