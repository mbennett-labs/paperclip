# Paperclip — Resume Bullets

## AI Engineering / Platform Engineering

1. **Architected Paperclip, a multi-company control plane for autonomous AI workforces**, building a TypeScript monorepo (Express REST API, React/Vite UI, Drizzle ORM) that orchestrates AI agent execution across 10 adapter types (Claude, Codex, Cursor, Gemini, OpenCode, Pi, OpenClaw, Hermes, HTTP, process) with heartbeat scheduling, atomic task checkout, and full lifecycle state machines.

2. **Designed and implemented a hierarchical cost-control system** with per-agent, per-project, and per-company budgets denominated in both tokens and dollars; includes soft-alert thresholds, hard-limit auto-pause enforcement at 100% utilization, and cost-event ingestion supporting any model/provider combination with upstream billing-code attribution across cross-team delegation chains.

3. **Built a governance and approval framework** for autonomous agent operations including a human board operator model, approval-gated actions (agent hiring, CEO strategy proposals), irreversible agent termination, full-system board override authority, and a tamper-proof activity audit log that records every mutating action with actor, entity, and detail tracking.

4. **Engineered a plugin system with SDK, external adapter registry, and sandbox provider integration** enabling third-party extension of the control plane without core modifications; includes a worker/sandbox runtime model, JSON-RPC protocol, config/secret/DB/HTTP host APIs, UI component slots, and a scaffolding CLI (`create-paperclip-plugin`).

5. **Delivered a complete single-tenant deployment pipeline** supporting embedded PostgreSQL zero-config local dev, Docker single-container production, and Supabase/Postgres-compatible cloud hosting across three auth modes (local-trusted, authenticated-private, authenticated-public) with company portability via markdown-first import/export packages conforming to the `agentcompanies/v1` specification.