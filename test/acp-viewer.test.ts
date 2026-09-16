import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { AcpAttemptViewer } from "../src/ui/acp-viewer.js";

function mockTui(rows = 24, columns = 80) {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as any;
}

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "acp-1",
    type: "ACP/codex-acp",
    conversationHandle: "acp-codex",
    description: "马斯克新闻",
    status: "running",
    toolUses: 2,
    startedAt: Date.now() - 5_000,
    runtime: "acp",
    result: "第一条新闻",
    ...over,
  } as AgentRecord;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("AcpAttemptViewer", () => {
  it("shows the ACP handle, live result, and follow-up hint", () => {
    const viewer = new AcpAttemptViewer(mockTui(), record(), undefined, theme, vi.fn(), vi.fn(), undefined, vi.fn());
    const text = viewer.render(80).join("\n");
    expect(text).toContain("acp-codex");
    expect(text).toContain("第一条新闻");
    expect(text).toContain("Enter follow-up");
    expect(text).toContain("x stop");
    viewer.dispose();
  });

  it("says queued instead of inventing output", () => {
    const viewer = new AcpAttemptViewer(mockTui(), record({ status: "queued", result: undefined }), undefined, theme, vi.fn());
    expect(viewer.render(80).join("\n")).toContain("Queued");
    viewer.dispose();
  });
});
