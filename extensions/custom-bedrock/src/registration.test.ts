import { describe, expect, it, vi } from "vitest";
import type { ConfigLoadResult } from "./config.js";
import { applyConfigToPi, initialRuntimeState, renderStatus } from "./registration.js";

describe("applyConfigToPi", () => {
  it("unregisters previous providers before registering new ones", async () => {
    const state = initialRuntimeState();
    state.registeredProviders = ["custom-bedrock-old"];

    const registerProvider = vi.fn();
    const unregisterProvider = vi.fn();

    const result: ConfigLoadResult = {
      configPath: "/repo/.pi/custom-bedrock/models.json",
      source: "project",
      errors: [],
      statuses: [
        { profileName: "prod", providerName: "custom-bedrock-prod", ok: true, issues: [] },
      ],
      profiles: [
        {
          profileName: "prod",
          providerName: "custom-bedrock-prod",
          baseUrl: "https://gateway.example.com",
          apiKey: "secret",
          headers: { "x-tenant": "tenant-a" },
          models: [
            {
              id: "global.anthropic.claude-sonnet-4-6",
              name: "Claude Sonnet 4.6 [prod]",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 200000,
              maxTokens: 64000,
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            },
          ],
        },
      ],
    };

    await applyConfigToPi({ registerProvider, unregisterProvider }, result, state);

    expect(unregisterProvider).toHaveBeenCalledWith("custom-bedrock-old");
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(
      "custom-bedrock-prod",
      expect.objectContaining({
        baseUrl: "https://gateway.example.com",
        apiKey: "secret",
        headers: { "x-tenant": "tenant-a" },
        api: "custom-bedrock-converse",
        authHeader: true,
        models: expect.arrayContaining([
          expect.objectContaining({ id: "global.anthropic.claude-sonnet-4-6" }),
        ]),
      })
    );
    expect(state.registeredProviders).toEqual(["custom-bedrock-prod"]);
  });
});

describe("renderStatus", () => {
  it("renders a useful status summary", () => {
    const state = initialRuntimeState();
    state.configPath = "/repo/.pi/custom-bedrock/models.json";
    state.source = "project";
    state.statuses = [
      { profileName: "prod", providerName: "custom-bedrock-prod", ok: true, issues: [] },
      {
        profileName: "staging",
        providerName: "custom-bedrock-staging",
        ok: false,
        issues: ["missing env var STAGING_TOKEN"],
      },
    ];
    state.errors = ["missing env var STAGING_TOKEN"];
    state.registeredProviders = ["custom-bedrock-prod"];

    expect(renderStatus(state, "/repo")).toEqual([
      "custom-bedrock status",
      "cwd: /repo",
      "config: /repo/.pi/custom-bedrock/models.json",
      "source: project",
      "profiles:",
      "- prod -> custom-bedrock-prod (ok)",
      "- staging -> custom-bedrock-staging (error)",
      "  • missing env var STAGING_TOKEN",
      "registered providers:",
      "- custom-bedrock-prod",
      "errors:",
      "- missing env var STAGING_TOKEN",
    ]);
  });
});
