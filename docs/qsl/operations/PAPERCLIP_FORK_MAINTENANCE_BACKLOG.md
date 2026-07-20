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
