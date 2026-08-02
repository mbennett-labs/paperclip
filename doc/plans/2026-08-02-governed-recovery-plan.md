# Governed Recovery Plan — Duplicate Cleanup and Production Baseline

**Date:** 2026-08-02
**Type:** Executed recovery runbook
**Status:** Complete (duplicate cleanup); deferred (plugin upgrade, Gmail intake, historical replay)

---

## Canonical Use Rule

For all live Paperclip operations, use only:

`https://paperclip.quantumshieldlabs.dev`

All production work must use company:

`f5609cfe-37ff-4061-a3c7-35ae55dbcc2b`

## Anti-Duplication Rules

1. Before creating or onboarding a company, list existing companies first.
2. Never repeat the onboarding wizard when the canonical company already exists.
3. Production must have exactly one canonical company for this operation.
4. Local and staging instances must use different instance IDs, ports, directories, databases, and visible environment labels.
5. Local or staging UIs must display `LOCAL/STAGING — NOT PRODUCTION`.
6. No local or staging environment may use the production domain or production Gmail credentials.
7. The production deployment directory must never be reused as a staging build directory.
8. Duplicate cleanup must use the official transactional Paperclip application pathway, never ad hoc raw SQL.
9. Before consequential production changes, create and verify a named backup.
10. QSL Chronicle should point to these repository-local records rather than duplicating full technical evidence.

## Executed Recovery — Duplicate Cleanup

### Pre-mutation backup

Created 2026-08-02 15:55:06 UTC via `systemctl start paperclip-thebinmap-prod-backup.service`:

| Field | Value |
|---|---|
| **Filename** | `thebinmap-email-ops-prod-20260802-155506Z.tar.gz` |
| **SHA-256** | `0d52eba127ecbf7396bc9001de70c316337be0e086921b98560adc90c0d87b20` |
| **Size** | 24,822,794 bytes |
| **Integrity** | Passed |

### Target identification

Pre-deletion verification confirmed three empty duplicate companies (all named "TheBinMap Email Operations"):

| # | ID | Created (UTC) | Issues | Agents | Projects |
|---|---|---|---|---|---|
| 1 | `92f59c70-ee17-43c7-bbe6-33befa707ba2` | 2026-07-25 18:07:17 | 0 | 0 | 0 |
| 2 | `f74a8fe8-2263-4ae0-9240-0ab2b076b96f` | 2026-07-25 18:33:36 | 0 | 0 | 0 |
| 3 | `1f413928-089e-46d4-809b-82909ad4f959` | 2026-07-25 18:48:34 | 0 | 0 | 0 |

Canonical company `f5609cfe-37ff-4061-a3c7-35ae55dbcc2b` verified intact: THE-1 (blocked), THE-2 (todo), CEO agent (error).

### Deletion method

Official transactional Paperclip CLI:

```bash
pnpm paperclipai company delete <id> --by id --yes --confirm <id>
```

This calls `DELETE /api/companies/:companyId` which executes a single Drizzle transaction:

1. Manual deletes from 26 child tables with `NO ACTION` foreign keys (ordered for dependency satisfaction)
2. Final `DELETE FROM companies`
3. DB-level `ON DELETE CASCADE` handles environments and remaining dependent tables

Each deletion was verified with company count, issue preservation, and health checks before proceeding to the next. All three deletions returned `{"ok": true}`.

### Final state

| Check | Result |
|---|---|
| Companies | 1 |
| Company ID | `f5609cfe-37ff-4061-a3c7-35ae55dbcc2b` |
| Issues | THE-1, THE-2 preserved |
| CEO agent | Preserved |
| Orphan memberships | 0 |
| Orphan environments | 0 |
| Health endpoints | Both local and public healthy |

## Rollback

The pre-mutation backup provides full rollback capability:

```bash
systemctl stop paperclip-thebinmap-prod.service
mv /home/paperclip-thebinmap-prod/.paperclip/instances/thebinmap-email-ops-prod/db /tmp/db-rollback
tar -xzf /var/backups/paperclip/thebinmap-email-ops-prod/thebinmap-email-ops-prod-20260802-155506Z.tar.gz \
    -C /home/paperclip-thebinmap-prod/.paperclip/instances/
chown -R paperclip-thebinmap-prod:paperclip-thebinmap-prod \
    /home/paperclip-thebinmap-prod/.paperclip/instances/thebinmap-email-ops-prod
systemctl start paperclip-thebinmap-prod.service
```

## Current Stop Point

- **Duplicate cleanup is complete.**
- **Canonical production baseline is verified.**
- Plugin upgrade is not yet performed.
- Gmail intake is not yet enabled in canonical production.
- Historical inbox replay is deferred.
- Outbound email remains outside the current approved scope.

## Next Approved Planning Boundary

The next separate governed mission is:

1. Choose a tested Paperclip/plugin commit.
2. Create genuinely isolated staging using a **separate deployment directory** and **copied database**.
3. Validate migrations and rollback.
4. Validate read-only Gmail intake.
5. Verify zero outbound SMTP activity.
6. Upgrade production only after all staging gates pass.

Do not implement that mission without separate Board approval.

---

*Plan derived from the 2026-08-02 read-only audit and executed duplicate cleanup. See `2026-08-02-canonical-production-instance-audit.md` for the full audit record.*
