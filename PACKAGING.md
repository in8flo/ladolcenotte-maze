# Packaging the Module for The Forge

The Forge installs modules from a **public manifest URL**, not by copying files.
This repo is set up so that publishing is: *bump version → push a tag → done*.

> **Replace `OWNER`** in `foundry/module.json` (the `url`, `manifest`, and
> `download` fields) with the GitHub account/org that will host this repo. The
> repo **must be public** — The Forge fetches the manifest and zip anonymously,
> and private-repo release assets are not anonymously downloadable.

The URLs use the `releases/latest/download/...` pattern, so they never change
between releases.

---

## How the pieces fit

`foundry/module.json` declares:

```json
"manifest": "https://github.com/OWNER/ladolcenotte-maze/releases/latest/download/module.json",
"download": "https://github.com/OWNER/ladolcenotte-maze/releases/latest/download/module.zip"
```

The included GitHub Actions workflow (`.github/workflows/release.yml`) runs on
every `v*` tag push and publishes a Release with two assets:

- **module.json** — the manifest (copied straight from `foundry/`)
- **module.zip** — the module files with `module.json` at the **zip root**

The Forge reads the manifest, downloads the zip, and extracts it to
`modules/ladolcenotte-maze/`.

---

## First-time publish

### Option A — GitHub web + git (recommended)

1. Create a new **public** repo on GitHub named **`ladolcenotte-maze`** (empty,
   no README/license — this repo already has files).
2. Edit `foundry/module.json` and replace the three `OWNER` placeholders with
   your GitHub username.
3. From `C:\Users\Mike\Downloads\ledmaze`:

   ```powershell
   git add -A
   git commit -m "La Dolce Notte maze module — overlay phase"
   git branch -M main
   git remote add origin https://github.com/OWNER/ladolcenotte-maze.git
   git push -u origin main
   ```

4. Tag and push the release:

   ```powershell
   git tag v1.1.0
   git push origin v1.1.0
   ```

5. Watch **Actions** in the GitHub repo — the "Release module" workflow builds
   `module.zip` and creates the **v1.1.0** Release with both assets.
6. Confirm the manifest resolves (paste in a browser):
   `https://github.com/OWNER/ladolcenotte-maze/releases/latest/download/module.json`

### Option B — manual zip (no Actions)

1. Replace `OWNER` in `foundry/module.json`.
2. Zip the **contents of `foundry/`** so `module.json` is at the zip root:

   ```powershell
   Compress-Archive -Path "C:\Users\Mike\Downloads\ledmaze\foundry\*" `
     -DestinationPath "C:\Users\Mike\Downloads\ledmaze\module.zip" -Force
   ```

3. Create a GitHub Release tagged `v1.1.0` and upload **both** `foundry/module.json`
   and `module.zip` as assets.

### Option C — Forge Bazaar upload

If your Forge tier allows custom module uploads: package `foundry/` as a zip
(module.json at the root, as in Option B) and upload it via the Forge Bazaar's
"Install from file" / custom module flow. No GitHub needed, but you lose the
one-command update path.

---

## Installing on The Forge

In your Forge-hosted Foundry: **Game Settings → Manage Modules → Install Module**
→ paste the manifest URL → **Install**. Full walkthrough in `TESTING-FORGE.md`.

---

## Shipping an update later

1. Bump `"version"` in `foundry/module.json` (e.g. `1.1.1`).
2. Commit, then tag with the **same** version prefixed by `v` and push the tag:

   ```powershell
   git commit -am "Fix: …"
   git tag v1.1.1
   git push && git push origin v1.1.1
   ```

3. In Foundry: **Manage Modules → Update** (it re-reads the manifest).

> Keep the tag (`v1.1.1`) and the `module.json` `version` (`1.1.1`) in sync.
