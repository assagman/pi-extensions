/**
 * Schema Capture Unit Tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCapturedSchemas,
  getCapturedToolCount,
  getRawCapturedTools,
  getTotalSchemaTokens,
  hasCapturedSchemas,
  installSchemaCapture,
  resetCapturedSchemas,
  uninstallSchemaCapture,
} from "./schema-capture.js";

describe("schema-capture", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetCapturedSchemas();
  });

  afterEach(() => {
    uninstallSchemaCapture();
    globalThis.fetch = originalFetch;
  });

  describe("installSchemaCapture", () => {
    it("installs fetch hook", () => {
      installSchemaCapture();
      expect(globalThis.fetch).not.toBe(originalFetch);
    });

    it("is idempotent - multiple installs do not stack", () => {
      installSchemaCapture();
      const firstHook = globalThis.fetch;
      installSchemaCapture();
      expect(globalThis.fetch).toBe(firstHook);
    });
  });

  describe("uninstallSchemaCapture", () => {
    it("restores original fetch", () => {
      installSchemaCapture();
      uninstallSchemaCapture();
      expect(globalThis.fetch).toBe(originalFetch);
    });
  });

  describe("tool capture from API request", () => {
    it("captures Anthropic format tools", async () => {
      installSchemaCapture();

      // Mock fetch to not actually make request
      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      const hookedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        // Call hooked fetch to trigger capture
        await hookedFetch(input, init);
        return mockFetch(input, init);
      };

      // Simulate API request with tools
      const requestBody = {
        model: "claude-sonnet-4-20250514",
        messages: [],
        tools: [
          {
            name: "Bash",
            description: "Execute bash commands",
            input_schema: {
              type: "object",
              properties: {
                command: { type: "string" },
              },
              required: ["command"],
            },
          },
          {
            name: "Read",
            description: "Read file contents",
            input_schema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
            },
          },
        ],
      };

      await globalThis.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      expect(hasCapturedSchemas()).toBe(true);
      expect(getCapturedToolCount()).toBe(2);

      const schemas = getCapturedSchemas();
      expect(schemas?.get("Bash")).toBeDefined();
      expect(schemas?.get("Bash")?.description).toBe("Execute bash commands");
      expect(schemas?.get("Read")).toBeDefined();
    });

    it("captures OpenAI function format tools", async () => {
      installSchemaCapture();

      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      const hookedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        await hookedFetch(input, init);
        return mockFetch(input, init);
      };

      const requestBody = {
        model: "gpt-4",
        messages: [],
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "Search the web",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
              },
            },
          },
        ],
      };

      await globalThis.fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      expect(hasCapturedSchemas()).toBe(true);
      const schemas = getCapturedSchemas();
      expect(schemas?.get("search")?.description).toBe("Search the web");
    });

    it("only captures from first API request", async () => {
      installSchemaCapture();

      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      const hookedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        await hookedFetch(input, init);
        return mockFetch(input, init);
      };

      // First request
      await globalThis.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          tools: [{ name: "Tool1", description: "First", input_schema: {} }],
        }),
      });

      // Second request with different tools
      await globalThis.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          tools: [
            { name: "Tool2", description: "Second", input_schema: {} },
            { name: "Tool3", description: "Third", input_schema: {} },
          ],
        }),
      });

      // Should still have only the first tool
      expect(getCapturedToolCount()).toBe(1);
      expect(getCapturedSchemas()?.has("Tool1")).toBe(true);
      expect(getCapturedSchemas()?.has("Tool2")).toBe(false);
    });

    it("ignores non-AI API requests", async () => {
      installSchemaCapture();

      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      const hookedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        await hookedFetch(input, init);
        return mockFetch(input, init);
      };

      await globalThis.fetch("https://example.com/api", {
        method: "POST",
        body: JSON.stringify({
          tools: [{ name: "Ignored", description: "Not captured", input_schema: {} }],
        }),
      });

      expect(hasCapturedSchemas()).toBe(false);
    });
  });

  describe("getTotalSchemaTokens", () => {
    it("returns sum of all tool tokens", async () => {
      installSchemaCapture();

      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      const hookedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        await hookedFetch(input, init);
        return mockFetch(input, init);
      };

      await globalThis.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          tools: [
            { name: "A", description: "Tool A", input_schema: { type: "object" } },
            {
              name: "B",
              description: "Tool B with longer description",
              input_schema: { type: "object", properties: { x: { type: "string" } } },
            },
          ],
        }),
      });

      const total = getTotalSchemaTokens();
      expect(total).toBeGreaterThan(0);
    });

    it("returns 0 when no schemas captured", () => {
      expect(getTotalSchemaTokens()).toBe(0);
    });
  });

  describe("getRawCapturedTools", () => {
    it("returns original captured data for debugging", async () => {
      installSchemaCapture();

      const mockFetch = vi.fn().mockResolvedValue(new Response("{}"));
      const hookedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        await hookedFetch(input, init);
        return mockFetch(input, init);
      };

      const tools = [{ name: "Debug", description: "Test", input_schema: {} }];

      await globalThis.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ tools }),
      });

      const raw = getRawCapturedTools();
      expect(raw).toEqual(tools);
    });
  });
});
