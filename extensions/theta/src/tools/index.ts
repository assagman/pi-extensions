import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DiffService } from "../services/diff-service.js";
import { ReviewService } from "../services/review-service.js";

export function registerTools(pi: ExtensionAPI) {
    const diffService = new DiffService();
    const reviewService = new ReviewService();

    pi.registerTool({
        name: "theta_diff",
        label: "Get Diff (Theta)",
        description: "Get the git diff between two references (defaults to unstaged changes).",
        parameters: Type.Object({
            base: Type.Optional(Type.String({ description: "Base commit/branch" })),
            head: Type.Optional(Type.String({ description: "Head commit/branch" })),
        }) as any,
        execute: async (id, params: any) => {
            try {
                const { raw, files } = await diffService.getDiff(params.base, params.head);
                return {
                    content: [{ type: "text", text: raw || "No changes." }],
                    details: { files }
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Error: ${error.message}` }],
                    details: { files: [] },
                    isError: true
                };
            }
        }
    });

    pi.registerTool({
        name: "theta_review",
        label: "Request Review (Theta)",
        description: "Get the diff content and optional visual link for code review.",
        parameters: Type.Object({
            base: Type.Optional(Type.String({ description: "Base commit/branch" })),
            head: Type.Optional(Type.String({ description: "Head commit/branch" })),
        }) as any,
        execute: async (id, params: any, onUpdate) => {
            try {
                onUpdate?.({ content: [{ type: "text", text: "Generating..." }], details: {} });
                
                const { url, diff } = await reviewService.runReview(params.base, params.head);
                
                let text = "";
                if (url) {
                    text += `Visual Review Link: ${url}\n\n`;
                } else {
                    text += `(Visual review link unavailable)\n\n`;
                }
                
                text += "Diff Content:\n" + (diff || "No changes.");
                
                return {
                    content: [{ type: "text", text }],
                    details: { url, hasDiff: !!diff }
                };
            } catch (error: any) {
                return {
                    content: [{ type: "text", text: `Error: ${error.message}` }],
                    details: { url: undefined, hasDiff: false },
                    isError: true
                };
            }
        }
    });
}
