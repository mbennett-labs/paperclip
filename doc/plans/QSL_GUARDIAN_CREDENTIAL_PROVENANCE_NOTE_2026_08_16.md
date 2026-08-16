# QSL Guardian Credential Provenance Note — 2026-08-16

Status: active design/evidence note

## Observation

During Mission Control / Guardian V0.1 work, operator-supplied provider dashboard evidence showed two credential entries with materially different recent-use timestamps:

- newer credential: last used approximately 19 hours earlier;
- older credential: last used approximately 21 minutes earlier.

No raw credential value is recorded here.

## Interpretation

This is evidence that at least one currently active runtime path is still using the older credential reference. It does not, by itself, prove which exact service, agent, or provider-routing path made the recent request.

Therefore Guardian must not infer credential provenance from configuration intent alone. It must be able to correlate configured credential references with observed runtime/provider usage and flag unexplained drift.

## Guardian requirement

Credential provenance becomes a first-class Guardian invariant:

1. Raw API keys/tokens must never be copied into mission evidence, logs, receipts, or UI diagnostics.
2. Mission/runtime evidence should record only safe credential-reference metadata, such as credential reference type/id or a non-secret fingerprint where available.
3. The selected provider/model and credential reference must be established before dispatch and preserved in mission evidence.
4. Silent credential substitution is prohibited.
5. If observed provider usage is inconsistent with the intended credential binding, Guardian should raise an intervention-class finding rather than silently accepting the mismatch.
6. Credential last-use timestamps are supporting evidence, not sole proof of causal attribution.
7. Live staging validation should prove which credential reference is bound to the staging execution path without printing or exposing the credential itself.

## Near-term staging proof

Before the live native Mission Control lifecycle proof, perform a bounded, read-only credential-binding check for staging that confirms:

- staging service identity;
- intended provider/model;
- credential reference identity/type (non-secret only);
- no raw secret output;
- production credential state remains untouched.

After the controlled mission run, compare provider-side last-use timing with the staging run window as corroborating evidence. Treat this only as corroboration unless the provider exposes a stronger request/key attribution mechanism.

## Product significance

This scenario is a strong Guardian showcase because configuration drift around credentials is easy for humans to miss and potentially high impact. A credible autonomous supervision plane should be able to answer:

> Which governed credential did this agent/runtime actually use, and was that the credential it was authorized to use?

The system should answer that from evidence without requiring an operator to manually inspect provider dashboards.
