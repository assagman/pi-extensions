/**
 * Gamma Analyzer — Token Source Analysis Service
 *
 * Extracts and counts tokens from all context window sources.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { NormalizedToolSchema } from "./schema-capture.js";
import { countTokens } from "./tokenizer.js";
import type {
  CategoryStats,
  DiscrepancyAnalysis,
  DiscrepancySource,
  TokenAnalysis,
  TokenCategory,
  TokenSource,
  TurnStats,
} from "./types.js";

// =============================================================================
// SYSTEM PROMPT SECTION MARKERS
// =============================================================================

const SECTION_MARKERS = {
  DELTA_MEMORY_START: "<delta_memory>",
  DELTA_MEMORY_END: "</delta_memory>",
  EPSILON_TASKS_START: "<epsilon_tasks>",
  EPSILON_TASKS_END: "</epsilon_tasks>",
  AVAILABLE_SKILLS_START: "<available_skills>",
  AVAILABLE_SKILLS_END: "</available_skills>",
  FUNCTIONS_START: "<functions>",
  FUNCTIONS_END: "</functions>",
} as const;

// =============================================================================
// ANALYZER INTERFACE
// =============================================================================

export interface AnalyzeOptions {
  /** Captured tool schemas from API request */
  capturedSchemas?: Map<string, NormalizedToolSchema> | null;
}

export interface Analyzer {
  analyze(
    ctx: ExtensionContext,
    systemPrompt: string | null,
    options?: AnalyzeOptions
  ): Promise<TokenAnalysis>;
}

// =============================================================================
// ANALYZER IMPLEMENTATION
// =============================================================================

export function createAnalyzer(): Analyzer {
  return {
    async analyze(ctx, systemPrompt, options = {}): Promise<TokenAnalysis> {
      const { capturedSchemas } = options;
      const warnings: string[] = [];
      const sources: TokenSource[] = [];
      const turnBreakdown: TurnStats[] = [];

      // Get context usage from Pi
      const contextUsage = ctx.getContextUsage();
      const totalTokens = contextUsage?.tokens ?? 0;
      const contextWindow = contextUsage?.contextWindow ?? 200000;
      const usagePercent = contextUsage?.percent ?? 0;

      // Get model info
      const model = {
        provider: ctx.model?.provider ?? "unknown",
        modelId: ctx.model?.id ?? "unknown",
      };

      // 1. Parse system prompt sections
      if (systemPrompt) {
        const systemSources = parseSystemPrompt(systemPrompt);
        sources.push(...systemSources);
      } else {
        warnings.push("System prompt not captured — run /gamma after first message");
      }

      // 2. Parse session messages
      const branch = ctx.sessionManager.getBranch();
      const messageSources = parseSessionMessages(branch, turnBreakdown);
      sources.push(...messageSources);

      // 3. Add tool schemas from captured API request (if not already from system prompt)
      const hasToolSchemas = sources.some((s) => s.id === "tool_schemas");
      if (!hasToolSchemas) {
        const toolSource = buildToolSchemaSource(capturedSchemas);
        if (toolSource) {
          sources.push(toolSource);
        }
      }

      // 4. Calculate percentages and build category stats
      const totalCounted = sources.reduce((sum, s) => sum + s.tokens, 0);
      for (const source of sources) {
        source.percent = totalCounted > 0 ? (source.tokens / totalCounted) * 100 : 0;
      }

      const categories = buildCategoryStats(sources);

      // Build discrepancy analysis
      const discrepancy = buildDiscrepancyAnalysis(
        totalCounted,
        totalTokens,
        sources,
        systemPrompt
      );

      // Add warning if significant mismatch
      if (discrepancy && discrepancy.percentDiff > 10) {
        warnings.push(`Token count mismatch: counted ${totalCounted}, Pi reports ${totalTokens}`);
      }

      return {
        totalTokens: totalCounted,
        contextWindow,
        usagePercent,
        model,
        categories,
        sources,
        turnBreakdown,
        discrepancy,
        timestamp: Date.now(),
        isComplete: systemPrompt !== null,
        warnings,
      };
    },
  };
}

// =============================================================================
// SYSTEM PROMPT PARSING
// =============================================================================

function parseSystemPrompt(systemPrompt: string): TokenSource[] {
  const sources: TokenSource[] = [];
  let remaining = systemPrompt;

  // Extract delta memory section
  const deltaMatch = extractSection(
    remaining,
    SECTION_MARKERS.DELTA_MEMORY_START,
    SECTION_MARKERS.DELTA_MEMORY_END
  );
  if (deltaMatch) {
    sources.push({
      id: "memory_delta",
      category: "memory",
      label: "Delta Memory",
      tokens: countTokens(deltaMatch.content),
      percent: 0,
      preview: truncate(deltaMatch.content, 100),
      content: deltaMatch.content,
    });
    remaining = deltaMatch.remaining;
  }

  // Extract epsilon tasks section
  const epsilonMatch = extractSection(
    remaining,
    SECTION_MARKERS.EPSILON_TASKS_START,
    SECTION_MARKERS.EPSILON_TASKS_END
  );
  if (epsilonMatch) {
    sources.push({
      id: "memory_epsilon",
      category: "memory",
      label: "Epsilon Tasks",
      tokens: countTokens(epsilonMatch.content),
      percent: 0,
      preview: truncate(epsilonMatch.content, 100),
      content: epsilonMatch.content,
    });
    remaining = epsilonMatch.remaining;
  }

  // Extract available skills section
  const skillsMatch = extractSection(
    remaining,
    SECTION_MARKERS.AVAILABLE_SKILLS_START,
    SECTION_MARKERS.AVAILABLE_SKILLS_END
  );
  if (skillsMatch) {
    sources.push({
      id: "skills_available",
      category: "skills",
      label: "Available Skills",
      tokens: countTokens(skillsMatch.content),
      percent: 0,
      preview: truncate(skillsMatch.content, 100),
      content: skillsMatch.content,
    });
    remaining = skillsMatch.remaining;
  }

  // Extract functions (tool schemas) section
  const functionsMatch = extractSection(
    remaining,
    SECTION_MARKERS.FUNCTIONS_START,
    SECTION_MARKERS.FUNCTIONS_END
  );
  if (functionsMatch) {
    // Count tools by counting <function> tags
    const toolCount = (functionsMatch.content.match(/<function>/g) || []).length;
    sources.push({
      id: "tool_schemas",
      category: "tools",
      label: `Tool Schemas (${toolCount} tools)`,
      tokens: countTokens(functionsMatch.content),
      percent: 0,
      preview: truncate(functionsMatch.content, 100),
      content: functionsMatch.content,
    });
    remaining = functionsMatch.remaining;
  }

  // Remaining is base system prompt
  if (remaining.trim()) {
    sources.push({
      id: "system_base",
      category: "system",
      label: "Base System Prompt",
      tokens: countTokens(remaining),
      percent: 0,
      preview: truncate(remaining, 100),
      content: remaining,
    });
  }

  return sources;
}

function extractSection(
  text: string,
  startMarker: string,
  endMarker: string
): { content: string; remaining: string } | null {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;

  const endIdx = text.indexOf(endMarker, startIdx);
  if (endIdx === -1) return null;

  const content = text.slice(startIdx, endIdx + endMarker.length);
  const remaining = text.slice(0, startIdx) + text.slice(endIdx + endMarker.length);

  return { content, remaining };
}

// =============================================================================
// SESSION MESSAGE PARSING
// =============================================================================

function parseSessionMessages(
  // biome-ignore lint/suspicious/noExplicitAny: SessionEntry type varies
  branch: any[],
  turnBreakdown: TurnStats[]
): TokenSource[] {
  const sources: TokenSource[] = [];
  let turnIndex = 0;
  let cumulativeTokens = 0;

  for (const entry of branch) {
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (!message) continue;

    const role = message.role;
    const content = extractMessageContent(message);
    const tokens = countTokens(content);

    if (role === "user") {
      sources.push({
        id: `user_${turnIndex}`,
        category: "user",
        label: `User Turn ${turnIndex + 1}`,
        tokens,
        percent: 0,
        turnIndex,
        preview: truncate(content, 100),
        content,
      });

      // Initialize turn stats
      cumulativeTokens += tokens;
      turnBreakdown.push({
        turnIndex,
        userTokens: tokens,
        assistantTokens: 0,
        toolTokens: 0,
        cumulativeTokens,
        label: `Turn ${turnIndex + 1}`,
      });
    } else if (role === "assistant") {
      // Extract tool calls if present
      const toolCalls = extractToolCalls(message);
      let assistantOnlyTokens = tokens;

      for (const tc of toolCalls) {
        sources.push({
          id: `tool_call_${tc.id}`,
          category: "tool_io",
          label: `Tool: ${tc.name}`,
          tokens: tc.tokens,
          percent: 0,
          turnIndex,
          preview: truncate(tc.args, 100),
          content: tc.args,
        });
        assistantOnlyTokens -= tc.tokens;
      }

      // Clamp to 0 in case tool tokens exceed content tokens
      assistantOnlyTokens = Math.max(0, assistantOnlyTokens);

      if (assistantOnlyTokens > 0) {
        sources.push({
          id: `assistant_${turnIndex}`,
          category: "assistant",
          label: `Assistant Turn ${turnIndex + 1}`,
          tokens: assistantOnlyTokens,
          percent: 0,
          turnIndex,
          preview: truncate(content, 100),
          content,
        });
      }

      // Update turn stats
      const turn = turnBreakdown[turnIndex];
      if (turn) {
        turn.assistantTokens = assistantOnlyTokens;
        turn.toolTokens = toolCalls.reduce((sum, tc) => sum + tc.tokens, 0);
        cumulativeTokens += tokens;
        turn.cumulativeTokens = cumulativeTokens;
      }

      turnIndex++;
    } else if (role === "tool_result" || role === "tool") {
      // Tool results
      sources.push({
        id: `tool_result_${entry.id}`,
        category: "tool_io",
        label: "Tool Result",
        tokens,
        percent: 0,
        turnIndex: Math.max(0, turnIndex - 1),
        preview: truncate(content, 100),
        content,
      });

      // Update turn stats
      const turn = turnBreakdown[Math.max(0, turnIndex - 1)];
      if (turn) {
        turn.toolTokens += tokens;
        cumulativeTokens += tokens;
        turn.cumulativeTokens = cumulativeTokens;
      }
    }
  }

  return sources;
}

interface ToolCallInfo {
  id: string;
  name: string;
  args: string;
  tokens: number;
}

// biome-ignore lint/suspicious/noExplicitAny: Message type varies
function extractToolCalls(message: any): ToolCallInfo[] {
  const calls: ToolCallInfo[] = [];

  // Check for tool_use content blocks (Claude format)
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const argsStr = JSON.stringify(block.input ?? {});
        calls.push({
          id: block.id ?? `tool_${calls.length}`,
          name: block.name ?? "unknown",
          args: argsStr,
          tokens: countTokens(argsStr),
        });
      }
    }
  }

  // Check for tool_calls array (OpenAI format)
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const argsStr = tc.function?.arguments ?? "{}";
      calls.push({
        id: tc.id ?? `tool_${calls.length}`,
        name: tc.function?.name ?? "unknown",
        args: argsStr,
        tokens: countTokens(argsStr),
      });
    }
  }

  return calls;
}

// biome-ignore lint/suspicious/noExplicitAny: Message content type varies
function extractMessageContent(message: any): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text ?? "")
      .join("\n");
  }

  return "";
}

// =============================================================================
// CATEGORY AGGREGATION
// =============================================================================

function buildCategoryStats(sources: TokenSource[]): CategoryStats[] {
  const categoryMap = new Map<TokenCategory, { tokens: number; count: number }>();

  for (const source of sources) {
    const existing = categoryMap.get(source.category);
    if (existing) {
      existing.tokens += source.tokens;
      existing.count++;
    } else {
      categoryMap.set(source.category, { tokens: source.tokens, count: 1 });
    }
  }

  const totalTokens = sources.reduce((sum, s) => sum + s.tokens, 0);
  const stats: CategoryStats[] = [];

  for (const [category, data] of categoryMap) {
    stats.push({
      category,
      tokens: data.tokens,
      percent: totalTokens > 0 ? (data.tokens / totalTokens) * 100 : 0,
      sourceCount: data.count,
    });
  }

  // Sort by tokens descending
  stats.sort((a, b) => b.tokens - a.tokens);

  return stats;
}

// =============================================================================
// DISCREPANCY ANALYSIS
// =============================================================================

function buildDiscrepancyAnalysis(
  counted: number,
  reported: number,
  sources: TokenSource[],
  systemPrompt: string | null
): DiscrepancyAnalysis | null {
  if (reported === 0) return null;

  const difference = counted - reported;
  const percentDiff = Math.abs((difference / reported) * 100);

  // Only analyze if there's a notable difference (>5%)
  if (percentDiff < 5) return null;

  const discrepancySources: DiscrepancySource[] = [];

  // 1. Tokenizer mismatch (always present)
  discrepancySources.push({
    name: "Tokenizer Mismatch",
    reason: "We use cl100k_base (GPT-4/Claude approx). Actual model tokenizer may differ by 5-15%.",
    estimatedImpact: Math.round(reported * 0.1),
    confidence: "high",
  });

  // 2. Schema token approximation
  const toolSources = sources.filter((s) => s.category === "tools");
  if (toolSources.length > 0) {
    const toolTokens = toolSources.reduce((sum, s) => sum + s.tokens, 0);
    discrepancySources.push({
      name: "Schema Token Approximation",
      reason: "Tool schema tokens approximated from character count (~3.5 chars/token for JSON).",
      estimatedImpact: Math.round(toolTokens * 0.1),
      confidence: "low",
    });
  }

  // 3. Missing system prompt
  if (!systemPrompt) {
    discrepancySources.push({
      name: "Missing System Prompt",
      reason: "System prompt not captured. Run /gamma after at least one exchange.",
      estimatedImpact: 3000, // Typical system prompt size
      confidence: "high",
    });
  }

  // 4. Special tokens / role markers
  discrepancySources.push({
    name: "Role Markers & Special Tokens",
    reason:
      "API adds hidden tokens for role boundaries, message separators, and control sequences.",
    estimatedImpact: Math.max(50, sources.length * 10), // ~10 tokens per message boundary
    confidence: "medium",
  });

  // 5. Image tokens (if images might be present but not detected)
  const hasImageCategory = sources.some((s) => s.category === "images");
  if (!hasImageCategory && difference > 1000) {
    discrepancySources.push({
      name: "Possible Image Tokens",
      reason:
        "Images use special token encoding (e.g., 85-1700 tokens per image tile). Not detected in content.",
      estimatedImpact: Math.min(5000, Math.abs(difference)),
      confidence: "low",
    });
  }

  // 6. Tool call overhead
  const toolIOSources = sources.filter((s) => s.category === "tool_io");
  if (toolIOSources.length > 0) {
    discrepancySources.push({
      name: "Tool Call Metadata",
      reason: "Tool calls include IDs, timestamps, and JSON structure overhead not fully captured.",
      estimatedImpact: toolIOSources.length * 20,
      confidence: "medium",
    });
  }

  // 7. Content block types we might miss
  discrepancySources.push({
    name: "Unhandled Content Blocks",
    reason: "Some content types (thinking blocks, citations, artifacts) may not be fully parsed.",
    estimatedImpact: Math.round(Math.abs(difference) * 0.2),
    confidence: "low",
  });

  // 8. Unicode/encoding differences
  discrepancySources.push({
    name: "Unicode Encoding",
    reason:
      "Non-ASCII characters, emojis, and special symbols tokenize differently across tokenizers.",
    estimatedImpact: Math.round(counted * 0.02),
    confidence: "low",
  });

  return {
    counted,
    reported,
    difference,
    percentDiff,
    sources: discrepancySources,
  };
}

// =============================================================================
// TOOL SCHEMA HANDLING
// =============================================================================

/**
 * Build tool schema token source from captured API request schemas.
 */
function buildToolSchemaSource(
  capturedSchemas: Map<string, NormalizedToolSchema> | null | undefined
): TokenSource | null {
  if (!capturedSchemas || capturedSchemas.size === 0) return null;

  const children: TokenSource[] = [];
  let totalTokens = 0;

  for (const [name, schema] of capturedSchemas) {
    children.push({
      id: `tool_schema_${name}`,
      category: "tools",
      label: name,
      tokens: schema.tokens,
      percent: 0,
      preview: schema.description ? truncate(schema.description, 80) : undefined,
    });
    totalTokens += schema.tokens;
  }

  // Sort by token count descending
  children.sort((a, b) => b.tokens - a.tokens);

  return {
    id: "tool_schemas",
    category: "tools",
    label: `Tool Schemas (${capturedSchemas.size} tools)`,
    tokens: totalTokens,
    percent: 0,
    preview: "Captured from API request",
    children,
  };
}

// =============================================================================
// UTILITIES
// =============================================================================

function truncate(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 3)}...`;
}
