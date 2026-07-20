---
name: deploy-bookmark-checkin
description: Deploy, repair, migrate, or validate a private Windows Chrome bookmark daily check-in automation. Use when Codex must inspect compatibility, collect a structured setup questionnaire, configure bookmark folders and login recovery, adapt public or unknown check-in sites, install hidden scheduling, and verify end-to-end results without exposing credentials.
---

# Deploy bookmark check-in

Use the repository root that contains this skill. Keep every user-specific value in ignored local files.

## Workflow

1. Run `scripts/Test-Environment.ps1` without changing the machine.
2. Classify findings as blocking, optional, or ready. Explain each missing capability and its effect. Ask the user to choose whether to install, skip, or use the documented fallback before changing the environment.
3. Read [questionnaire.md](references/questionnaire.md). Ask only unanswered questions, at most three at a time. Never request plaintext credentials, cookies, tokens, passkeys, PINs, or recovery codes.
4. Copy `setup/answers.example.json` to ignored `setup/answers.json` and record non-secret answers. Run `scripts/Initialize-Checkin.ps1`.
5. Run the bookmark dry run. Show the two mobile-folder comparison, deduplicated site count, and any ambiguous profile selection before browsing sites.
6. Initialize the isolated Chrome profile. Keep the browser visible only for the initial user-approved login pass; scheduled runs must use the configured off-screen mode.
7. Run one complete check-in without notification. For every unresolved site, first retry and inspect stable page evidence. Use built-in public rules, then generic discovery, then a local adapter. Write local rules only to ignored config files.
8. Require authoritative success evidence. A click, redirect, empty error, or window title is insufficient.
9. Read [acceptance.md](references/acceptance.md), run all acceptance checks, then install scheduling. Use the Windows task when permitted; otherwise use the user-level hidden scheduler only if the user accepted the fallback.
10. Run `scripts/Scan-PublicSafety.ps1`. Report installed mode, schedule, site totals, unresolved sites, notification behavior, and recovery instructions.

Read [compatibility.md](references/compatibility.md) when preflight is not fully ready. Read [site-adapters.md](references/site-adapters.md) when adding or reviewing site rules.
