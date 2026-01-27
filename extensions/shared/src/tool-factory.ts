/**
 * Shared tool creation helpers for Pi extensions.
 */
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Static, TSchema } from "@sinclair/typebox";

/**
 * Create a tool definition with a synchronous handler.
 * Wraps the handler in try/catch and formats errors consistently.
 */
export function createTool<T extends TSchema>(
  name: string,
  label: string,
  description: string,
  parameters: T,
  handler: (params: Static<T>) => string
): ToolDefinition<T, undefined> {
  return {
    name,
    label,
    description,
    parameters,
    execute: async (
      _toolCallId: string,
      params: Static<T>,
      _onUpdate: AgentToolUpdateCallback<undefined> | undefined,
      _ctx: ExtensionContext,
      _signal?: AbortSignal
    ): Promise<AgentToolResult<undefined>> => {
      try {
        const output = handler(params);
        return { content: [{ type: "text", text: output }], details: undefined };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], details: undefined };
      }
    },
  };
}
