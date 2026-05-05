import type { UIAdapterModule, TranscriptEntry, CreateConfigValues } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";

// hermes-paperclip-adapter is a server-only dependency and not installed in
// the UI workspace. Provide lightweight stubs so the bundle resolves cleanly.
// The real parsing logic runs server-side; the UI only needs to render the
// transcript entries the server already parsed.
function parseHermesStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", text: line, ts }];
}

function buildHermesConfig(v: CreateConfigValues): Record<string, unknown> {
  return { ...v };
}

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
