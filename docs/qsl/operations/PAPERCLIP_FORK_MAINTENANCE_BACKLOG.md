# Paperclip Fork Maintenance Backlog

## Status

Deferred until the QSL Security company completes its first governed end-to-end workflow.

## Known Conditions

- The fork contains QSL-specific implementation and doctrine.
- The long-lived branch is substantially behind upstream.
- QSL-specific branches must not be proposed against upstream by default.
- Small upstream contributions should be isolated on clean branches based on current upstream master.

## Future Work

1. Audit remotes and branch relationships.
2. Back up all QSL-only commits and tags.
3. Identify changes that should remain fork-specific.
4. Identify generally useful changes suitable for isolated upstream pull requests.
5. Decide whether to:
   - rebase the current integration branch,
   - create a fresh QSL integration branch from current upstream,
   - or move QSL extensions into a separate repository/plugin layer.
6. Document a repeatable upstream-sync procedure.
7. Add branch protection where appropriate.

## Trigger

Begin this maintenance only after the current revenue-focused security demonstration milestone is complete or when upstream incompatibility blocks development.

## Fork Patches Applied (upstream candidates)

| Date | File | Change | Why | Upstream candidate? |
|---|---|---|---|---|
| 2026-07-27 | `server/src/services/plugin-loader.ts` | Wrap `DEV_TSX_LOADER_PATH` in `pathToFileURL(...).href` for the worker `--import` flag | Bare Windows path crashes every plugin activation on win32 (`ERR_UNSUPPORTED_ESM_URL_SCHEME`); blocks all plugin use on Windows | **Yes** — 3-line Windows compat fix with repro (install any local-path plugin on Windows) |
| 2026-07-27 | `packages/plugins/plugin-email/` (new) | QSL Email Connector plugin (workspace package, not a core change) | Email Company mail I/O per completion mission | No — QSL-specific; candidate for separate distribution later |
| 2026-07-27 | `skills/install-catalog` 422 bug | **Not fixed — observed and documented** (Gotcha #9) | `install-catalog` fails with empty-body 422 for `issue-triage`/`task-planning` on this build | Yes — needs upstream bug report with repro |
