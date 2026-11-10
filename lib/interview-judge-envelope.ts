import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type JudgeMessagePurpose = "job" | "claim" | "payload" | "result" | "review-job" | "review-claim" | "review-payload" | "review-result";
const MAX_BYTES = 1000000;

function messageKey(key: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error("Interview worker encryption key must contain 64 hexadecimal characters.");
  return Buffer.from(key, "hex");
}

function context(purpose: JudgeMessagePurpose): Buffer {
  if (!["job", "claim", "payload", "result", "review-job", "review-claim", "review-payload", "review-result"].includes(purpose)) throw new Error("Unknown interview worker message purpose.");
  return Buffer.from(`motiva-interview-judge:v1:${purpose}`);
}

export function sealJudgeMessage(value: unknown, key: string, purpose: JudgeMessagePurpose): string {
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  if (plaintext.length > MAX_BYTES) throw new Error("Interview worker message exceeds 1 MB.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", messageKey(key), iv);
  cipher.setAAD(context(purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function openJudgeMessage(envelope: string, key: string, purpose: JudgeMessagePurpose): unknown {
  if (typeof envelope !== "string" || envelope.length > 1400000 || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(envelope)) throw new Error("Invalid interview worker envelope.");
  const [, encodedIv, encodedTag, encodedBody] = envelope.split(".");
  const iv = Buffer.from(encodedIv, "base64url");
  const tag = Buffer.from(encodedTag, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid interview worker envelope.");
  const decipher = createDecipheriv("aes-256-gcm", messageKey(key), iv);
  decipher.setAAD(context(purpose));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(Buffer.from(encodedBody, "base64url")), decipher.final()]);
  if (plaintext.length > MAX_BYTES) throw new Error("Interview worker message exceeds 1 MB.");
  return JSON.parse(plaintext.toString("utf8"));
}