export function summarizeOperationalError(
  error: unknown,
  sensitiveValues: string[] = [],
): string {
  if (!(error instanceof Error)) return redactSensitive(String(error), sensitiveValues);

  const detail = error as Error & {
    responseStatus?: unknown;
    responseText?: unknown;
    responseCode?: unknown;
    response?: unknown;
    code?: unknown;
  };

  const parts = [error.message];
  if (typeof detail.code === "string" && detail.code.trim()) {
    parts.push("code=" + detail.code.trim());
  }
  if (typeof detail.responseStatus === "string" && detail.responseStatus.trim()) {
    parts.push("status=" + detail.responseStatus.trim().toUpperCase());
  }
  if (typeof detail.responseCode === "number" || typeof detail.responseCode === "string") {
    parts.push("responseCode=" + String(detail.responseCode));
  }

  const serverText =
    typeof detail.responseText === "string" && detail.responseText.trim()
      ? detail.responseText
      : typeof detail.response === "string" && detail.response.trim()
        ? detail.response
        : "";

  if (serverText) {
    parts.push("response=" + compact(serverText));
  }

  return redactSensitive(parts.join("; "), sensitiveValues);
}

function compact(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function redactSensitive(value: string, sensitiveValues: string[]): string {
  let output = value;
  for (const sensitive of sensitiveValues) {
    if (!sensitive) continue;
    output = output.split(sensitive).join("[REDACTED]");
  }
  return output;
}
