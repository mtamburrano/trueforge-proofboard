export interface ContentDiffEvidenceLike {
  kind: string;
  result: string;
  details?: string;
}

export interface ParsedContentDiffEvidence {
  command: string;
  output: string;
  filesChanged: string[];
  outputTruncated: boolean;
}

export interface CompleteChangedFilesEvidenceLike {
  kind: string;
  result: string;
  details?: string;
}

export interface ParsedCompleteChangedFilesEvidence {
  command: string;
  output: string;
  filesChanged: string[];
}

const metadataOnlyDiffFlags = /(?:^|\s)--(?:stat|shortstat|numstat|name-only|name-status|summary|check)(?:\s|$)/;
const completeChangedFilesStatusOptions = [
  "--porcelain=v1",
  "--short",
].map((format) => [format, "--untracked-files=all"].sort().join(" "));
const completeChangedFilesStatusOptionsWithNul = [
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
].sort().join(" ");

export function isContentDiffCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  return /^git\s+diff(?:\s+[^;&|]+)*$/.test(normalized) &&
    !metadataOnlyDiffFlags.test(normalized);
}

export function isContentDiffOutput(output: string): boolean {
  return /^diff --git\s+.+$/m.test(output) &&
    (/^@@\s/m.test(output) ||
      (/^similarity index\s+\d+%$/m.test(output) &&
        /^rename from\s+.+$/m.test(output) &&
        /^rename to\s+.+$/m.test(output)));
}

export function isCompleteChangedFilesCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized.startsWith("git status ")) {
    return false;
  }
  const options = normalized.slice("git status ".length).split(" ").sort().join(" ");
  return completeChangedFilesStatusOptions.includes(options) ||
    options === completeChangedFilesStatusOptionsWithNul;
}

export function completeChangedFilesFromCommand(
  output: string,
  command: string,
): string[] | null {
  const normalized = normalizeCommand(command);
  if (!isCompleteChangedFilesCommand(normalized) || output.length > 12_000) {
    return null;
  }
  const usesNul = normalized.split(" ").includes("-z");
  const records = usesNul
    ? output.split("\u0000")
    : output.replace(/\r\n/g, "\n").split("\n");
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length === 0) {
      continue;
    }
    if (record.length < 4 || record[2] !== " " || !validStatusCode(record.slice(0, 2))) {
      return null;
    }
    const status = record.slice(0, 2);
    let file = record.slice(3);
    if (file.length === 0) {
      return null;
    }
    const isRenameOrCopy = status.includes("R") || status.includes("C");
    if (usesNul && isRenameOrCopy) {
      const source = records[index + 1];
      if (source === undefined || source.length === 0) {
        return null;
      }
      index += 1;
    } else if (!usesNul && isRenameOrCopy) {
      const separator = file.lastIndexOf(" -> ");
      if (separator <= 0 || separator + 4 >= file.length) {
        return null;
      }
      file = file.slice(separator + 4);
    }
    files.push(file);
  }
  return uniqueStrings(files);
}

export function parseCompleteChangedFilesEvidence(
  evidence: CompleteChangedFilesEvidenceLike,
): ParsedCompleteChangedFilesEvidence | null {
  if (
    evidence.kind !== "file_change" ||
    evidence.result !== "passed" ||
    evidence.details === undefined
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence.details) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.complete_changed_files !== true ||
      typeof parsed.command !== "string" || typeof parsed.output !== "string" ||
      !Array.isArray(parsed.changed_files)) {
    return null;
  }
  const observedFiles = completeChangedFilesFromCommand(parsed.output, parsed.command);
  if (observedFiles === null) {
    return null;
  }
  const manifest = uniqueStrings(parsed.changed_files.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  ));
  if (
    manifest.length !== parsed.changed_files.length ||
    manifest.length !== observedFiles.length ||
    manifest.some((file, index) => file !== observedFiles[index])
  ) {
    return null;
  }
  return {
    command: normalizeCommand(parsed.command),
    output: parsed.output,
    filesChanged: manifest,
  };
}

export function changedFilesFromDiff(output: string, command?: string): string[] {
  if (command !== undefined && !isContentDiffCommand(command)) {
    return [];
  }
  const files: string[] = [];
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    const header = parseDiffHeader(line);
    if (header === null) {
      continue;
    }
    const canonicalPath = header.after === "/dev/null" ? header.before : header.after;
    if (canonicalPath !== null && canonicalPath.length > 0 && canonicalPath !== "/dev/null") {
      files.push(canonicalPath);
    }
  }
  return uniqueStrings(files);
}

export function parseContentDiffEvidence(
  evidence: ContentDiffEvidenceLike,
): ParsedContentDiffEvidence | null {
  if (
    (evidence.kind !== "diff_summary" && evidence.kind !== "file_change") ||
    evidence.result !== "passed" ||
    evidence.details === undefined
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence.details) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.command !== "string" || typeof parsed.output !== "string") {
    return null;
  }
  const command = normalizeCommand(parsed.command);
  if (!isContentDiffCommand(command) || !isContentDiffOutput(parsed.output)) {
    return null;
  }
  const observedFiles = changedFilesFromDiff(parsed.output, command);
  if (observedFiles.length === 0) {
    return null;
  }

  const hasManifest = Object.prototype.hasOwnProperty.call(parsed, "changed_files") ||
    Object.prototype.hasOwnProperty.call(parsed, "changedFiles");
  const rawManifest = parsed.changed_files ?? parsed.changedFiles;
  let filesChanged = observedFiles;
  const outputTruncated = parsed.output_truncated === true || parsed.outputTruncated === true;
  if (hasManifest) {
    if (!Array.isArray(rawManifest)) {
      return null;
    }
    const manifest = uniqueStrings(rawManifest.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ));
    if (manifest.length !== rawManifest.length || manifest.some((file) => file.length > 500)) {
      return null;
    }
    const manifestSet = new Set(manifest);
    if (
      (!outputTruncated && (manifest.length !== observedFiles.length ||
        observedFiles.some((file) => !manifestSet.has(file)))) ||
      (outputTruncated && observedFiles.some((file) => !manifestSet.has(file)))
    ) {
      return null;
    }
    filesChanged = manifest;
  }

  return {
    command,
    output: parsed.output,
    filesChanged,
    outputTruncated,
  };
}

function parseDiffHeader(
  line: string,
): { before: string; after: string } | null {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) {
    return null;
  }
  const tokens = tokenizeHeader(line.slice(prefix.length));
  if (tokens === null || tokens.length !== 2) {
    return null;
  }
  const before = pathFromToken(tokens[0], "a/");
  const after = pathFromToken(tokens[1], "b/");
  return before === null || after === null ? null : { before, after };
}

function pathFromToken(value: string | undefined, prefix: "a/" | "b/"): string | null {
  if (value === undefined || !value.startsWith(prefix)) {
    return null;
  }
  return decodeGitPath(value.slice(prefix.length));
}

function tokenizeHeader(value: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (quoted) {
      if (escaped) {
        current += `\\${character}`;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' && current.length === 0) {
      quoted = true;
    } else if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quoted) {
    return null;
  }
  if (escaped) {
    current += "\\";
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function decodeGitPath(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\(.)/g, "$1");
  }
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function validStatusCode(value: string): boolean {
  return /^[ MADRCUTUXB?!]{2}$/.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
