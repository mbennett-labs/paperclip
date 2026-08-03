# Canonical Production Instance Audit

**Date:** 2026-08-02
**Type:** Verified-state audit
**Status:** Complete

---

## Canonical Production Identity

| Field | Value |
|---|---|
| **Production URL** | `https://paperclip.quantumshieldlabs.dev` |
| **Company name** | TheBinMap Email Operations |
| **Canonical company ID** | `f5609cfe-37ff-4061-a3c7-35ae55dbcc2b` |
| **Production instance ID** | `thebinmap-email-ops-prod` |
| **Production service** | `paperclip-thebinmap-prod.service` |
| **Production port** | `127.0.0.1:3100` |
| **Production deployment directory** | `/opt/paperclip-deployments/thebinmap-email-ops-prod` |
| **VPS** | `69.62.69.140` |
| **Pinned commit** | `bb5f60ef` |
| **Branch** | `master` (mbennett-labs/paperclip) |
| **Database** | Embedded PostgreSQL, `127.0.0.1:54329` |

## Routing Chain

```
DNS: paperclip.quantumshieldlabs.dev -> 69.62.69.140
  -> nginx (port 443, TLS Let's Encrypt)
  -> proxy_pass http://127.0.0.1:3100
  -> paperclip-thebinmap-prod.service (systemd)
  -> embedded-postgres (127.0.0.1:54329)
```

## Verified Final State (2026-08-02)

| Check | Result |
|---|---|
| Companies | **1** — `f5609cfe-37ff-4061-a3c7-35ae55dbcc2b` |
| Environments | **1** — `Local` |
| CEO agent | **1** — `0fed0dae-12af-45e4-86a5-0c9bcc8f3ed5` (status: `error`) |
| THE-1 | `blocked` — "Hire your first engineer and create a hiring plan" |
| THE-2 | `todo` — "Recover stalled issue THE-1" |
| Orphan memberships | 0 |
| Orphan environments | 0 |
| Local health | `{"status":"ok","deploymentMode":"authenticated","bootstrapStatus":"ready"}` |
| Public health | `{"status":"ok","deploymentMode":"authenticated","bootstrapStatus":"ready"}` |

## Duplicate Cleanup

Three duplicate onboarding companies (all named "TheBinMap Email Operations") were removed through the official transactional Paperclip company-delete CLI on 2026-08-02. Each was created during the original 2026-07-25 onboarding session when the wizard was repeated.

| Duplicate | ID | Issue Prefix | Created (UTC) | Verified Empty |
|---|---|---|---|---|
| 1 | `92f59c70-ee17-43c7-bbe6-33befa707ba2` | THEA | 2026-07-25 18:07:17 | 0 issues, 0 agents, 0 projects |
| 2 | `f74a8fe8-2263-4ae0-9240-0ab2b076b96f` | THEAA | 2026-07-25 18:33:36 | 0 issues, 0 agents, 0 projects |
| 3 | `1f413928-089e-46d4-809b-82909ad4f959` | THEAAA | 2026-07-25 18:48:34 | 0 issues, 0 agents, 0 projects |

**Method:** Official `pnpm paperclipai company delete <id> --by id --yes --confirm <id>` via the authenticated CLI, calling `DELETE /api/companies/:companyId` which executes a single Drizzle transaction covering 26 manual child-table deletes plus the final `companies` row delete, with DB-level `ON DELETE CASCADE` handling environments and other dependent tables.

No raw SQL was used. No service interruption occurred. The canonical company and all its data remained intact after each deletion. Each deletion was verified with company count, issue preservation, and health checks before proceeding to the next.

No credential values, API keys, passwords, cookies, or authentication tokens are stored in these repository documents.

## Recovery Backup

| Field | Value |
|---|---|
| **Filename** | `thebinmap-email-ops-prod-20260802-155506Z.tar.gz` |
| **Directory** | `/var/backups/paperclip/thebinmap-email-ops-prod/` |
| **Size** | 24,822,794 bytes |
| **Entries** | 2,081 |
| **SHA-256** | `0d52eba127ecbf7396bc9001de70c316337be0e086921b98560adc90c0d87b20` |
| **Integrity** | Passed (`tar -tzf` verification) |
| **Archive root** | `thebinmap-email-ops-prod/` |
| **Restore parent** | `/home/paperclip-thebinmap-prod/.paperclip/instances/` |
| **Contents** | Full PostgreSQL cluster, server log, secrets, telemetry |

Created immediately before the first duplicate deletion on 2026-08-02 15:55:06 UTC via `systemctl start paperclip-thebinmap-prod-backup.service`. The automated daily backup timer (`paperclip-thebinmap-prod-backup.timer`) also runs at 03:15 UTC with 14-day retention.

## Local Historical Instance

| Field | Value |
|---|---|
| **Instance** | `email-clean-20260719` |
| **Location** | `C:\Users\mikeb\.paperclip\instances\email-clean-20260719` |
| **Status** | Designated historical/reference instance. It is currently not running. Formal archival hardening and startup prevention remain pending until its evidence is no longer needed. |
| **Company ID** | `15f8fb0a-065d-4e2b-9d24-a49d986dcaf8` (EMA prefix) |
| **Database** | PGlite (WASM, not running) |
| **Auth mode** | `local_trusted` |

This local instance is **not production**. It must not receive the production domain, port, instance ID, database, or production credentials. It must not be automatically started or presented as an alternate production UI. Its nine historical inbox items are evidence only; future recovery must use a governed Gmail/plugin replay rather than raw database copying.

---

*Audit derived from read-only investigation on 2026-08-02 against the VPS production deployment, the QSL infrastructure evidence files at `C:\Users\mikeb\QSL\docs\infrastructure\evidence\paperclip-production-v2-phase*/`, and the local `C:\Users\mikeb\.paperclip\instances\email-clean-20260719` directory.*
