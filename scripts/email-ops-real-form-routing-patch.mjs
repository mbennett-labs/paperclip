import fs from "node:fs";

const normalizePath = "packages/plugins/plugin-email/src/mail/normalize.ts";
const sorterPath = "packages/plugins/plugin-email/src/mail/sorter.ts";
const testPath = "packages/plugins/plugin-email/tests/real-form-routing.spec.ts";

function replaceOne(text, oldText, newText, label) {
  const first = text.indexOf(oldText);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (text.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return text.replace(oldText, newText);
}

let normalize = fs.readFileSync(normalizePath, "utf8");

normalize = replaceOne(
  normalize,
  `  | "newsletter_signup"\n  | "intelligence_request"`,
  `  | "newsletter_signup"\n  | "intelligence_signup"\n  | "intelligence_request"`,
  "MessageClassHint intelligence signup",
);

normalize = replaceOne(
  normalize,
  `  | "newsletter_signup"\n  | "qsl_security_review"`,
  `  | "newsletter_signup"\n  | "intelligence_signup"\n  | "qsl_security_review"`,
  "SourceType intelligence signup",
);

normalize = replaceOne(
  normalize,
  `  | "thebinmap_newsletter"\n  | "qsl_risk_calc"`,
  `  | "thebinmap_newsletter"\n  | "thebinmap_intelligence"\n  | "qsl_risk_calc"`,
  "SourceForm intelligence signup",
);

normalize = replaceOne(
  normalize,
  `const THEBINMAP_NEWSLETTER_SUBJECT = "Stay in the loop — TheBinMap";\nconst THEBINMAP_ALERT_PREFIX = "New alert signup — TheBinMap";`,
  `const THEBINMAP_NEWSLETTER_SUBJECT = "Stay in the loop — TheBinMap";\nconst THEBINMAP_INTELLIGENCE_SUBJECT = "Intelligence waitlist signup";\nconst THEBINMAP_ALERT_PREFIX = "New alert signup — TheBinMap";`,
  "intelligence subject constant",
);

normalize = replaceOne(
  normalize,
  `function isProviderMarketing(subject: string, fromAddress: string): boolean {\n  const f = fromAddress.toLowerCase();\n  if (!f.includes("web3forms.com") && !f.includes("formspree.io")) return false;\n  return PROVIDER_MARKETING_SUBJECT_PATTERNS.some((p) => p.test(subject));\n}\n`,
  `function isProviderMarketing(subject: string, fromAddress: string): boolean {\n  const f = fromAddress.toLowerCase();\n  if (!f.includes("web3forms.com") && !f.includes("formspree.io")) return false;\n  return PROVIDER_MARKETING_SUBJECT_PATTERNS.some((p) => p.test(subject));\n}\n\nfunction detectTheBinMapAlertSourcePage(body: string): string {\n  const source = /\\bsource\\s+(homepage|city-page|store-page)\\b/i.exec(body)?.[1]?.toLowerCase();\n  if (source === "homepage") return "/";\n  if (source === "city-page") return "/city";\n  if (source === "store-page") return "/store";\n  return "unknown";\n}\n`,
  "alert source-page helper",
);

normalize = replaceOne(
  normalize,
  `  if (subject === THEBINMAP_NEWSLETTER_SUBJECT) {\n    detection.sourceType = "newsletter_signup";`,
  `  if (isWeb3Forms && subject === THEBINMAP_INTELLIGENCE_SUBJECT) {\n    detection.sourceType = "intelligence_signup";\n    detection.sourceForm = "thebinmap_intelligence";\n    detection.sourcePage = "/intelligence";\n    detection.brand = "thebinmap";\n    detection.confidence = 0.95;\n    detection.evidence.push("Web3Forms + exact Intelligence waitlist subject");\n    detection.rulesMatched.push("subject-exact:thebinmap_intelligence_signup");\n    detection.requiresHumanReview = false;\n    return detection;\n  }\n\n  if (isWeb3Forms && s.includes("intelligence") && b.includes("intelligence page")) {\n    detection.sourceType = "intelligence_signup";\n    detection.sourceForm = "thebinmap_intelligence";\n    detection.sourcePage = "/intelligence";\n    detection.brand = "thebinmap";\n    detection.confidence = 0.85;\n    detection.evidence.push("Web3Forms + Intelligence Page source evidence");\n    detection.rulesMatched.push("web3forms:thebinmap_intelligence_signup");\n    detection.requiresHumanReview = false;\n    return detection;\n  }\n\n  if (subject === THEBINMAP_NEWSLETTER_SUBJECT) {\n    detection.sourceType = "newsletter_signup";`,
  "intelligence waitlist detection",
);

normalize = replaceOne(
  normalize,
  `  if (isWeb3Forms && (s.includes("alert signup") || s.startsWith("alert signup"))) {\n    detection.sourceType = "alert_signup";\n    detection.sourceForm = "thebinmap_alert";\n    detection.sourcePage = "unknown";`,
  `  if (isWeb3Forms && (s.includes("alert signup") || s.startsWith("alert signup"))) {\n    detection.sourceType = "alert_signup";\n    detection.sourceForm = "thebinmap_alert";\n    detection.sourcePage = detectTheBinMapAlertSourcePage(body);`,
  "real alert source page attribution",
);

normalize = replaceOne(
  normalize,
  `  if (detection.sourceType === "newsletter_signup") return "newsletter_signup";\n  if (detection.sourceType === "qsl_security_review") return "support_request";`,
  `  if (detection.sourceType === "newsletter_signup") return "newsletter_signup";\n  if (detection.sourceType === "intelligence_signup") return "intelligence_signup";\n  if (detection.sourceType === "qsl_security_review") return "support_request";`,
  "classify intelligence signup",
);

normalize = replaceOne(
  normalize,
  `    : detection.sourceType === "newsletter_signup" ? "[Newsletter]"\n    : detection.sourceType === "qsl_security_review" ? "[QSL Security Review]"`,
  `    : detection.sourceType === "newsletter_signup" ? "[Newsletter]"\n    : detection.sourceType === "intelligence_signup" ? "[Intelligence Signup]"\n    : detection.sourceType === "qsl_security_review" ? "[QSL Security Review]"`,
  "intelligence signup issue title",
);

fs.writeFileSync(normalizePath, normalize);

let sorter = fs.readFileSync(sorterPath, "utf8");
sorter = replaceOne(
  sorter,
  `    sourceDetection?.sourceType === "alert_signup" ||\n    sourceDetection?.sourceType === "newsletter_signup" ||\n    isKnownTherapistIndexOperationalNotification(sourceDetection)`,
  `    sourceDetection?.sourceType === "alert_signup" ||\n    sourceDetection?.sourceType === "newsletter_signup" ||\n    sourceDetection?.sourceType === "intelligence_signup" ||\n    isKnownTherapistIndexOperationalNotification(sourceDetection)`,
  "sort intelligence signup as notification",
);

sorter = replaceOne(
  sorter,
  `  if (classHint === "store_alert_signup" || classHint === "newsletter_signup") {`,
  `  if (\n    classHint === "store_alert_signup" ||\n    classHint === "newsletter_signup" ||\n    classHint === "intelligence_signup"\n  ) {`,
  "fallback intelligence signup hint",
);

fs.writeFileSync(sorterPath, sorter);

const test = `import { describe, expect, it } from "vitest";\nimport { detectSource, normalizeMessage } from "../src/mail/normalize.js";\nimport { sortIncomingEarly } from "../src/mail/sorter.js";\n\nconst INTELLIGENCE_BODY = [\n  "Hello,",\n  "",\n  "A new form has been submitted on your website. Details below.",\n  "",\n  "Type",\n  "",\n  "Intelligence",\n  "",\n  "Source",\n  "",\n  "Intelligence Page",\n  "",\n  "Email",\n  "",\n  "reader@example.com",\n  "",\n  "This e-mail was sent from",\n  "https://thebinmap.com/",\n].join("\\n");\n\nfunction normalize(subject: string, bodyText: string) {\n  return normalizeMessage({\n    uid: 101,\n    folder: "INBOX",\n    profileKey: "primary",\n    envelope: {\n      messageId: "real-form-routing@example.com",\n      from: [{ name: "Web3Forms", address: "notify+example@web3forms.com" }],\n      to: [{ address: "mikebennett637@gmail.com" }],\n      subject,\n      date: "2026-08-12T15:47:54.000Z",\n    },\n    bodyText,\n  });\n}\n\ndescribe("real portfolio form routing", () => {\n  it("routes the real TheBinMap Intelligence waitlist pattern as a non-reply system notification", () => {\n    const detection = detectSource(\n      "Intelligence waitlist signup",\n      "notify+example@web3forms.com",\n      INTELLIGENCE_BODY,\n    );\n\n    expect(detection).toMatchObject({\n      sourceType: "intelligence_signup",\n      sourceForm: "thebinmap_intelligence",\n      sourcePage: "/intelligence",\n      brand: "thebinmap",\n      requiresHumanReview: false,\n    });\n\n    const message = normalize("Intelligence waitlist signup", INTELLIGENCE_BODY);\n    expect(message.classHint).toBe("intelligence_signup");\n\n    const sorted = sortIncomingEarly({\n      sourceDetection: detection,\n      classHint: message.classHint,\n      inReplyTo: null,\n      hasReferences: false,\n    });\n\n    expect(sorted.category).toBe("system_notification");\n    expect(sorted.replyActionStatus).toBe("none");\n  });\n\n  it.each([\n    {\n      label: "city alert",\n      subject: "Alert signup — San Antonio, TX",\n      source: "city-page",\n      expectedPage: "/city",\n    },\n    {\n      label: "store alert",\n      subject: "Alert signup — TREASURE 2 HUNT, Newport News, VA",\n      source: "store-page",\n      expectedPage: "/store",\n    },\n  ])("preserves the real Web3Forms source for $label", ({ subject, source, expectedPage }) => {\n    const body = [\n      "Hello,",\n      "",\n      "A new form has been submitted on your website. Details below.",\n      "",\n      "Source",\n      "",\n      source,\n      "",\n      "Email",\n      "",\n      "reader@example.com",\n      "",\n      "This e-mail was sent from",\n      "https://thebinmap.com/",\n    ].join("\\n");\n\n    const detection = detectSource(subject, "notify+example@web3forms.com", body);\n    expect(detection).toMatchObject({\n      sourceType: "alert_signup",\n      sourceForm: "thebinmap_alert",\n      sourcePage: expectedPage,\n      brand: "thebinmap",\n    });\n\n    const message = normalize(subject, body);\n    const sorted = sortIncomingEarly({\n      sourceDetection: detection,\n      classHint: message.classHint,\n      inReplyTo: null,\n      hasReferences: false,\n    });\n    expect(sorted.category).toBe("system_notification");\n    expect(sorted.replyActionStatus).toBe("none");\n  });\n});\n`;

if (fs.existsSync(testPath)) throw new Error(`${testPath} already exists`);
fs.writeFileSync(testPath, test);

console.log("Applied bounded real-form routing patch and regression tests.");
