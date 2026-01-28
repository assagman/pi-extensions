/**
 * Analyzer Unit Tests
 */

import { describe, expect, it, vi } from "vitest";
import { createAnalyzer } from "./analyzer.js";

// Mock ExtensionContext
const createMockContext = (overrides: Record<string, unknown> = {}) => ({
  getContextUsage: vi.fn().mockReturnValue({
    tokens: 10000,
    contextWindow: 200000,
    percent: 5,
  }),
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
    contextWindow: 200000,
  },
  sessionManager: {
    getBranch: vi.fn().mockReturnValue([]),
  },
  ...overrides,
});

describe("createAnalyzer", () => {
  it("creates an analyzer instance", () => {
    const analyzer = createAnalyzer();
    expect(analyzer).toBeDefined();
    expect(typeof analyzer.analyze).toBe("function");
  });
});

describe("analyzer.analyze", () => {
  it("returns analysis with empty context", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const result = await analyzer.analyze(ctx as never, null);

    expect(result).toBeDefined();
    expect(result.totalTokens).toBe(0);
    expect(result.contextWindow).toBe(200000);
    expect(result.model.provider).toBe("anthropic");
    expect(result.model.modelId).toBe("claude-sonnet-4-20250514");
    expect(result.warnings).toContain(
      "System prompt not captured — run /gamma after first message"
    );
  });

  it("parses delta_memory section from system prompt", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `Base prompt text.

<delta_memory>
## Memory data here
- Item 1
- Item 2
</delta_memory>

More base prompt.`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    expect(result.sources.length).toBeGreaterThan(0);

    const deltaSource = result.sources.find((s) => s.id === "memory_delta");
    expect(deltaSource).toBeDefined();
    expect(deltaSource?.category).toBe("memory");
    expect(deltaSource?.tokens).toBeGreaterThan(0);
  });

  it("parses epsilon_tasks section from system prompt", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `<epsilon_tasks>
## Active Tasks
- Task 1
- Task 2
</epsilon_tasks>`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const epsilonSource = result.sources.find((s) => s.id === "memory_epsilon");
    expect(epsilonSource).toBeDefined();
    expect(epsilonSource?.category).toBe("memory");
  });

  it("parses available_skills section from system prompt", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `<available_skills>
<skill>
  <name>test-skill</name>
  <description>A test skill</description>
</skill>
</available_skills>`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const skillsSource = result.sources.find((s) => s.id === "skills_available");
    expect(skillsSource).toBeDefined();
    expect(skillsSource?.category).toBe("skills");
  });

  it("extracts base system prompt after removing sections", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `You are an AI assistant.

<delta_memory>
Memory content
</delta_memory>

Follow these guidelines.`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const baseSource = result.sources.find((s) => s.id === "system_base");
    expect(baseSource).toBeDefined();
    expect(baseSource?.category).toBe("system");
    expect(baseSource?.content).toContain("You are an AI assistant");
    expect(baseSource?.content).toContain("Follow these guidelines");
    expect(baseSource?.content).not.toContain("Memory content");
  });

  it("builds category stats from sources", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `Base prompt.
<delta_memory>Memory</delta_memory>
<epsilon_tasks>Tasks</epsilon_tasks>`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    expect(result.categories.length).toBeGreaterThan(0);

    for (const cat of result.categories) {
      expect(cat.tokens).toBeGreaterThanOrEqual(0);
      expect(cat.percent).toBeGreaterThanOrEqual(0);
      expect(cat.percent).toBeLessThanOrEqual(100);
    }
  });

  it("handles session messages", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext({
      sessionManager: {
        getBranch: vi.fn().mockReturnValue([
          {
            type: "message",
            id: "msg1",
            message: { role: "user", content: "Hello, assistant!" },
          },
          {
            type: "message",
            id: "msg2",
            message: { role: "assistant", content: "Hello! How can I help?" },
          },
        ]),
      },
    });

    const result = await analyzer.analyze(ctx as never, "System prompt");

    const userSource = result.sources.find((s) => s.category === "user");
    const assistantSource = result.sources.find((s) => s.category === "assistant");

    expect(userSource).toBeDefined();
    expect(assistantSource).toBeDefined();
  });

  it("calculates percentages correctly", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = "A simple system prompt for testing token percentages.";

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const totalPercent = result.sources.reduce((sum, s) => sum + s.percent, 0);
    // Should be approximately 100% (may have floating point errors)
    expect(totalPercent).toBeGreaterThan(99);
    expect(totalPercent).toBeLessThan(101);
  });

  it("includes timestamp", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();
    const before = Date.now();

    const result = await analyzer.analyze(ctx as never, null);

    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });

  it("sets isComplete based on system prompt presence", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const withPrompt = await analyzer.analyze(ctx as never, "System prompt");
    const withoutPrompt = await analyzer.analyze(ctx as never, null);

    expect(withPrompt.isComplete).toBe(true);
    expect(withoutPrompt.isComplete).toBe(false);
  });

  it("extracts tool schemas from <functions> section", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();
    const systemPrompt = `Base prompt
<functions>
<function>{"name": "tool1", "description": "First tool"}</function>
<function>{"name": "tool2", "description": "Second tool"}</function>
</functions>
More content`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const toolSource = result.sources.find((s) => s.id === "tool_schemas");
    expect(toolSource).toBeDefined();
    expect(toolSource?.category).toBe("tools");
    expect(toolSource?.label).toContain("2 tools");
    expect(toolSource?.tokens).toBeGreaterThan(0);
  });

  it("returns no tool source when no <functions> and no captured schemas", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const result = await analyzer.analyze(ctx as never, "System prompt without functions");

    const toolSource = result.sources.find((s) => s.id === "tool_schemas");
    expect(toolSource).toBeUndefined();
  });

  it("uses captured schemas when provided", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const capturedSchemas = new Map([
      ["Bash", { name: "Bash", description: "Execute bash commands", schema: {}, tokens: 150 }],
      ["Read", { name: "Read", description: "Read file contents", schema: {}, tokens: 120 }],
      ["delta_log", { name: "delta_log", description: "Log to memory", schema: {}, tokens: 80 }],
    ]);

    const result = await analyzer.analyze(ctx as never, "System prompt", { capturedSchemas });

    const toolSource = result.sources.find((s) => s.id === "tool_schemas");
    expect(toolSource).toBeDefined();
    expect(toolSource?.category).toBe("tools");
    expect(toolSource?.tokens).toBe(350); // 150 + 120 + 80
    expect(toolSource?.label).toContain("3 tools");
    expect(toolSource?.label).not.toContain("est.");
    expect(toolSource?.preview).toBe("Captured from API request");
    expect(toolSource?.children).toHaveLength(3);
  });

  it("sorts captured schema children by token count descending", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const capturedSchemas = new Map([
      ["Small", { name: "Small", description: "Small tool", schema: {}, tokens: 50 }],
      ["Large", { name: "Large", description: "Large tool", schema: {}, tokens: 500 }],
      ["Medium", { name: "Medium", description: "Medium tool", schema: {}, tokens: 200 }],
    ]);

    const result = await analyzer.analyze(ctx as never, "System prompt", { capturedSchemas });

    const toolSource = result.sources.find((s) => s.id === "tool_schemas");
    const children = toolSource?.children ?? [];
    expect(children[0]?.label).toBe("Large");
    expect(children[1]?.label).toBe("Medium");
    expect(children[2]?.label).toBe("Small");
  });
});
