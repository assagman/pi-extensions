/**
 * Custom Bedrock Gateway Extension
 *
 * Routes requests through a custom AI gateway that speaks the Bedrock
 * Converse protocol but authenticates via token instead of AWS SigV4.
 *
 * Configuration (env vars):
 *   CUSTOM_BEDROCK_URL      - Gateway base URL (e.g. https://gateway.example.com/bedrock)
 *   CUSTOM_BEDROCK_TOKEN    - Bearer token for the gateway
 *
 * Or hardcode values below if you prefer.
 *
 * Usage:
 *   cd ~/.pi/agent/extensions/custom-bedrock && bun install
 *   CUSTOM_BEDROCK_URL=https://... CUSTOM_BEDROCK_TOKEN=... pi
 *   Then /model -> select custom-bedrock/anthropic.claude-opus-4-6-...
 */

import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	StopReason as BedrockStopReason,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	type ContentBlock,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type Tool as BedrockTool,
	type ToolChoice,
	type ToolConfiguration,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";

import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	calculateCost,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Block = (TextContent | ThinkingContent | ToolCall) & {
	index?: number;
	partialJson?: string;
};

// ---------------------------------------------------------------------------
// Bedrock message conversion
// ---------------------------------------------------------------------------

function sanitize(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function createImageBlock(mimeType: string, data: string) {
	const formatMap: Record<string, ImageFormat> = {
		"image/jpeg": ImageFormat.JPEG,
		"image/jpg": ImageFormat.JPEG,
		"image/png": ImageFormat.PNG,
		"image/gif": ImageFormat.GIF,
		"image/webp": ImageFormat.WEBP,
	};
	const format = formatMap[mimeType];
	if (!format) throw new Error(`Unknown image type: ${mimeType}`);

	const bin = atob(data);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return { source: { bytes }, format };
}

function normalizeToolCallId(id: string): string {
	const s = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return s.length > 64 ? s.slice(0, 64) : s;
}

function buildSystemPrompt(systemPrompt: string | undefined): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;
	return [{ text: sanitize(systemPrompt) }];
}

function convertMessages(context: Context): Message[] {
	const result: Message[] = [];
	const messages = context.messages;

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];

		switch (m.role) {
			case "user":
				result.push({
					role: ConversationRole.USER,
					content:
						typeof m.content === "string"
							? [{ text: sanitize(m.content) }]
							: m.content.map((c) => {
									if (c.type === "text") return { text: sanitize(c.text) };
									if (c.type === "image") return { image: createImageBlock(c.mimeType, c.data) };
									throw new Error("Unknown user content type");
								}),
				});
				break;

			case "assistant": {
				if (m.content.length === 0) continue;
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					if (c.type === "text") {
						if (c.text.trim().length === 0) continue;
						contentBlocks.push({ text: sanitize(c.text) });
					} else if (c.type === "toolCall") {
						contentBlocks.push({
							toolUse: {
								toolUseId: normalizeToolCallId(c.id),
								name: c.name,
								input: c.arguments,
							},
						});
					} else if (c.type === "thinking") {
						if (c.thinking.trim().length === 0) continue;
						if (c.thinkingSignature && c.thinkingSignature.trim().length > 0) {
							contentBlocks.push({
								reasoningContent: {
									reasoningText: {
										text: sanitize(c.thinking),
										signature: c.thinkingSignature,
									},
								},
							});
						} else {
							contentBlocks.push({ text: sanitize(c.thinking) });
						}
					}
				}
				if (contentBlocks.length === 0) continue;
				result.push({ role: ConversationRole.ASSISTANT, content: contentBlocks });
				break;
			}

			case "toolResult": {
				const toolResults: ContentBlock.ToolResultMember[] = [];
				toolResults.push({
					toolResult: {
						toolUseId: normalizeToolCallId(m.toolCallId),
						content: m.content.map((c) =>
							c.type === "image"
								? { image: createImageBlock(c.mimeType, c.data) }
								: { text: sanitize(c.text) },
						),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				let j = i + 1;
				while (j < messages.length && messages[j].role === "toolResult") {
					const next = messages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: normalizeToolCallId(next.toolCallId),
							content: next.content.map((c) =>
								c.type === "image"
									? { image: createImageBlock(c.mimeType, c.data) }
									: { text: sanitize(c.text) },
							),
							status: next.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}
				i = j - 1;
				result.push({ role: ConversationRole.USER, content: toolResults });
				break;
			}
		}
	}

	return result;
}

function convertToolConfig(
	tools: Tool[] | undefined,
): ToolConfiguration | undefined {
	if (!tools?.length) return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => ({
		toolSpec: {
			name: tool.name,
			description: tool.description,
			inputSchema: { json: tool.parameters },
		},
	}));

	return { tools: bedrockTools, toolChoice: { auto: {} } };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return "stop";
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return "length";
		case BedrockStopReason.TOOL_USE:
			return "toolUse";
		default:
			return "error";
	}
}

// ---------------------------------------------------------------------------
// Stream event handlers
// ---------------------------------------------------------------------------

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	if (event.start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: event.start.toolUse.toolUseId || "",
			name: event.start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		try {
			block.arguments = JSON.parse(block.partialJson);
		} catch {}
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			if (delta.reasoningContent.signature) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
		}
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete block.index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			if (block.partialJson) {
				try {
					block.arguments = JSON.parse(block.partialJson);
				} catch {}
			}
			delete block.partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<Api>,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

// ---------------------------------------------------------------------------
// Stream implementation
// ---------------------------------------------------------------------------

function streamCustomBedrock(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const blocks = output.content as Block[];

		try {
			const config: BedrockRuntimeClientConfig = {
				region: "us-east-1",
				endpoint: model.baseUrl,
				// Disable SigV4 signing — the gateway handles auth via token
				credentials: async () => ({
					accessKeyId: "unused",
					secretAccessKey: "unused",
				}),
				signer: async () => ({
					sign: async (request: unknown) => request as any,
				}),
			};

			const client = new BedrockRuntimeClient(config);

			// Inject custom headers (Authorization, etc.) via middleware
			const apiKey = options?.apiKey;
			const customHeaders: Record<string, string> = {};

			// If model has headers from the provider config, include them
			if (model.headers) {
				Object.assign(customHeaders, model.headers);
			}

			// If apiKey is set and no Authorization header exists, add Bearer token
			if (apiKey && !customHeaders["Authorization"] && !customHeaders["authorization"]) {
				customHeaders["Authorization"] = `Bearer ${apiKey}`;
			}

			if (Object.keys(customHeaders).length > 0) {
				client.middlewareStack.add(
					(next) => async (args: unknown) => {
						const req = args as { request?: { headers?: Record<string, string> } };
						if (req.request?.headers) {
							for (const [key, value] of Object.entries(customHeaders)) {
								req.request.headers[key] = value;
							}
						}
						return next(args as any);
					},
					{ step: "build", name: "customBedrockHeadersMiddleware" },
				);
			}

			// Build thinking config if reasoning is requested
			let additionalFields: Record<string, any> | undefined;
			if (options?.reasoning && model.reasoning) {
				const defaultBudgets: Record<string, number> = {
					minimal: 1024,
					low: 2048,
					medium: 8192,
					high: 16384,
					xhigh: 16384,
				};
				const level = options.reasoning === "xhigh" ? "high" : options.reasoning;
				const budget =
					options.thinkingBudgets?.[level as keyof typeof options.thinkingBudgets] ??
					defaultBudgets[options.reasoning] ??
					8192;

				additionalFields = {
					thinking: { type: "enabled", budget_tokens: budget },
				};
			}

			const command = new ConverseStreamCommand({
				modelId: model.id,
				messages: convertMessages(context),
				system: buildSystemPrompt(context.systemPrompt),
				inferenceConfig: {
					maxTokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
					temperature: options?.temperature,
				},
				toolConfig: convertToolConfig(context.tools),
				additionalModelRequestFields: additionalFields,
			});

			const response = await client.send(command, { abortSignal: options?.signal });

			for await (const item of response.stream!) {
				if (item.messageStart) {
					stream.push({ type: "start", partial: output });
				} else if (item.contentBlockStart) {
					handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
				} else if (item.contentBlockDelta) {
					handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
				} else if (item.contentBlockStop) {
					handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
				} else if (item.messageStop) {
					output.stopReason = mapStopReason(item.messageStop.stopReason);
				} else if (item.metadata) {
					handleMetadata(item.metadata, model, output);
				} else if (item.internalServerException) {
					throw new Error(`Internal server error: ${item.internalServerException.message}`);
				} else if (item.modelStreamErrorException) {
					throw new Error(`Model stream error: ${item.modelStreamErrorException.message}`);
				} else if (item.validationException) {
					throw new Error(`Validation error: ${item.validationException.message}`);
				} else if (item.throttlingException) {
					throw new Error(`Throttling error: ${item.throttlingException.message}`);
				} else if (item.serviceUnavailableException) {
					throw new Error(`Service unavailable: ${item.serviceUnavailableException.message}`);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as Block).index;
				delete (block as Block).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerProvider("custom-bedrock", {
		baseUrl: "CUSTOM_BEDROCK_URL",       // env var name -> resolved at runtime
		apiKey: "CUSTOM_BEDROCK_TOKEN",      // env var name -> resolved at runtime
		api: "custom-bedrock-converse",
		authHeader: true,

		models: [
			{
				id: "global.anthropic.claude-opus-4-6-v1",
				name: "Claude Opus 4.6 (Custom Bedrock)",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 200000,
				maxTokens: 32000,
				cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
			},
			{
				id: "global.anthropic.claude-sonnet-4-6",
				name: "Claude Sonnet 4.6 (Custom Bedrock)",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 200000,
				maxTokens: 64000,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			},
		],

		streamSimple: streamCustomBedrock,
	});
}
