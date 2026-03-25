import type { ConfigLoadResult, LoadConfigOptions, ProfileLoadStatus } from "./config.js";
import { loadConfig } from "./config.js";
import { streamCustomBedrock } from "./stream.js";

export interface ProviderRegistrar {
  registerProvider: (name: string, config: object) => void;
  unregisterProvider?: (name: string) => void;
}

export interface RuntimeState {
  configPath: string | null;
  source: ConfigLoadResult["source"];
  statuses: ProfileLoadStatus[];
  errors: string[];
  registeredProviders: string[];
}

export const initialRuntimeState = (): RuntimeState => ({
  configPath: null,
  source: "missing",
  statuses: [],
  errors: [],
  registeredProviders: [],
});

export async function applyConfigToPi(
  pi: ProviderRegistrar,
  result: ConfigLoadResult,
  state: RuntimeState
): Promise<void> {
  for (const providerName of state.registeredProviders) {
    pi.unregisterProvider?.(providerName);
  }

  const registeredProviders: string[] = [];
  for (const profile of result.profiles) {
    pi.registerProvider(profile.providerName, {
      baseUrl: profile.baseUrl,
      apiKey: profile.apiKey,
      headers: profile.headers,
      api: "custom-bedrock-converse",
      authHeader: true,
      models: profile.models,
      streamSimple: streamCustomBedrock,
    });
    registeredProviders.push(profile.providerName);
  }

  state.configPath = result.configPath;
  state.source = result.source;
  state.statuses = result.statuses;
  state.errors = result.errors;
  state.registeredProviders = registeredProviders;
}

export async function reloadProviders(
  pi: ProviderRegistrar,
  state: RuntimeState,
  options: LoadConfigOptions
): Promise<ConfigLoadResult> {
  const result = await loadConfig(options);
  await applyConfigToPi(pi, result, state);
  return result;
}

export function renderStatus(state: RuntimeState, cwd: string): string[] {
  const lines: string[] = ["custom-bedrock status"];
  lines.push(`cwd: ${cwd}`);
  lines.push(`config: ${state.configPath ?? "not found"}`);
  lines.push(`source: ${state.source}`);

  if (state.statuses.length === 0) {
    lines.push("profiles: none loaded");
  } else {
    lines.push("profiles:");
    for (const status of state.statuses) {
      lines.push(
        `- ${status.profileName} -> ${status.providerName} (${status.ok ? "ok" : "error"})`
      );
      for (const issue of status.issues) {
        lines.push(`  • ${issue}`);
      }
    }
  }

  if (state.registeredProviders.length > 0) {
    lines.push("registered providers:");
    for (const provider of state.registeredProviders) {
      lines.push(`- ${provider}`);
    }
  }

  if (state.errors.length > 0) {
    lines.push("errors:");
    for (const error of state.errors) {
      lines.push(`- ${error}`);
    }
  }

  return lines;
}
