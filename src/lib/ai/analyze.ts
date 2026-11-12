// Selects the configured model provider (or fixture) and returns UNTRUSTED raw output.
// Validation happens in guards.ts. There is no fallback between providers or to fixtures.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { config } from "../config";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { FIXTURE_ANALYSES } from "./fixtures";
import { callAnthropic, callGemini, type RawModelResult } from "./providers";

export type { RawModelResult } from "./providers";

const TIMEOUT_MS = 60_000;

export async function runModel(args: Parameters<typeof buildUserMessage>[0] & { caseId: string }): Promise<RawModelResult> {
  const cfg = config();
  if (cfg.AI_MODE === "fixture") {
    const fixture = FIXTURE_ANALYSES[args.caseId];
    if (!fixture) return { source: "fixture", raw: null, error: `No fixture analysis for case ${args.caseId}` };
    return { source: "fixture", raw: structuredClone(fixture) };
  }

  const user = buildUserMessage(args);
  if (cfg.AI_PROVIDER === "gemini") {
    const client = new GoogleGenAI({ apiKey: cfg.GEMINI_API_KEY!, httpOptions: { timeout: TIMEOUT_MS } });
    return callGemini(client, { system: SYSTEM_PROMPT, user, model: cfg.GEMINI_MODEL });
  }
  const client = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });
  return callAnthropic(client, { system: SYSTEM_PROMPT, user, model: cfg.ANTHROPIC_MODEL });
}
