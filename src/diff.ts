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

const metadataOnlyDiffFlags = /(?:^|\s)--(?:stat|shortstat|numstat|name-only|name-status|summary|check)(?:\s|$)/;

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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
