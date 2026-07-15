# 00 — Audit Charter

**Repository:** Paperclip (`mbennett-labs` fork of `paperclipai/paperclip`)  
**Audit Date:** 2026-07-14  
**Type:** Read-only operational/architectural due diligence  
**Current Branch:** `docs/paperclip-operational-audit-2026`  

---

## 1. Mission

This is a **READ-ONLY architectural audit**.

- Do NOT redesign the system.
- Do NOT recommend new architecture yet.
- Do NOT modify production code.
- Do NOT refactor.

The objective is to build an evidence-based inventory of what currently exists in this active fork, understanding its custom governance work, runtime hardening, and operational extensions.

## 2. Scope

### In Scope
- All top-level subsystems (`server/`, `ui/`, `packages/`, `cli/`, `docs/`)
- Custom fork modifications documented in git history and file tree
- Operational runtime tooling (`scripts/runtime_*.py`)
- Database schema and migrations (72+ migration files)
- Governance and risk documentation
- Adapter architecture (built-in and plugin-loaded)
- Test infrastructure (Vitest, Playwright)

### Out of Scope
- Upstream comparison (no `paperclipai/paperclip` diff analysis)
- Architecture proposals or redesign recommendations
- Code refactoring or production changes
- Security vulnerability assessment (surface-level only)

## 3. Methodology
1. Read root-level documentation (`README.md`, `AGENTS.md`, `ROADMAP.md`, etc.)
2. Read strategic docs (`doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DATABASE.md`, `doc/DEVELOPING.md`)
3. Explore directory structures for `server/`, `ui/`, `packages/`, `cli/`, `scripts/`, `tests/`
4. Examine git history for recent commits and branch topology
5. Identify custom modifications unique to this fork via file evidence
6. Catalog schema tables, API routes, service modules, UI pages, and components

## 4. Evidence Standard

Every conclusion in this audit references specific files. When uncertain, the audit explicitly states: **"Unknown from current evidence."**

## 5. Known Fork Context

Per `AGENTS.md` Section 11, this fork (`mbennett-labs/paperclip`) carries:
- QoL patches in fork UI (`stderr_group`, `tool_group`, `Dashboard excerpt`)
- External-only Hermes adapter story on `feat/externalize-hermes-adapter` branch
- Plugin-system support for external adapter loading
- NTFS-specific dev workarounds
- Auto port detection (3101+ if 3100 taken)

Additional custom work identified in this audit (not documented in AGENTS.md):
- QSL (Quality & Security Layer) review persistence subsystem
- Runtime Guardian V1–V4 with governance escalation
- Governance checkpoint recorder with continuity chains
- Institutional backup and disaster recovery framework
- Provider routing infrastructure (Stage 0)
- Liveness/deadlock hardening sprint
- Approval governance rules and deduplication

## 6. Deliverables

| Document | Purpose |
|---|---|
| `00_AUDIT_CHARTER.md` | This file — audit mandate and method |
| `01_REPOSITORY_MAP.md` | Subsystem inventory with confidence levels |
| `01A_CUSTOM_FORK_CHANGE_MAP.md` | Modifications unique to this fork |
| `01B_EVIDENCE_INDEX.md` | Indexed catalog of every important file |
| `01C_OPEN_QUESTIONS.md` | Questions that cannot yet be answered |

---
*End of Charter*
