import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODELS,
  getConfigPaths,
  loadConfig,
  resolveValue,
  slugifyProfileName,
} from "./config.js";

describe("config helpers", () => {
  it("resolves literal strings", async () => {
    await expect(resolveValue("https://example.com", { label: "test" })).resolves.toBe(
      "https://example.com"
    );
  });

  it("resolves env-backed values", async () => {
    await expect(
      resolveValue({ env: "BEDROCK_URL" }, { label: "test", env: { BEDROCK_URL: "https://gw" } })
    ).resolves.toBe("https://gw");
  });

  it("resolves command-backed values", async () => {
    const execCommand = vi.fn(async () => "secret-token");
    await expect(
      resolveValue({ command: "op read secret" }, { label: "test", execCommand })
    ).resolves.toBe("secret-token");
    expect(execCommand).toHaveBeenCalledWith("op read secret");
  });

  it("builds project and user config paths", () => {
    expect(getConfigPaths("/repo", "/home/test")).toEqual({
      project: "/repo/.pi/custom-bedrock/models.json",
      user: "/home/test/.pi/agent/custom-bedrock/models.json",
    });
  });

  it("slugifies profile names for provider ids", () => {
    expect(slugifyProfileName("Prod EU/1")).toBe("prod-eu-1");
  });
});

describe("loadConfig", () => {
  it("prefers project config over user config", async () => {
    const result = await loadConfig({
      cwd: "/repo",
      homeDir: "/home/test",
      fileExists: async (path) =>
        path === "/repo/.pi/custom-bedrock/models.json" ||
        path === "/home/test/.pi/agent/custom-bedrock/models.json",
      readTextFile: async (path) =>
        path === "/repo/.pi/custom-bedrock/models.json"
          ? JSON.stringify({
              profiles: {
                prod: {
                  baseUrl: "https://project",
                  apiKey: "token",
                },
              },
            })
          : JSON.stringify({
              profiles: {
                user: {
                  baseUrl: "https://user",
                  apiKey: "token",
                },
              },
            }),
    });

    expect(result.source).toBe("project");
    expect(result.configPath).toBe("/repo/.pi/custom-bedrock/models.json");
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.profileName).toBe("prod");
  });

  it("uses built-in latest Claude models when none are configured", async () => {
    const result = await loadConfig({
      cwd: "/repo",
      homeDir: "/home/test",
      fileExists: async (path) => path === "/repo/.pi/custom-bedrock/models.json",
      readTextFile: async () =>
        JSON.stringify({
          profiles: {
            prod: {
              baseUrl: "https://gateway.example.com",
              apiKey: "token",
            },
          },
        }),
    });

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.models).toHaveLength(DEFAULT_MODELS.length);
    expect(result.profiles[0]?.models[0]?.name).toContain("[prod]");
  });

  it("supports env and command resolution plus merged headers", async () => {
    const execCommand = vi.fn(async () => "tenant-a");
    const result = await loadConfig({
      cwd: "/repo",
      homeDir: "/home/test",
      env: {
        BEDROCK_URL: "https://gateway.example.com",
        BEDROCK_TOKEN: "secret",
      },
      execCommand,
      fileExists: async (path) => path === "/repo/.pi/custom-bedrock/models.json",
      readTextFile: async () =>
        JSON.stringify({
          defaults: {
            headers: {
              "x-default": "literal-header",
            },
          },
          profiles: {
            prod: {
              baseUrl: { env: "BEDROCK_URL" },
              apiKey: { env: "BEDROCK_TOKEN" },
              headers: {
                "x-tenant": { command: "read tenant" },
              },
            },
          },
        }),
    });

    expect(result.profiles[0]).toMatchObject({
      baseUrl: "https://gateway.example.com",
      apiKey: "secret",
      headers: {
        "x-default": "literal-header",
        "x-tenant": "tenant-a",
      },
    });
    expect(execCommand).toHaveBeenCalledWith("read tenant");
  });

  it("marks only the bad profile as invalid", async () => {
    const result = await loadConfig({
      cwd: "/repo",
      homeDir: "/home/test",
      env: {
        GOOD_URL: "https://good.example.com",
        GOOD_TOKEN: "good-token",
      },
      fileExists: async (path) => path === "/repo/.pi/custom-bedrock/models.json",
      readTextFile: async () =>
        JSON.stringify({
          profiles: {
            good: {
              baseUrl: { env: "GOOD_URL" },
              apiKey: { env: "GOOD_TOKEN" },
            },
            bad: {
              baseUrl: { env: "MISSING_URL" },
              apiKey: "token",
            },
          },
        }),
    });

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.profileName).toBe("good");
    expect(result.statuses).toEqual([
      { profileName: "good", providerName: "custom-bedrock-good", ok: true, issues: [] },
      {
        profileName: "bad",
        providerName: "custom-bedrock-bad",
        ok: false,
        issues: ["profiles.bad.baseUrl: missing env var MISSING_URL"],
      },
    ]);
  });
});
