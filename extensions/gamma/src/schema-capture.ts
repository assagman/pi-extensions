/**
 * Gamma Schema Capture — Intercepts API requests to extract tool schemas
 *
 * All LLM APIs (Anthropic, OpenAI, Google) require tool schemas in the request body.
 * We intercept fetch() to capture them from the first API call.
 */

// =============================================================================
// TYPES
// =============================================================================

/**
 * Captured tool schema from API request.
 * Format varies slightly by provider but core fields are consistent.
 */
export interface CapturedToolSchema {
  name: string;
  description?: string;
  /** Anthropic format */
  input_schema?: Record<string, unknown>;
  /** OpenAI format */
  parameters?: Record<string, unknown>;
  /** Function wrapper (OpenAI) */
  function?: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Normalized tool schema for internal use.
 */
export interface NormalizedToolSchema {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /** Estimated token count for this schema */
  tokens: number;
}

// =============================================================================
// STATE
// =============================================================================

/** Captured raw tools from API request */
let capturedRawTools: CapturedToolSchema[] | null = null;

/** Normalized and processed tool schemas */
let normalizedSchemas: Map<string, NormalizedToolSchema> | null = null;

/** Whether the hook is installed */
let hookInstalled = false;

/** Original fetch reference */
let originalFetch: typeof globalThis.fetch | null = null;

// =============================================================================
// API ENDPOINT DETECTION
// =============================================================================

const AI_API_PATTERNS = [
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "api.together.xyz",
  "api.mistral.ai",
  "api.cohere.ai",
  "openrouter.ai",
  "api.deepseek.com",
];

function isAIApiRequest(url: string): boolean {
  return AI_API_PATTERNS.some((pattern) => url.includes(pattern));
}

// =============================================================================
// SCHEMA CAPTURE HOOK
// =============================================================================

/**
 * Install the fetch hook to capture tool schemas.
 * Safe to call multiple times - only installs once.
 */
export function installSchemaCapture(): void {
  if (hookInstalled) return;

  originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Only intercept AI API calls, only capture once
    if (!capturedRawTools && isAIApiRequest(url) && init?.body) {
      try {
        const bodyStr = typeof init.body === "string" ? init.body : null;
        if (bodyStr) {
          const body = JSON.parse(bodyStr);
          if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
            capturedRawTools = body.tools;
            normalizedSchemas = normalizeSchemas(body.tools);
          }
        }
      } catch {
        // Ignore parse errors - not all requests have JSON bodies
      }
    }

    if (!originalFetch) throw new Error("originalFetch not set");
    return originalFetch(input, init);
  };

  hookInstalled = true;
}

/**
 * Uninstall the fetch hook (for testing/cleanup).
 */
export function uninstallSchemaCapture(): void {
  if (!hookInstalled || !originalFetch) return;

  globalThis.fetch = originalFetch;
  originalFetch = null;
  hookInstalled = false;
}

/**
 * Reset captured data (for testing).
 */
export function resetCapturedSchemas(): void {
  capturedRawTools = null;
  normalizedSchemas = null;
}

// =============================================================================
// SCHEMA NORMALIZATION
// =============================================================================

/**
 * Normalize tool schemas from various API formats.
 */
function normalizeSchemas(tools: CapturedToolSchema[]): Map<string, NormalizedToolSchema> {
  const result = new Map<string, NormalizedToolSchema>();

  for (const tool of tools) {
    const normalized = normalizeToolSchema(tool);
    if (normalized) {
      result.set(normalized.name, normalized);
    }
  }

  return result;
}

/**
 * Normalize a single tool schema.
 */
function normalizeToolSchema(tool: CapturedToolSchema): NormalizedToolSchema | null {
  // OpenAI function format
  if (tool.function) {
    const schema = tool.function.parameters ?? {};
    const schemaStr = JSON.stringify(schema);
    return {
      name: tool.function.name,
      description: tool.function.description ?? "",
      schema,
      tokens: estimateSchemaTokens(tool.function.name, tool.function.description ?? "", schemaStr),
    };
  }

  // Anthropic format (direct)
  if (tool.name) {
    const schema = tool.input_schema ?? tool.parameters ?? {};
    const schemaStr = JSON.stringify(schema);
    return {
      name: tool.name,
      description: tool.description ?? "",
      schema,
      tokens: estimateSchemaTokens(tool.name, tool.description ?? "", schemaStr),
    };
  }

  return null;
}

/**
 * Estimate tokens for a tool schema.
 * Based on: name + description + JSON schema serialization
 */
function estimateSchemaTokens(name: string, description: string, schemaStr: string): number {
  // Rough approximation: ~4 chars per token for English text
  // JSON is slightly denser due to punctuation
  const nameTokens = Math.ceil(name.length / 4);
  const descTokens = Math.ceil(description.length / 4);
  const schemaTokens = Math.ceil(schemaStr.length / 3.5);

  // Add overhead for JSON structure wrapping
  const overhead = 20;

  return nameTokens + descTokens + schemaTokens + overhead;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Check if schemas have been captured.
 */
export function hasCapturedSchemas(): boolean {
  return normalizedSchemas !== null && normalizedSchemas.size > 0;
}

/**
 * Get all captured tool schemas.
 */
export function getCapturedSchemas(): Map<string, NormalizedToolSchema> | null {
  return normalizedSchemas;
}

/**
 * Get a specific tool schema by name.
 */
export function getToolSchema(name: string): NormalizedToolSchema | undefined {
  return normalizedSchemas?.get(name);
}

/**
 * Get total token count for all tool schemas.
 */
export function getTotalSchemaTokens(): number {
  if (!normalizedSchemas) return 0;

  let total = 0;
  for (const schema of normalizedSchemas.values()) {
    total += schema.tokens;
  }
  return total;
}

/**
 * Get tool count.
 */
export function getCapturedToolCount(): number {
  return normalizedSchemas?.size ?? 0;
}

/**
 * Get raw captured tools (for debugging).
 */
export function getRawCapturedTools(): CapturedToolSchema[] | null {
  return capturedRawTools;
}
