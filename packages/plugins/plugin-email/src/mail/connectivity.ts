import type { ConnectorProfile } from "./imap.js";
import { validateImap } from "./imap.js";
import { validateSmtp } from "./smtp.js";
import { summarizeOperationalError } from "./operational-error.js";

export type TransportProbe = {
  ok: boolean;
  durationMs: number;
  error?: string;
};

export type MailboxConnectivityProbe = {
  ok: boolean;
  imap: TransportProbe;
  smtp: TransportProbe;
};

type ProbeDeps = {
  validateImap: typeof validateImap;
  validateSmtp: typeof validateSmtp;
};

async function runProbe(
  probe: () => Promise<void>,
  password: string,
): Promise<TransportProbe> {
  const startedAt = Date.now();
  try {
    await probe();
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: summarizeOperationalError(error, [password]),
    };
  }
}

export async function probeMailboxConnectivity(
  profile: ConnectorProfile,
  password: string,
  deps: ProbeDeps = { validateImap, validateSmtp },
): Promise<MailboxConnectivityProbe> {
  const imap = await runProbe(() => deps.validateImap(profile, password), password);
  const smtp = await runProbe(() => deps.validateSmtp(profile, password), password);
  return { ok: imap.ok && smtp.ok, imap, smtp };
}
