// Model-provider adapters. Each takes an injected client so it can be unit-tested without network.
// Every adapter returns UNTRUSTED raw tool input; validation happens in guards.ts, identically for all providers.
import type Anthropic from "@anthropic-ai/sdk";
import { FunctionCallingConfigMode, type GoogleGenAI } from "@google/genai";
import { AI_TOOL_INPUT_SCHEMA, AI_TOOL_NAME } from "./schema";

export interface RawModelResult {
  source: string; // "anthropic:<model>" | "gemini:<model>" | "fixture"
  raw: unknown; // the tool input as returned, unvalidated
  error?: string; // transport/model error; raw will be null
}

export interface ModelRequest {
  system: string;
  user: string;
  model: string;
}

const TOOL_DESCRIPTION = "Submit the structured case analysis for merchant review.";

function errorMessage(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

// ---------------------------------------------------------------- Anthropic (Claude)

export type AnthropicLike = Pick<Anthropic, "messages">;

export async function callAnthropic(client: AnthropicLike, req: ModelRequest): Promise<RawModelResult> {
  const source = `anthropic:${req.model}`;
  try {
    const res = await client.messages.create({
      model: req.model,
      max_tokens: 2000,
      system: req.system,
      tools: [
        {
          name: AI_TOOL_NAME,
          description: TOOL_DESCRIPTION,
          input_schema: AI_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: AI_TOOL_NAME, disable_parallel_tool_use: true },
      messages: [{ role: "user", content: req.user }],
    });
    const toolUse = res.content.find((b) => b.type === "tool_use" && b.name === AI_TOOL_NAME);
    if (!toolUse || toolUse.type !== "tool_use") {
      return { source, raw: null, error: `Model did not call ${AI_TOOL_NAME} (stop_reason=${res.stop_reason})` };
    }
    return { source, raw: toolUse.input };
  } catch (e) {
    return { source, raw: null, error: `Model call failed: ${errorMessage(e)}` };
  }
}

// ---------------------------------------------------------------- Google Gemini

export type GeminiLike = Pick<GoogleGenAI, "models">;

export async function callGemini(client: GeminiLike, req: ModelRequest): Promise<RawModelResult> {
  const source = `gemini:${req.model}`;
  try {
    const res = await client.models.generateContent({
      model: req.model,
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      config: {
        systemInstruction: req.system,
        temperature: 0,
        tools: [
          {
            functionDeclarations: [
              { name: AI_TOOL_NAME, description: TOOL_DESCRIPTION, parametersJsonSchema: AI_TOOL_INPUT_SCHEMA },
            ],
          },
        ],
        // ANY + allowedFunctionNames forces exactly this function to be called.
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [AI_TOOL_NAME] } },
      },
    });
    const calls = res.functionCalls ?? [];
    const call = calls.find((c) => c.name === AI_TOOL_NAME);
    if (!call) {
      const reason = res.candidates?.[0]?.finishReason ?? "unknown";
      return { source, raw: null, error: `Model did not call ${AI_TOOL_NAME} (finishReason=${reason})` };
    }
    if (calls.length > 1) {
      return { source, raw: null, error: `Model returned ${calls.length} function calls; expected exactly one` };
    }
    return { source, raw: call.args ?? null };
  } catch (e) {
    return { source, raw: null, error: `Model call failed: ${errorMessage(e)}` };
  }
}
