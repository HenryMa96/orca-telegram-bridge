# Publishing Guide (Agent Runbook)

This document is a self-contained checklist for preparing and publishing `orca-telegram-bridge` to a public GitHub repository so it can be automatically indexed by the **Orca Community Plugins** directory (`https://orca.dev/plugins`).

> **Note on Official vs. Community Catalogs**
> - `stablyai/orca-plugins` only accepts first-party plugins maintained by Stably (`CONTRIBUTING.md` explicitly rejects external PRs).
> - Third-party plugins are published via public GitHub repositories and automatically indexed into `stablyai/orca-community-plugins` and `https://orca.dev/plugins` — no PR or manual form is required.

---

## 1. Pre-Publish Audit (Privacy & Git History)

Before pushing to a public GitHub repository, verify:

1. **Git author / committer identity**:
   - Check `git log --format="%h %an <%ae> | %cn <%ce> | %s"`.
   - Ensure no corporate email or unwanted personal identity appears in commit history. If needed, update local git identity (`git config user.name` / `git config user.email`) and amend/squash before pushing publicly.
2. **No secrets or personal data in files**:
   - Confirm no Telegram BotFather tokens, proxy credentials, personal Telegram numeric IDs, or private local filesystem paths exist in any tracked file.
   - Verify `.gitignore` still excludes `node_modules/`, `.orca/`, `.env`, and `*.log`.

---

## 2. Manifest (`orca-plugin.json`) Updates for Public Release

Current manifest already includes:
- `"manifestVersion": 2`
- `"id": "telegram-bridge"`
- `"execution": "trusted-worker"`
- `"engines": { "orca": ">=1.4.248" }`
- `"license": "MIT"` (matching `./LICENSE`)
- `"icon": "assets/icon.png"` (256×256 static PNG)
- Minimal capabilities: `storage:own`, `secrets:own`, `settings:own`, `notifications:show`

Before tagging on GitHub, update/add these fields in `orca-plugin.json`:

1. **Repository & Homepage** (recommended):
   ```json
   "repository": "https://github.com/<owner>/<repo>",
   "homepage": "https://github.com/<owner>/<repo>"
   ```
2. **Author** (optional):
   ```json
   "author": {
     "name": "<owner>",
     "url": "https://github.com/<owner>"
   }
   ```
3. **Publisher** (check target rule):
   - With `engines.orca >= 1.4.246`, Orca derives `publisher` from the GitHub repository owner if omitted.
   - `https://orca.dev/plugins/add/` also mentions setting `"publisher"` to the GitHub repository owner; setting `"publisher": "<owner>"` (exact match, not starting with `orca-` / `stablyai`) satisfies both.
4. **Version**:
   - Confirm `"version"` (e.g. `"0.1.0"` or `"1.0.0"`) matches the Git tag `v<version>` you will push.
   - Once indexed in `releases.lock.json`, a published version's commit and `contentHash` are immutable — always bump `version` for subsequent releases.
5. **Optional Store Artwork**:
   - `cover`: 16:10 image (recommended `1600x1000`, minimum `800x500`, max `1024 KB`, PNG/JPEG/WEBP, static) with `alt`.
   - `screenshots`: up to 6 images (minimum `1280x800`, max `1536 KB` each, static) with `alt`.

---

## 3. Local Validation & Checks

Run all four Orca CLI checks from the repository root and confirm every command succeeds (exit code `0`):

```sh
orca plugin validate . --json
orca plugin test . --json
orca plugin check . --json
orca plugin release-entry . --json
```

If TypeScript is installed locally, also run:

```sh
npx tsc -p . --noEmit
```

---

## 4. Publish to GitHub

1. Create a **public**, non-fork, non-archived GitHub repository (e.g. `https://github.com/<owner>/orca-telegram-bridge`).
2. Add the GitHub remote and push `main`:
   ```sh
   git remote add github https://github.com/<owner>/orca-telegram-bridge.git
   git push -u github main
   ```
3. Create and push an annotated version tag matching `version` in `orca-plugin.json`:
   ```sh
   git tag -a v0.1.0 -m v0.1.0
   git push github v0.1.0
   ```
4. Add the `orca-plugin` repository topic:
   ```sh
   gh repo edit <owner>/orca-telegram-bridge --add-topic orca-plugin
   ```
5. Check indexing status (typically updates within ~1 hour):
   - Visit `https://orca.dev/plugins/<owner>/orca-telegram-bridge`
   - Once indexed, users can install via:
     ```sh
     orca plugin install <owner>.telegram-bridge
     ```
     or directly from GitHub:
     ```sh
     orca plugin install <owner>/orca-telegram-bridge
     ```
