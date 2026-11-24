# Roadmap

Ideas, roughly in priority order. Nothing here is implemented yet.

Recently done: Workday detection and repeatable work-history filling, the side panel's Career Profile / Job / Autofill / Tracker tabs, and suggested written answers.

## Near term
- **Live verification on real ATS forms** (Workday, Greenhouse, Lever, SmartRecruiters, Ashby): today they are covered by fixtures that copy their structure, not by live sites.
- **Education entries on more layouts**, and certifications / languages sections.
- **More ATS adapters**: iCIMS, Teamtailor, Recruitee, Personio. Only public job pages, and only where the terms allow it.
- **Workable and SmartRecruiters job feeds** via their public APIs (verify the current terms and limits first).
- **Taxonomy editor**: let users add aliases and families (e.g. a niche framework) without code changes.
- **Profile from multiple résumés**: merge with conflict review.
- **Calendar export (.ics)** for follow-ups and interviews.
- **Firefox build** (WXT supports it; needs side-panel → sidebar mapping and a test pass).

## Matching
- Optional local embedding model (e.g. via Ollama) for semantic matching of requirements to experience. It would stay opt-in and deterministic scoring would remain the default and the explanation baseline.
- Learn from dismiss / save decisions to suggest weight adjustments (shown to the user, never applied silently).

## Backend
- Multi-user mode with per-user tokens and row-level separation (today it is single-user by design).
- Server-side feed ingestion with a scheduler, for users who want feeds refreshed while the browser is closed.
- End-to-end-encrypted sync: encrypt the backup in the extension with a passphrase-derived key so the server only stores ciphertext.

## Quality
- Larger extraction fixture corpus from real public postings (stored as fixtures, with permission).
- Accessibility audit with a screen reader across all views.
- Localisation.

## Explicitly out of scope
- Automating LinkedIn Easy Apply or Indeed Apply (their terms forbid it).
- Submitting applications without a per-application confirmation, bulk / unattended applying, or auto-messaging recruiters.
- Solving CAPTCHAs, signing in for the user, or simulating "trusted" input to get around sites that reject automated clicks.
- Scraping sites whose terms prohibit it, or bypassing logins, CAPTCHAs or rate limits.
- Inventing or "enhancing" résumé facts.
