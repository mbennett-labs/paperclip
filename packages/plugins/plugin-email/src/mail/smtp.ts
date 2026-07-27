import nodemailer from "nodemailer";
import type { ConnectorProfile } from "./imap.js";

export type ReplyInput = {
  to: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
  references: string[];
  fromName?: string;
};

export type ReplyResult = {
  sentMessageId: string;
  accepted: string[];
};

export async function sendReply(
  profile: ConnectorProfile,
  password: string,
  input: ReplyInput,
): Promise<ReplyResult> {
  const transporter = nodemailer.createTransport({
    host: profile.smtpHost,
    port: profile.smtpPort,
    secure: profile.smtpSecure,
    auth: { user: profile.username, pass: password },
  });
  const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`;
  const references = [...input.references];
  if (input.inReplyTo && !references.includes(input.inReplyTo)) references.push(input.inReplyTo);
  const info = await transporter.sendMail({
    from: input.fromName ? `"${input.fromName.replace(/"/g, "")}" <${profile.username}>` : profile.username,
    to: input.to,
    subject,
    text: input.text,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo, references } : {}),
  });
  return {
    sentMessageId: info.messageId ?? "",
    accepted: (info.accepted ?? []).map(String),
  };
}

/** SMTP connectivity check used by onValidateConfig. */
export async function validateSmtp(profile: ConnectorProfile, password: string): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: profile.smtpHost,
    port: profile.smtpPort,
    secure: profile.smtpSecure,
    auth: { user: profile.username, pass: password },
  });
  await transporter.verify();
}
