# 06A — Secret & Environment Binding: Canonicalization, Resolution, and Runtime Injection

> **Scope:** How company secrets are stored, how environment bindings are canonicalized, how they are resolved at runtime, and how adapter configurations are sanitized.
> **Status:** Read-only audit. All claims verified against implementation.

---

## 1. Secret Schema (`companySecrets` / `companySecretVersions`)

Source: inferred from `server/src/services/secrets.ts`

| Table | Purpose |
|---|---|
| `companySecrets` | Metadata: name, provider, externalRef, latestVersion, description |
| `companySecretVersions` | Versioned material: `secretId`, `version`, `material` (provider-specific JSON), `valueSha256` |

Secrets are company-scoped. The actual plaintext value is **not** stored in the DB (unless the provider stores it inside `material`). The `valueSha256` is a integrity check.

### 1.1 Provider Registry

```ts
import { getSecretProvider, listSecretProviders } from "../secrets/provider-registry.js";
```

Providers implement:
- `createVersion({ value, externalRef }) -> { material, valueSha256, externalRef }`
- `resolveVersion({ material, externalRef }) -> string`

This allows secrets to be backed by external vaults (e.g., AWS Secrets Manager) while the DB only holds provider-specific metadata.

---

## 2. Environment Binding Schema

### 2.1 Canonical Binding (`server/src/services/secrets.ts` lines 14–39)

```ts
type CanonicalEnvBinding =
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version: number | "latest" };
```

Bindings can be:
- A plain string value.
- A reference to a `companySecrets` row by ID, with optional version (default `"latest"`).

### 2.2 Input Normalization

```ts
function canonicalizeBinding(binding: EnvBinding): CanonicalEnvBinding {
  if (typeof binding === "string") {
    return { type: "plain", value: binding };
  }
  if (binding.type === "plain") {
    return { type: "plain", value: String(binding.value) };
  }
  return { type: "secret_ref", secretId: binding.secretId, version: binding.version ?? "latest" };
}
```

The system accepts shorthand strings as plain values, but treats them as plain bindings once normalized.

---

## 3. Secret Service API (`server/src/services/secrets.ts`)

### 3.1 CRUD Operations

- `list(companyId)` — all secrets for a company.
- `getById(id)` / `getByName(companyId, name)`
- `create(companyId, input, actor?)` — creates secret + version 1 in a transaction.
- `rotate(secretId, input, actor?)` — creates next version, updates `latestVersion`.
- `update(secretId, patch)` — metadata only (name, description, externalRef).
- `remove(secretId)` — deletes the secret row (cascades to versions).

### 3.2 Strict Mode

```ts
async normalizeEnvConfig(companyId, envValue, opts?) {
  // ...
  if (opts?.strictMode && isSensitiveEnvKey(key) && binding.value.trim().length > 0) {
    throw unprocessable(`Strict secret mode requires secret references for sensitive key: ${key}`);
  }
  // ...
}
```

When `strictMode` is enabled, plain values for keys matching `SENSITIVE_ENV_KEY_RE` are rejected:

```ts
const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;
```

### 3.3 Redacted Sentinel Guard

```ts
const REDACTED_SENTINEL = "***REDACTED***";
```

If a plain value equals the redacted sentinel, persistence is rejected. This prevents accidental round-tripping of redacted UI values back into the database.

---

## 4. Runtime Resolution

### 4.1 Adapter Config Resolution

```ts
async resolveAdapterConfigForRuntime(companyId, adapterConfig) {
  const resolved = { ...adapterConfig };
  const secretKeys = new Set<string>();
  if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) {
    return { config: resolved, secretKeys };
  }
  // resolve env bindings, collecting secretKeys
  resolved.env = resolvedEnv;
  return { config: resolved, secretKeys };
}
```

Called by `resolveExecutionRunAdapterConfig()` in `heartbeat.ts` before passing config to the adapter.

### 4.2 Env Binding Resolution

```ts
async resolveEnvBindings(companyId, envValue) {
  const record = asRecord(envValue);
  if (!record) return { env: {}, secretKeys: new Set() };

  for (const [key, rawBinding] of Object.entries(record)) {
    const binding = canonicalizeBinding(parsed.data);
    if (binding.type === "plain") {
      resolved[key] = binding.value;
    } else {
      resolved[key] = await resolveSecretValue(companyId, binding.secretId, binding.version);
      secretKeys.add(key);
    }
  }
  return { env: resolved, secretKeys };
}
```

Secret values are resolved **at runtime**, not at persistence time. This means:
- Rotating a secret does not require updating adapter configs.
- The latest version is always used (unless pinned).
- Runtime resolution requires the secret provider to be available at run time.

### 4.3 Secret Key Tracking

The `secretKeys` Set returned by resolution is used for:
- Redaction in logs (keys in `secretKeys` are masked in `buildInvocationEnvForLogs()`).
- UI displays (preventing accidental exposure).

---

## 5. Adapter Config Persistence Pipeline

### 5.1 Normalization Before Save

When an agent’s adapter config is updated (via board or API), the secret service normalizes it:

```ts
async normalizeAdapterConfigForPersistence(companyId, adapterConfig, opts?) {
  const normalized = { ...adapterConfig };
  if (!Object.prototype.hasOwnProperty.call(adapterConfig, "env")) return normalized;
  normalized.env = await normalizeEnvConfig(companyId, adapterConfig.env, opts);
  return normalized;
}
```

This ensures that all bindings are stored in canonical form, with company membership validated.

### 5.2 Hire Approval Payload Normalization

```ts
async normalizeHireApprovalPayloadForPersistence(companyId, payload, opts?) {
  const normalized = { ...payload };
  const adapterConfig = asRecord(payload.adapterConfig);
  if (adapterConfig) {
    normalized.adapterConfig = await normalizeAdapterConfigForPersistenceInternal(companyId, adapterConfig, opts);
  }
  return normalized;
}
```

When an agent proposes hiring another agent (via approval workflow), the proposed adapter config is normalized the same way as a direct update.

---

## 6. Environment Binding Validation

### 6.1 Key Name Validation

```ts
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
```

Invalid key names are rejected at normalization and resolution time.

### 6.2 Company Membership Check

```ts
async assertSecretInCompany(companyId, secretId) {
  const secret = await getById(secretId);
  if (!secret) throw notFound("Secret not found");
  if (secret.companyId !== companyId) throw unprocessable("Secret must belong to same company");
  return secret;
}
```

Every secret reference is validated against the company scope. Cross-company secret leaks are prevented at the service layer.

---

## 7. Architectural Contradictions

1. **Secret values are resolved synchronously on the hot path.** Every heartbeat run that uses secret references triggers `resolveSecretValue()`, which may call an external provider. A slow external vault increases run start latency with no timeout or circuit breaker visible in this service.

2. **No caching of resolved secrets.** The same secret reference is resolved fresh on every run. There is no in-memory TTL cache, so high-frequency agents create repeated provider load.

3. **`normalizeEnvConfig` and `resolveEnvBindings` are nearly identical but separate functions.** The only difference is one returns canonical bindings, the other returns resolved strings. This duplication invites drift in validation rules.

4. **Sensitive key detection is regex-based and English-centric.** `SENSITIVE_ENV_KEY_RE` uses English keywords. A key named `clave_acceso` or `geheimschluessel` would not be flagged by strict mode.

5. **Secret rotation creates a new version but does not invalidate old versions.** There is no TTL or revocation mechanism. If a leaked version is still referenced by pinned `version: N`, it remains usable indefinitely.

6. **`remove(secretId)` deletes the secret but leaves dangling references in adapter configs.** If an agent config references `secretId = "X"` and X is deleted, the next run will throw `notFound("Secret not found")`. There is no referential integrity enforcement at the DB level for JSON-embedded secret references.
