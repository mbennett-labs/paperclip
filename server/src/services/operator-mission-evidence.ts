export type MissionEvidence = Record<string, unknown>;

function isPlainObject(value: unknown): value is MissionEvidence {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge mission evidence without destroying earlier stage evidence.
 *
 * - objects merge recursively
 * - arrays append; primitive arrays are deduplicated
 * - scalar values take the newest value
 *
 * Structured receipt/history arrays therefore accumulate while summary fields
 * can still reflect the latest known state.
 */
export function mergeMissionEvidence(
  existing: MissionEvidence | null | undefined,
  incoming: MissionEvidence | null | undefined,
): MissionEvidence | null {
  if (!existing && !incoming) return null;
  if (!incoming) return { ...(existing ?? {}) };

  const merged: MissionEvidence = { ...(existing ?? {}) };

  for (const [key, nextValue] of Object.entries(incoming)) {
    const currentValue = merged[key];

    if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
      merged[key] = mergeMissionEvidence(currentValue, nextValue) ?? {};
      continue;
    }

    if (Array.isArray(currentValue) && Array.isArray(nextValue)) {
      const combined = [...currentValue, ...nextValue];
      const allPrimitive = combined.every(
        (value) =>
          value === null ||
          ["string", "number", "boolean"].includes(typeof value),
      );
      merged[key] = allPrimitive ? [...new Set(combined)] : combined;
      continue;
    }

    merged[key] = nextValue;
  }

  return merged;
}
