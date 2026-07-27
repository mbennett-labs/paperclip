# EMA-12 Audit: Pin Intake Triage Model Config and Audit Rejected Tool Call

**Date:** 2026-07-27
**Auditor:** Email Operations Lead
**Issue:** EMA-12
**Related:** EMA-9 (churn), EMA-11 (tool call behavior)

## Observed Evidence

### 1. Model Availability Verification
- **21:33Z:** Ran `opencode models` command
- **Confirmed:** `openrouter/moonshotai/kimi-k3` was available (transient catalog state resolved)
- **21:12Z:** Previous "available models" list was adapter's 12-model error sample, not full catalog
- **Adapter behavior:** Fails fast only when model ID is truly absent

### 2. Model Pinning Decision
- **Selected:** `openrouter/deepseek/deepseek-chat`
- **Rationale:** Verified available, proven successful on EMA-9 runs, cheapest tier per hiring packet
- **Fallbacks recorded:** 
  - Primary: `openrouter/moonshotai/kimi-k3` (known flappy)
  - Secondary: `deepseek/deepseek-chat` (direct provider)

### 3. Rejected Tool Call Analysis
- **Run ID:** `cbd01d9f`
- **Sequence:** 15–16
- **Action:** `permission requested: doom_loop (bash); auto-rejecting`
- **Rejecting party:** opencode's built-in doom-loop detector
- **Context:** Second consecutive identical `npm run lint` call during lint detour
- **No MCP involvement:** No MCP tools were invoked

### 4. Session Resume Behavior
- **Run sequence 1:** Session resume skipped
- **Reason:** "configured model changed from `openai/gpt-5.1-codex-mini` to `openrouter/deepseek/deepseek-chat`"
- **Timing:** Config PATCH logged at 21:16:25Z
- **Conclusion:** Mid-incident config churn invalidated saved sessions every run

### 5. Collateral Cleanup
- **Verified:** Uncommitted edits to `server/package.json` reverted to HEAD
- **Method:** Hunk-for-hunk verification against run log
- **Scope:** npm-init rewrite + lint script changes

## Inferred Conclusions

1. **Model pinning IS the fix** for session resume issues
2. **Session resume is a working feature** when model configuration is stable
3. **Doom-loop detector functioned correctly** and should remain enabled
4. **No session-reuse defect exists** - the behavioral root cause was configuration churn

## Recommended Actions

1. **Maintain model pinning** for operational stability
2. **Document transient model catalog behavior** in operational runbooks
3. **Preserve doom-loop detection** as critical safety feature
4. **Address repo tool call behavior** in EMA-11 scope

## Unknown Items

- **Harness env-injection gap:** Noted JWT stoppage mid-run requires future review
- **Long-term model stability:** Requires monitoring of pinned model availability

## Institutional Learning

### Operational Patterns
1. **Model configuration stability** is prerequisite for session resume functionality
2. **Transient catalog states** can create false negatives in model availability checks
3. **Doom-loop detection** correctly prevents repetitive identical tool calls

### Verification Procedures
1. **Always verify model availability** with direct `opencode models` command
2. **Cross-reference adapter behavior** with actual catalog state
3. **Preserve run logs** for forensic analysis of tool call rejections

### Documentation Standards
1. **Record fallback models** in operational configurations
2. **Document transient behaviors** that affect system reliability
3. **Maintain audit trails** of configuration changes and their impacts

## Status: COMPLETE

All EMA-12 acceptance criteria resolved:
- ✅ Model verified + pinned
- ✅ Rejected tool call named and analyzed  
- ✅ Fresh-session-per-run behavior explained
- ✅ Outcome documented with evidence categories
- ✅ Collateral cleanup verified

**Disposition:** Ready for operational use with pinned model configuration