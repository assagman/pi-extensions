import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ResolvableValue = string | { env: string } | { command: string };

export interface CostConfig {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: CostConfig;
}

export interface ProfileConfig {
  baseUrl: ResolvableValue;
  apiKey: ResolvableValue;
  headers?: Record<string, ResolvableValue>;
  models?: ModelConfig[];
}

export interface CustomBedrockConfig {
  defaults?: {
    headers?: Record<string, ResolvableValue>;
    models?: ModelConfig[];
  };
  profiles: Record<string, ProfileConfig>;
}

export interface ResolvedModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface ResolvedProfile {
  profileName: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  models: ResolvedModel[];
}

export interface ProfileLoadStatus {
  profileName: string;
  providerName: string;
  ok: boolean;
  issues: string[];
}

export interface ConfigLoadResult {
  configPath: string | null;
  source: "project" | "user" | "missing";
  profiles: ResolvedProfile[];
  statuses: ProfileLoadStatus[];
  errors: string[];
}

export interface LoadConfigOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  fileExists?: (path: string) => Promise<boolean>;
  readTextFile?: (path: string) => Promise<string>;
  execCommand?: (command: string) => Promise<string>;
}

export const DEFAULT_MODELS: ResolvedModel[] = [
  {
    id: "global.anthropic.claude-opus-4-6-v1",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: "global.anthropic.claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
];

function defaultFileExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

function defaultReadTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function defaultExecCommand(command: string): Promise<string> {
  const { stdout } = await execFileAsync("sh", ["-lc", command]);
  return stdout.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): Array<"text" | "image"> | null {
  if (!Array.isArray(value)) return null;
  if (value.every((item) => item === "text" || item === "image")) {
    return value as Array<"text" | "image">;
  }
  return null;
}

export function getConfigPaths(cwd: string, homeDir = homedir()) {
  return {
    project: join(cwd, ".pi", "custom-bedrock", "models.json"),
    user: join(homeDir, ".pi", "agent", "custom-bedrock", "models.json"),
  };
}

export function slugifyProfileName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "profile"
  );
}

export async function resolveValue(
  value: ResolvableValue,
  options: {
    env?: Record<string, string | undefined>;
    execCommand?: (command: string) => Promise<string>;
    label: string;
  }
): Promise<string> {
  const env = options.env ?? process.env;
  const execCommand = options.execCommand ?? defaultExecCommand;

  if (typeof value === "string") {
    return value;
  }

  if ("env" in value) {
    const resolved = env[value.env];
    if (!resolved) {
      throw new Error(`${options.label}: missing env var ${value.env}`);
    }
    return resolved;
  }

  if ("command" in value) {
    const resolved = await execCommand(value.command);
    if (!resolved) {
      throw new Error(`${options.label}: command returned empty output`);
    }
    return resolved;
  }

  throw new Error(`${options.label}: unsupported value`);
}

function normalizeModel(model: ModelConfig): ResolvedModel {
  const builtin = DEFAULT_MODELS.find((candidate) => candidate.id === model.id);
  const fallback: ResolvedModel = builtin ?? {
    id: model.id,
    name: model.id,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };

  return {
    id: model.id,
    name: model.name ?? fallback.name,
    reasoning: model.reasoning ?? fallback.reasoning,
    input: model.input ?? fallback.input,
    contextWindow: model.contextWindow ?? fallback.contextWindow,
    maxTokens: model.maxTokens ?? fallback.maxTokens,
    cost: {
      input: model.cost?.input ?? fallback.cost.input,
      output: model.cost?.output ?? fallback.cost.output,
      cacheRead: model.cost?.cacheRead ?? fallback.cost.cacheRead,
      cacheWrite: model.cost?.cacheWrite ?? fallback.cost.cacheWrite,
    },
  };
}

function parseModel(input: unknown, label: string): ModelConfig {
  if (!isObject(input)) {
    throw new Error(`${label}: expected object`);
  }
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new Error(`${label}: model id is required`);
  }

  const parsed: ModelConfig = { id: input.id };
  if (input.name !== undefined) {
    if (typeof input.name !== "string") throw new Error(`${label}: name must be a string`);
    parsed.name = input.name;
  }
  if (input.reasoning !== undefined) {
    if (typeof input.reasoning !== "boolean")
      throw new Error(`${label}: reasoning must be boolean`);
    parsed.reasoning = input.reasoning;
  }
  if (input.input !== undefined) {
    const modalities = asStringArray(input.input);
    if (!modalities) throw new Error(`${label}: input must be an array of text/image`);
    parsed.input = modalities;
  }
  if (input.contextWindow !== undefined) {
    if (typeof input.contextWindow !== "number")
      throw new Error(`${label}: contextWindow must be a number`);
    parsed.contextWindow = input.contextWindow;
  }
  if (input.maxTokens !== undefined) {
    if (typeof input.maxTokens !== "number")
      throw new Error(`${label}: maxTokens must be a number`);
    parsed.maxTokens = input.maxTokens;
  }
  if (input.cost !== undefined) {
    if (!isObject(input.cost)) throw new Error(`${label}: cost must be an object`);
    parsed.cost = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const value = input.cost[key];
      if (value !== undefined) {
        if (typeof value !== "number") throw new Error(`${label}: cost.${key} must be a number`);
        parsed.cost[key] = value;
      }
    }
  }
  return parsed;
}

function parseResolvableValue(input: unknown, label: string): ResolvableValue {
  if (typeof input === "string") {
    return input;
  }
  if (!isObject(input)) {
    throw new Error(`${label}: expected string or object`);
  }
  if (typeof input.env === "string") {
    return { env: input.env };
  }
  if (typeof input.command === "string") {
    return { command: input.command };
  }
  throw new Error(`${label}: expected string, { env }, or { command }`);
}

function parseHeaders(input: unknown, label: string): Record<string, ResolvableValue> {
  if (!isObject(input)) {
    throw new Error(`${label}: expected an object`);
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      parseResolvableValue(value, `${label}.${key}`),
    ])
  );
}

function parseConfig(json: string): CustomBedrockConfig {
  const parsed = JSON.parse(json) as unknown;
  if (!isObject(parsed)) {
    throw new Error("config root must be an object");
  }
  if (!isObject(parsed.profiles) || Object.keys(parsed.profiles).length === 0) {
    throw new Error("profiles must be a non-empty object");
  }

  const config: CustomBedrockConfig = {
    profiles: {},
  };

  if (parsed.defaults !== undefined) {
    if (!isObject(parsed.defaults)) throw new Error("defaults must be an object");
    config.defaults = {};
    if (parsed.defaults.headers !== undefined) {
      config.defaults.headers = parseHeaders(parsed.defaults.headers, "defaults.headers");
    }
    if (parsed.defaults.models !== undefined) {
      if (!Array.isArray(parsed.defaults.models))
        throw new Error("defaults.models must be an array");
      config.defaults.models = parsed.defaults.models.map((model, index) =>
        parseModel(model, `defaults.models[${index}]`)
      );
    }
  }

  for (const [name, profile] of Object.entries(parsed.profiles)) {
    if (!isObject(profile)) {
      throw new Error(`profiles.${name} must be an object`);
    }
    const parsedProfile: ProfileConfig = {
      baseUrl: parseResolvableValue(profile.baseUrl, `profiles.${name}.baseUrl`),
      apiKey: parseResolvableValue(profile.apiKey, `profiles.${name}.apiKey`),
    };
    if (profile.headers !== undefined) {
      parsedProfile.headers = parseHeaders(profile.headers, `profiles.${name}.headers`);
    }
    if (profile.models !== undefined) {
      if (!Array.isArray(profile.models))
        throw new Error(`profiles.${name}.models must be an array`);
      parsedProfile.models = profile.models.map((model, index) =>
        parseModel(model, `profiles.${name}.models[${index}]`)
      );
    }
    config.profiles[name] = parsedProfile;
  }

  return config;
}

async function resolveHeaders(
  headers: Record<string, ResolvableValue> | undefined,
  env: Record<string, string | undefined>,
  execCommand: (command: string) => Promise<string>,
  label: string
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  if (!headers) return resolved;

  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = await resolveValue(value, { env, execCommand, label: `${label}.${key}` });
  }
  return resolved;
}

export async function loadConfig(options: LoadConfigOptions): Promise<ConfigLoadResult> {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? defaultFileExists;
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const execCommand = options.execCommand ?? defaultExecCommand;
  const paths = getConfigPaths(options.cwd, options.homeDir);

  let configPath: string | null = null;
  let source: ConfigLoadResult["source"] = "missing";

  if (await fileExists(paths.project)) {
    configPath = paths.project;
    source = "project";
  } else if (await fileExists(paths.user)) {
    configPath = paths.user;
    source = "user";
  }

  if (!configPath) {
    return {
      configPath: null,
      source,
      profiles: [],
      statuses: [],
      errors: [
        `No config found. Checked: ${paths.project}`,
        `No config found. Checked: ${paths.user}`,
      ],
    };
  }

  let config: CustomBedrockConfig;
  try {
    config = parseConfig(await readTextFile(configPath));
  } catch (error) {
    return {
      configPath,
      source,
      profiles: [],
      statuses: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const profiles: ResolvedProfile[] = [];
  const statuses: ProfileLoadStatus[] = [];

  let defaultHeaders: Record<string, string> = {};
  try {
    defaultHeaders = await resolveHeaders(
      config.defaults?.headers,
      env,
      execCommand,
      "defaults.headers"
    );
  } catch (error) {
    return {
      configPath,
      source,
      profiles: [],
      statuses: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  const defaultModels = (config.defaults?.models ?? DEFAULT_MODELS).map(normalizeModel);
  const providerNames = new Set<string>();

  for (const [profileName, profile] of Object.entries(config.profiles)) {
    const providerName = `custom-bedrock-${slugifyProfileName(profileName)}`;
    const issues: string[] = [];

    if (providerNames.has(providerName)) {
      issues.push(`provider name collision for profile ${profileName}`);
      statuses.push({ profileName, providerName, ok: false, issues });
      continue;
    }
    providerNames.add(providerName);

    try {
      const baseUrl = await resolveValue(profile.baseUrl, {
        env,
        execCommand,
        label: `profiles.${profileName}.baseUrl`,
      });
      const apiKey = await resolveValue(profile.apiKey, {
        env,
        execCommand,
        label: `profiles.${profileName}.apiKey`,
      });
      const headers = {
        ...defaultHeaders,
        ...(await resolveHeaders(
          profile.headers,
          env,
          execCommand,
          `profiles.${profileName}.headers`
        )),
      };
      const modelSource = profile.models ?? defaultModels;
      const models = modelSource
        .map((model) => normalizeModel(model))
        .map((model) => ({
          ...model,
          name: `${model.name} [${profileName}]`,
        }));

      profiles.push({
        profileName,
        providerName,
        baseUrl,
        apiKey,
        headers,
        models,
      });
      statuses.push({ profileName, providerName, ok: true, issues });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
      statuses.push({ profileName, providerName, ok: false, issues });
    }
  }

  return {
    configPath,
    source,
    profiles,
    statuses,
    errors: statuses.flatMap((status) => status.issues),
  };
}
