export const DEFAULT_TRUEFORGE_MODEL = "alibaba/qwen3-7-plus";

export interface MissionRuntimeConfig {
  host: string;
  port: number;
  statePath: string;
  baseUrl: string;
  model: string;
  githubServer: string;
}

export function resolveMissionRuntimeConfig(
  environment: Record<string, string | undefined>,
): MissionRuntimeConfig {
  const port = Number(environment.TRUEFORGE_UI_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TRUEFORGE_UI_PORT must be a valid TCP port.");
  }
  return {
    host: environment.TRUEFORGE_UI_HOST?.trim() || "127.0.0.1",
    port,
    statePath: environment.TRUEFORGE_MISSION_STATE?.trim() || ".trueforge/mission-state.json",
    baseUrl: environment.TRUEFORGE_BASE_URL?.trim() || "http://localhost:8790",
    model: environment.TRUEFORGE_MODEL?.trim() || DEFAULT_TRUEFORGE_MODEL,
    githubServer: environment.TRUEFORGE_GITHUB_SERVER?.trim() || "github",
  };
}
