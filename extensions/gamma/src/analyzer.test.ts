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

describe("skills decomposition", () => {
  it("decomposes available_skills into individual skill children", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `Base prompt.
<available_skills>
  <skill>
    <name>commit-wizard</name>
    <description>Create atomic, secure git commits</description>
    <location>/path/to/SKILL.md</location>
  </skill>
  <skill>
    <name>code-review</name>
    <description>Professional security-first code review with deep audit</description>
    <location>/path/to/SKILL.md</location>
  </skill>
  <skill>
    <name>delta</name>
    <description>Persistent project memory</description>
    <location>/path/to/SKILL.md</location>
  </skill>
</available_skills>`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const skillsSource = result.sources.find((s) => s.id === "skills_available");
    expect(skillsSource).toBeDefined();
    expect(skillsSource?.category).toBe("skills");
    expect(skillsSource?.label).toContain("3 skills");
    expect(skillsSource?.children).toHaveLength(3);

    const names = skillsSource?.children?.map((c) => c.label) ?? [];
    expect(names).toContain("commit-wizard");
    expect(names).toContain("code-review");
    expect(names).toContain("delta");
  });

  it("sorts skill children by token count descending", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `<available_skills>
  <skill>
    <name>small</name>
    <description>Tiny</description>
    <location>/a</location>
  </skill>
  <skill>
    <name>large</name>
    <description>${"Very detailed description. ".repeat(20)}</description>
    <location>/b</location>
  </skill>
</available_skills>`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const children = result.sources.find((s) => s.id === "skills_available")?.children ?? [];
    expect(children.length).toBe(2);
    expect(children[0].label).toBe("large");
    expect(children[1].label).toBe("small");
  });

  it("falls back to flat source when no <skill> blocks found", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `<available_skills>
Some text without skill XML blocks.
</available_skills>`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const skillsSource = result.sources.find((s) => s.id === "skills_available");
    expect(skillsSource).toBeDefined();
    expect(skillsSource?.label).toBe("Available Skills");
    expect(skillsSource?.children).toBeUndefined();
  });

  it("sets preview to skill description", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `<available_skills>
  <skill>
    <name>test-skill</name>
    <description>A helpful test skill for validating things</description>
    <location>/path</location>
  </skill>
</available_skills>`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const children = result.sources.find((s) => s.id === "skills_available")?.children ?? [];
    expect(children).toHaveLength(1);
    expect(children[0].preview).toBe("A helpful test skill for validating things");
  });

  it("assigns skills category to all children", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `<available_skills>
  <skill>
    <name>a</name>
    <description>Skill A</description>
    <location>/a</location>
  </skill>
  <skill>
    <name>b</name>
    <description>Skill B</description>
    <location>/b</location>
  </skill>
</available_skills>`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const children = result.sources.find((s) => s.id === "skills_available")?.children ?? [];
    for (const child of children) {
      expect(child.category).toBe("skills");
    }
  });
});

describe("system prompt decomposition", () => {
  it("returns flat source when no ## /path sections exist", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const result = await analyzer.analyze(
      ctx as never,
      "Simple system prompt without file sections."
    );

    const base = result.sources.find((s) => s.id === "system_base");
    expect(base).toBeDefined();
    expect(base?.label).toBe("Base System Prompt");
    expect(base?.children).toBeUndefined();
  });

  it("decomposes system prompt into children when ## /path sections exist", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `You are an AI assistant.

Guidelines:
- Be helpful

# Project Context

Project-specific instructions:

## /Users/me/.pi/agent/AGENTS.md

# Agents

Some agent instructions here.

## /Users/me/project/AGENTS.md

# Project AGENTS

Project-specific content.`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const base = result.sources.find((s) => s.id === "system_base");
    expect(base).toBeDefined();
    expect(base?.label).toContain("3 sections");
    expect(base?.children).toHaveLength(3);
  });

  it("labels core instructions and file sections correctly", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `Core instructions here.

## /Users/me/.pi/agent/AGENTS.md

Agent file content.

## /Users/me/source/my-project/AGENTS.md

Project file content.`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const base = result.sources.find((s) => s.id === "system_base");
    const children = base?.children ?? [];
    const labels = children.map((c) => c.label);

    expect(labels).toContain("Core Instructions");
    expect(labels).toContain("agent/AGENTS.md");
    expect(labels).toContain("my-project/AGENTS.md");
  });

  it("sorts children by token count descending", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    // Second file section is intentionally much larger
    const systemPrompt = `Short core.

## /a/b/small.md

Small.

## /a/b/large.md

${"Large content. ".repeat(50)}`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const base = result.sources.find((s) => s.id === "system_base");
    const children = base?.children ?? [];
    expect(children.length).toBeGreaterThanOrEqual(2);
    // Sorted desc by tokens
    for (let i = 1; i < children.length; i++) {
      expect(children[i - 1].tokens).toBeGreaterThanOrEqual(children[i].tokens);
    }
  });

  it("assigns children the 'system' category", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `Core.

## /a/b/file.md

Content.`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const base = result.sources.find((s) => s.id === "system_base");
    for (const child of base?.children ?? []) {
      expect(child.category).toBe("system");
    }
  });

  it("parent tokens equals sum of children tokens", async () => {
    const analyzer = createAnalyzer();
    const ctx = createMockContext();

    const systemPrompt = `Core instructions.

## /a/b/first.md

First file content here.

## /a/b/second.md

Second file content here.`;

    const result = await analyzer.analyze(ctx as never, systemPrompt);

    const base = result.sources.find((s) => s.id === "system_base");
    expect(base?.children).toBeDefined();
    const childSum = (base?.children ?? []).reduce((sum, c) => sum + c.tokens, 0);
    // Parent counts full text; children count chunks. Due to split boundaries
    // (\n removed at split points), child sum may differ slightly.
    // Allow ±2 tokens tolerance for split-boundary newlines.
    expect(Math.abs((base?.tokens ?? 0) - childSum)).toBeLessThanOrEqual(2);
  });
});
