---
name: release-via-brat
description: Cut a new BRAT-installable release of the obsidian-granola-plugin fork. Use when the user wants to publish, release, deploy, tag, cut a version, or make changes installable via BRAT. Handles version bumping, tagging, local packaging, and manual GitHub release creation (since Actions are disabled on the fork).
---

# Release obsidian-granola-plugin via BRAT

Publish a new beta version of `VictorChenLi/obsidian-granola-plugin` so it can be installed or auto-updated by BRAT inside Obsidian. Actions are disabled on this fork, so we build locally and upload release artifacts manually with `gh release create`.

## Context

- **Fork repo**: `VictorChenLi/obsidian-granola-plugin` (the `origin` remote).
- **Upstream**: `philfreo/obsidian-granola-plugin` — not used for releases.
- **Plugin id**: `granola-meetings-simple-sync` — kept identical to upstream so BRAT installs into the same `.obsidian/plugins/granola-meetings-simple-sync/` folder and preserves the user's OAuth tokens and settings (`data.json`).
- **Tag convention**: no `v` prefix (Obsidian community plugin requirement). Use `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-beta.N`.
- **Tag must match `manifest.json.version` exactly** — BRAT enforces this.
- **Actions on the fork**: **enabled**. `.github/workflows/release.yml` runs automatically on tag push and is **idempotent** — it will create the release if it doesn't exist, or upload assets with `--clobber` if it does. So you can either:
  - **Auto path (recommended)**: push the tag and let the workflow handle the release entirely. Skip step 6 (local package) and step 7 (manual release create) below — just push the tag and verify in step 8.
  - **Manual path**: run `npm run package` + `gh release create` yourself, then push the tag. The workflow will see the release already exists and upload its own copy of the assets with `--clobber` (harmless, fully overwrites with identical content).

## Workflow

Copy this checklist and tick items as you go. Steps 6 and 7 are **optional** when the GitHub Actions workflow handles it — do them only if you need a release out faster than the workflow's ~1 minute build time, or to write custom release notes (the workflow uses `--generate-notes` only).

```
Release checklist:
- [ ] 1. Pick next version number
- [ ] 2. Merge feature branch(es) into main
- [ ] 3. Bump version (manifest.json, versions.json, package.json)
- [ ] 4. Commit version bump and push main
- [ ] 5. Create and push git tag (Actions workflow runs on push)
- [ ] 6. (optional) Build artifacts locally (npm run package)
- [ ] 7. (optional) Create GitHub release with gh release create + custom notes
- [ ] 8. Verify release and tell user how to update in BRAT
```

### 1. Pick the next version

- Inspect the current version: read `manifest.json` or run `cat manifest.json | jq -r .version`.
- For experimental / in-flight work, use a pre-release tag like `2.1.0-beta.3`.
- For stable releases, bump `major.minor.patch`.

### 2. Merge feature branch(es) into main

If work is on a `cursor/*` branch:

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff cursor/<branch> -m "Merge branch 'cursor/<branch>'"
```

Never merge with `--ff-only` — the `--no-ff` commit makes the merge visible in history.

### 3. Bump the version

```bash
npm version <NEW_VERSION> --no-git-tag-version
```

This updates `package.json`, `package-lock.json`, and — via `version-bump.mjs` — `manifest.json`. It runs `git add manifest.json versions.json` automatically, but **does not commit**.

**Important quirk**: `version-bump.mjs` only adds an entry to `versions.json` when the new `minAppVersion` isn't already a value in the map. Since `minAppVersion` is `"1.0.0"` (already mapped), `versions.json` is **not** updated by the script. Append the new version manually:

```bash
# Read the current file, then overwrite with the new entry appended.
# Keep keys in release order (oldest -> newest).
```

Edit `versions.json` with `StrReplace` or `Write` so it looks like:

```json
{
	"1.0.0": "1.0.0",
	"2.0.3": "1.0.0",
	"2.1.0-beta.1": "1.0.0",
	"2.1.0-beta.2": "1.0.0",
	"<NEW_VERSION>": "1.0.0"
}
```

### 4. Commit version bump and push main

```bash
git add manifest.json versions.json package.json package-lock.json
git commit -m "Bump version to <NEW_VERSION>"
git push origin main
```

### 5. Create and push the tag

```bash
git tag <NEW_VERSION>
git push origin <NEW_VERSION>
```

**No `v` prefix**. The tag name must match `manifest.json.version` exactly.

### 6. Build artifacts locally

```bash
rm -rf release     # clean stale artifacts so eslint doesn't trip on them
npm run package
```

This runs the full `build` then assembles `release/granola-meetings-simple-sync/{main.js,manifest.json,versions.json}` and zips it to `release/granola-meetings-simple-sync.zip`. After running, these files exist at the repo root:

- `main.js` — the built plugin bundle
- `manifest.json` — plugin manifest (not rebuilt, but shipped as-is)
- `release/granola-meetings-simple-sync.zip` — for users doing manual install

### 7. Create the GitHub release

Use `gh release create`. Always pass `--repo VictorChenLi/obsidian-granola-plugin` because `gh` defaults to upstream for this checkout (since it's a fork of `philfreo/obsidian-granola-plugin`).

Use `--prerelease` for any beta. Write notes via HEREDOC so formatting is preserved.

Template:

```bash
gh release create <NEW_VERSION> \
  --repo VictorChenLi/obsidian-granola-plugin \
  --title "<NEW_VERSION>" \
  --prerelease \
  --notes "$(cat <<'EOF'
## What's new

- Bullet describing the change.
- Another bullet.

## Install / update via BRAT

If you already track `VictorChenLi/obsidian-granola-plugin` in BRAT, run
"Check for updates to all beta plugins and themes" to pull this version.
Otherwise add it as a new beta plugin.
EOF
)" \
  main.js manifest.json release/granola-meetings-simple-sync.zip
```

Omit `--prerelease` for stable releases.

### 8. Verify the release

```bash
gh release view <NEW_VERSION> --repo VictorChenLi/obsidian-granola-plugin \
  --json name,tagName,isPrerelease,assets \
  --jq '{name, tagName, isPrerelease, assets: [.assets[].name]}'
```

Expect `assets` to contain at least `main.js` and `manifest.json` (BRAT's required files) plus the zip.

Return the release URL to the user:
`https://github.com/VictorChenLi/obsidian-granola-plugin/releases/tag/<NEW_VERSION>`

## Tell the user how to update in Obsidian

Provide these exact steps:

1. In Obsidian, open **Settings → BRAT**.
2. If this is the first install:
   - If the upstream plugin (`philfreo/obsidian-granola-plugin`) is currently tracked in BRAT, **remove it from BRAT's list first** (BRAT → Remove plugin from BRAT list). Do **not** uninstall the plugin itself from Community plugins — that would wipe their OAuth tokens and settings.
   - BRAT → **Add Beta plugin** → enter `VictorChenLi/obsidian-granola-plugin`.
3. If BRAT is already tracking the fork:
   - Run BRAT's "Check for updates to all beta plugins and themes".
   - Or, if they installed with "frozen version", click the edit pencil next to the entry and change the version.
4. Reload the plugin (toggle off/on in Community plugins, or restart Obsidian).

## Common gotchas

### `gh` uses the wrong repo by default

`gh repo view` / `gh release` / `gh run list` default to `philfreo/obsidian-granola-plugin` because that's what the fork points at as its parent. **Always pass `--repo VictorChenLi/obsidian-granola-plugin`** to release-related `gh` commands, or query the API explicitly with `gh api repos/VictorChenLi/obsidian-granola-plugin/...`.

### `versions.json` didn't update

The `version-bump.mjs` script guards against adding duplicate `minAppVersion` entries:

```js
if (!Object.values(versions).includes(minAppVersion)) {
  versions[targetVersion] = minAppVersion;
  writeFileSync("versions.json", ...);
}
```

Because `minAppVersion` is `"1.0.0"` and `"1.0.0"` is already a value, the script never appends. Always manually edit `versions.json` after `npm version`.

### Linter fails on `release/` dir

After `npm run package`, `release/granola-meetings-simple-sync/main.js` exists in the tree. ESLint's project service rejects it. Run `rm -rf release` before `npm run lint` if you need to lint, or run `lint` before `package`.

### Forgot to remove upstream from BRAT first

If the user installed via BRAT tracking `philfreo/obsidian-granola-plugin`, BRAT will keep overwriting our fork's `main.js` with upstream releases. The fix is to remove the upstream entry from BRAT (not uninstall the plugin), then add `VictorChenLi/obsidian-granola-plugin`.

### Plan says "unlimited history" but `time_range` enum only has 3 values

This is a Granola MCP server quirk (see `src/mcp-client.ts` — `UNLIMITED_TIME_RANGE` sentinel). The server only advertises `this_week / last_week / last_30_days` but accepts omitted `time_range` as unbounded on paid plans. No release impact — just don't promise more granularity than the server exposes.

## Actions are enabled

`.github/workflows/release.yml` runs on every tag push and is idempotent (uses `gh release create` if missing, `gh release upload --clobber` if the release already exists). For most releases, just push the tag and verify with step 8. If you want richer release notes than `--generate-notes`, do steps 6–7 manually before the workflow runs (or after — the workflow's `--clobber` upload won't change the body).

## Quick reference: one-shot release command

Once version is chosen and code is merged to main, the minimum commands for a release:

```bash
# From repo root, on main, with a clean tree.
NEW_VERSION=2.1.0-beta.X

npm version $NEW_VERSION --no-git-tag-version

# Manually append "$NEW_VERSION": "1.0.0" to versions.json (see step 3).

git add manifest.json versions.json package.json package-lock.json
git commit -m "Bump version to $NEW_VERSION"
git push origin main
git tag $NEW_VERSION
git push origin $NEW_VERSION

rm -rf release
npm run package

gh release create $NEW_VERSION \
  --repo VictorChenLi/obsidian-granola-plugin \
  --title "$NEW_VERSION" \
  --prerelease \
  --notes "Release notes here." \
  main.js manifest.json release/granola-meetings-simple-sync.zip
```
