import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  MissionDomainError,
  MissionRepository,
  MissionState,
  validateMissionState,
} from "./domain.js";

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export class JsonMissionRepository implements MissionRepository {
  constructor(private readonly filePath: string) {
    if (filePath.trim().length === 0) {
      throw new MissionDomainError("invalid_input", "The mission state file path must not be empty.");
    }
  }

  async load(): Promise<MissionState | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return null;
      }
      throw new MissionDomainError(
        "persistence_error",
        `Unable to read mission state from ${this.filePath}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new MissionDomainError(
        "persistence_error",
        `Mission state at ${this.filePath} is not valid JSON.`,
      );
    }

    try {
      return validateMissionState(parsed);
    } catch (error) {
      if (error instanceof MissionDomainError) {
        throw new MissionDomainError(
          "persistence_error",
          `Mission state at ${this.filePath} is invalid: ${error.message}`,
        );
      }
      throw error;
    }
  }

  async save(state: MissionState): Promise<void> {
    const validated = validateMissionState(state);
    const directory = dirname(this.filePath);
    const temporaryPath = join(
      directory,
      `.${basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } catch {
      try {
        await unlink(temporaryPath);
      } catch {
        // The temporary file may not have been created or may already be gone.
      }
      throw new MissionDomainError(
        "persistence_error",
        `Unable to persist mission state to ${this.filePath}.`,
      );
    }
  }
}

export { JsonMissionRepository as FileMissionRepository };
