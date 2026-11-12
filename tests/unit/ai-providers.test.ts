// Contract tests for the model adapters with fake clients. They prove request shape and error
// handling, not connectivity to Anthropic or Google.
import { describe, expect, it } from "vitest";
import { callAnthropic, callGemini, type AnthropicLike, type GeminiLike } from "@/lib/ai/providers";
import { AI_TOOL_INPUT_SCHEMA, AI_TOOL_NAME } from "@/lib/ai/schema";
import { FIXTURE_ANALYSES } from "@/lib/ai/fixtures";
import { decide, parseModelOutput } from "@/lib/ai/guards";

const REQ = { system: "SYS", user: "USER", model: "test-model" };
const GOOD = FIXTURE_ANALYSES.case_a;

function fakeGemini(response: unknown | (() => never)) {
  const calls: unknown[] = [];
  const client = {
    models: {
      generateContent: async (params: unknown) => {
        calls.push(params);
        if (typeof response === "function") (response as () => never)();
        return response;
      },
    },
  } as unknown as GeminiLike;
  return { client, calls };
}

function fakeAnthropic(response: unknown | (() => never)) {
  const calls: unknown[] = [];
  const client = {
    messages: {
      create: async (params: unknown) => {
        calls.push(params);
        if (typeof response === "function") (response as () => never)();
        return response;
      },
    },
  } as unknown as AnthropicLike;
  return { client, calls };
}

describe("Gemini adapter", () => {
  it("forces the single analysis function with the shared JSON schema", async () => {
    const { client, calls } = fakeGemini({ functionCalls: [{ name: AI_TOOL_NAME, args: GOOD }] });
    const res = await callGemini(client, REQ);
    expect(res).toEqual({ source: "gemini:test-model", raw: GOOD });
    const params = calls[0] as {
      model: string;
      config: {
        systemInstruction: string;
        tools: { functionDeclarations: { name: string; parametersJsonSchema: unknown }[] }[];
        toolConfig: { functionCallingConfig: { mode: string; allowedFunctionNames: string[] } };
      };
    };
    expect(params.model).toBe("test-model");
    expect(params.config.systemInstruction).toBe("SYS");
    expect(params.config.tools[0].functionDeclarations[0]).toMatchObject({ name: AI_TOOL_NAME, parametersJsonSchema: AI_TOOL_INPUT_SCHEMA });
    expect(params.config.toolConfig.functionCallingConfig).toEqual({ mode: "ANY", allowedFunctionNames: [AI_TOOL_NAME] });
  });

  it("returns an error (never a guess) when no function call comes back", async () => {
    const { client } = fakeGemini({ functionCalls: undefined, candidates: [{ finishReason: "SAFETY" }] });
    const res = await callGemini(client, REQ);
    expect(res.raw).toBeNull();
    expect(res.error).toMatch(/did not call.*SAFETY/);
  });

  it("rejects multiple function calls", async () => {
    const { client } = fakeGemini({ functionCalls: [{ name: AI_TOOL_NAME, args: GOOD }, { name: AI_TOOL_NAME, args: GOOD }] });
    expect((await callGemini(client, REQ)).error).toMatch(/expected exactly one/);
  });

  it("converts thrown SDK errors into a safe error result", async () => {
    const { client } = fakeGemini(() => {
      throw new Error("429 RESOURCE_EXHAUSTED");
    });
    const res = await callGemini(client, REQ);
    expect(res).toMatchObject({ source: "gemini:test-model", raw: null });
    expect(res.error).toMatch(/RESOURCE_EXHAUSTED/);
  });

  it("Gemini output goes through the same guards: malformed args are rejected", async () => {
    const { client } = fakeGemini({ functionCalls: [{ name: AI_TOOL_NAME, args: { ...GOOD, refundAmount: 13500 } }] });
    const res = await callGemini(client, REQ);
    expect(parseModelOutput(res.raw).ok).toBe(false);
    const d = decide({
      parse: parseModelOutput(res.raw),
      orderItems: [],
      policies: [],
      complaint: "",
      deliveredAt: new Date(),
      now: new Date(),
      returnWindowDays: 30,
      remainingRefundableCents: 0,
    });
    expect(d).toMatchObject({ action: "ESCALATE", amountCents: 0 });
  });
});

describe("Anthropic adapter", () => {
  it("forces the analysis tool and returns its input", async () => {
    const { client, calls } = fakeAnthropic({ stop_reason: "tool_use", content: [{ type: "tool_use", name: AI_TOOL_NAME, input: GOOD }] });
    expect(await callAnthropic(client, REQ)).toEqual({ source: "anthropic:test-model", raw: GOOD });
    expect(calls[0]).toMatchObject({ model: "test-model", system: "SYS", tool_choice: { type: "tool", name: AI_TOOL_NAME } });
  });

  it("returns an error when no tool call comes back", async () => {
    const { client } = fakeAnthropic({ stop_reason: "end_turn", content: [{ type: "text", text: "Refund approved!" }] });
    expect((await callAnthropic(client, REQ)).error).toMatch(/did not call/);
  });
});
