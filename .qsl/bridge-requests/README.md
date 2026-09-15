# QSL ChatGPT Orchestrator Bridge — Request Surface

Branch-native, commit-triggered request path for the QSL Orchestrator Bridge V1
(issue #36). This directory replaces the earlier `issue_comment` transport, which
could not fire because GitHub only evaluates `issue_comment` workflows from the
default branch.

## How a request is submitted

1. Create a request file at `.qsl/bridge-requests/<request_id>.json`.
2. Commit it to `feat/qsl-chatgpt-orchestrator-bridge-v1` and push.
3. The `qsl-chatgpt-orchestrator-bridge-dispatch` workflow (self-hosted staging
   runner, `paths: .qsl/bridge-requests/**`) validates exactly one request file,
   dispatches it to the staging Paperclip API, and posts a sanitized result to
   issue #34.

`<request_id>` must match `[A-Za-z0-9_-]+` and be unique (replay prevention). A
request_id already recorded in `.qsl/bridge-ledger.json` is rejected as a replay.

## Request schema

```json
{
  "request_id": "status-20260823-001",
  "operation": "status",
  "environment": "staging",
  "target_ids": [],
  "payload": {},
  "authority_approval_id": "",
  "expected_terminal_state": ""
}
```

- `environment` must be `"staging"` (anything else fails closed).
- `operation` must be one of the 17 allowlisted operations (see
  `packages/shared/src/types/qsl-orchestrator-bridge.ts`).
- Human-gated operations (`execute-approved-send`, `publish-approved-asset`,
  `accept-approved-commercial-commitment`) additionally require a valid
  `authority_approval_id`.

## Security invariants

- No raw shell, SQL, credential export, or arbitrary target access.
- No secret values or raw inbox content ever leave the private environment —
  only sanitized ids and summaries are posted to issue #34.
- Replay is blocked: `request_id` must be unique; processed requests are recorded
  in `.qsl/bridge-ledger.json`.

## History

Issue #38 (`QSL ChatGPT Orchestrator Bridge — request surface`) was the earlier
`issue_comment` transport surface. It is retained only as operator documentation
and request history; it is **not** used for V1 execution.
