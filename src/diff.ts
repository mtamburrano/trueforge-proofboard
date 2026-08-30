import { PRIMARY_SANDBOX_REPOSITORY_ROOT } from "./fixture.js";

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

export interface CompleteChangedFileStatus {
  file: string;
  status: string;
}

export interface ParsedDelegatedWorkspaceTreeSnapshot {
  command: string;
  output: string;
  treeRef: string;
}

export interface ParsedDelegatedWorkspaceDelta {
  command: string;
  output: string;
  startTreeRef: string;
  missionStartTreeRef: string;
  endTreeRef: string;
  currentChangedFiles: string[];
  cumulativeChangedFiles: string[];
  currentDeltaOutput: string;
  cumulativeDeltaOutput: string;
}

export interface DelegatedWorkspaceDeltaEvidenceLike {
  kind: string;
  result: string;
  details?: string;
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

export const DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND = [
  "set -eu",
  "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR",
  `canonical_root="${PRIMARY_SANDBOX_REPOSITORY_ROOT}"`,
  "canonical_physical_root=\"$(cd \"$canonical_root\" && pwd -P)\"",
  "repository_root=\"$(git -C \"$canonical_root\" rev-parse --show-toplevel)\"",
  "repository_physical_root=\"$(cd \"$repository_root\" && pwd -P)\"",
  "if [ \"$repository_physical_root\" != \"$canonical_physical_root\" ]; then exit 1; fi",
  "cd \"$repository_physical_root\"",
  "snapshot_index=\"$(mktemp)\"",
  "trap 'rm -f \"$snapshot_index\"' EXIT",
  "GIT_INDEX_FILE=\"$snapshot_index\" git read-tree HEAD",
  "GIT_INDEX_FILE=\"$snapshot_index\" git add --all -- .",
  "tree_ref=\"$(GIT_INDEX_FILE=\"$snapshot_index\" git write-tree)\"",
  "printf 'TRUEFORGE_WORKSPACE_TREE %s\\n' \"$tree_ref\"",
].join("\n");

const treeRefPattern = "[0-9a-fA-F]{40,64}";

export function buildDelegatedWorkspaceDeltaCommand(
  startTreeRef: string,
  missionStartTreeRef: string,
): string {
  assertTreeRef(startTreeRef);
  assertTreeRef(missionStartTreeRef);
  return [
    "set -eu",
    "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR",
    `canonical_root="${PRIMARY_SANDBOX_REPOSITORY_ROOT}"`,
    "canonical_physical_root=\"$(cd \"$canonical_root\" && pwd -P)\"",
    "repository_root=\"$(git -C \"$canonical_root\" rev-parse --show-toplevel)\"",
    "repository_physical_root=\"$(cd \"$repository_root\" && pwd -P)\"",
    "if [ \"$repository_physical_root\" != \"$canonical_physical_root\" ]; then exit 1; fi",
    "cd \"$repository_physical_root\"",
    "snapshot_index=\"$(mktemp)\"",
    "trap 'rm -f \"$snapshot_index\"' EXIT",
    "GIT_INDEX_FILE=\"$snapshot_index\" git read-tree HEAD",
    "GIT_INDEX_FILE=\"$snapshot_index\" git add --all -- .",
    "end_tree=\"$(GIT_INDEX_FILE=\"$snapshot_index\" git write-tree)\"",
    `printf 'TRUEFORGE_WORKSPACE_DELTA start=${startTreeRef} mission_start=${missionStartTreeRef} end=%s\\n' \"$end_tree\"`,
    "printf 'TRUEFORGE_WORKSPACE_DELTA current_begin\\n'",
    `git diff --no-ext-diff --find-renames=50% --name-status '${startTreeRef}' \"$end_tree\" --`,
    "printf 'TRUEFORGE_WORKSPACE_DELTA current_end\\n'",
    "printf 'TRUEFORGE_WORKSPACE_DELTA cumulative_begin\\n'",
    `git diff --no-ext-diff --find-renames=50% --name-status '${missionStartTreeRef}' \"$end_tree\" --`,
    "printf 'TRUEFORGE_WORKSPACE_DELTA cumulative_end\\n'",
  ].join("\n");
}

export function isDelegatedWorkspaceTreeSnapshotCommand(command: string): boolean {
  return normalizeCommand(command) === normalizeCommand(DELEGATED_WORKSPACE_TREE_SNAPSHOT_COMMAND);
}

export function delegatedWorkspaceDeltaRefsFromCommand(
  command: string,
): { startTreeRef: string; missionStartTreeRef: string } | null {
  const normalized = normalizeCommand(command);
  const sameRefTemplate = normalizeCommand(
    buildDelegatedWorkspaceDeltaCommand("a".repeat(40), "a".repeat(40)),
  );
  const sameRefMatch = normalized.match(
    new RegExp(
      `^${escapeRegExp(sameRefTemplate)
        .replaceAll(escapeRegExp("a".repeat(40)), `(${treeRefPattern})`)}$`,
    ),
  );
  if (sameRefMatch !== null && sameRefMatch[1] !== undefined) {
    const sameTreeRef = sameRefMatch[1];
    if (
      normalizeCommand(buildDelegatedWorkspaceDeltaCommand(sameTreeRef, sameTreeRef)) === normalized
    ) {
      return { startTreeRef: sameTreeRef, missionStartTreeRef: sameTreeRef };
    }
  }
  const canonicalTemplate = normalizeCommand(
    buildDelegatedWorkspaceDeltaCommand("a".repeat(40), "b".repeat(40)),
  );
  const canonicalMatch = normalized.match(
    new RegExp(
      `^${escapeRegExp(canonicalTemplate)
        .replaceAll(escapeRegExp("a".repeat(40)), `(${treeRefPattern})`)
        .replaceAll(escapeRegExp("b".repeat(40)), `(${treeRefPattern})`)}$`,
    ),
  );
  if (
    canonicalMatch !== null &&
    canonicalMatch[1] !== undefined &&
    canonicalMatch[2] !== undefined
  ) {
    const startTreeRef = canonicalMatch[1];
    const missionStartTreeRef = canonicalMatch[2];
    if (
      normalizeCommand(buildDelegatedWorkspaceDeltaCommand(startTreeRef, missionStartTreeRef)) ===
      normalized
    ) {
      return { startTreeRef, missionStartTreeRef };
    }
  }
  return null;
}

export function parseDelegatedWorkspaceTreeSnapshotOutput(
  output: string,
  command: string,
): ParsedDelegatedWorkspaceTreeSnapshot | null {
  if (!isDelegatedWorkspaceTreeSnapshotCommand(command) || output.length > 4_000) {
    return null;
  }
  const match = output.trim().match(new RegExp(`^TRUEFORGE_WORKSPACE_TREE (${treeRefPattern})$`));
  return match === null || match[1] === undefined
    ? null
    : { command: normalizeCommand(command), output, treeRef: match[1] };
}

export function parseDelegatedWorkspaceDeltaOutput(
  output: string,
  command: string,
  expectedStartTreeRef?: string,
  expectedMissionStartTreeRef?: string,
): ParsedDelegatedWorkspaceDelta | null {
  const refs = delegatedWorkspaceDeltaRefsFromCommand(command);
  if (refs === null || output.length > 40_000) {
    return null;
  }
  if (
    expectedStartTreeRef !== undefined && refs.startTreeRef !== expectedStartTreeRef ||
    expectedMissionStartTreeRef !== undefined && refs.missionStartTreeRef !== expectedMissionStartTreeRef
  ) {
    return null;
  }
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  const header = lines[0]?.match(
    new RegExp(
      `^TRUEFORGE_WORKSPACE_DELTA start=(${treeRefPattern}) mission_start=(${treeRefPattern}) end=(${treeRefPattern})$`,
    ),
  );
  if (
    header === undefined ||
    header === null ||
    header[1] !== refs.startTreeRef ||
    header[2] !== refs.missionStartTreeRef ||
    header[3] === undefined
  ) {
    return null;
  }
  const markers = [
    "TRUEFORGE_WORKSPACE_DELTA current_begin",
    "TRUEFORGE_WORKSPACE_DELTA current_end",
    "TRUEFORGE_WORKSPACE_DELTA cumulative_begin",
    "TRUEFORGE_WORKSPACE_DELTA cumulative_end",
  ];
  const markerIndexes = markers.map((marker) => lines.indexOf(marker));
  const [currentBegin, currentEnd, cumulativeBegin, cumulativeEnd] = markerIndexes;
  if (
    currentBegin === undefined ||
    currentEnd === undefined ||
    cumulativeBegin === undefined ||
    cumulativeEnd === undefined ||
    currentBegin < 0 ||
    currentEnd < 0 ||
    cumulativeBegin < 0 ||
    cumulativeEnd < 0 ||
    currentBegin !== 1 ||
    currentEnd <= currentBegin ||
    cumulativeBegin <= currentEnd ||
    cumulativeEnd <= cumulativeBegin ||
    lines.slice(cumulativeEnd + 1).some((line) => line.trim().length > 0)
  ) {
    return null;
  }
  const currentDeltaOutput = lines.slice(currentBegin + 1, currentEnd).join("\n");
  const cumulativeDeltaOutput = lines.slice(cumulativeBegin + 1, cumulativeEnd).join("\n");
  const currentChangedFiles = changedFilesFromNameStatus(currentDeltaOutput);
  const cumulativeChangedFiles = changedFilesFromNameStatus(cumulativeDeltaOutput);
  if (currentChangedFiles === null || cumulativeChangedFiles === null) {
    return null;
  }
  return {
    command: normalizeCommand(command),
    output,
    startTreeRef: refs.startTreeRef,
    missionStartTreeRef: refs.missionStartTreeRef,
    endTreeRef: header[3],
    currentChangedFiles,
    cumulativeChangedFiles,
    currentDeltaOutput,
    cumulativeDeltaOutput,
  };
}

export function parseDelegatedWorkspaceDeltaEvidence(
  evidence: DelegatedWorkspaceDeltaEvidenceLike,
): ParsedDelegatedWorkspaceDelta | null {
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
  if (
    !isRecord(parsed) ||
    parsed.workspace_delta !== true ||
    parsed.coordinator_collected !== true ||
    typeof parsed.command !== "string" ||
    typeof parsed.output !== "string" ||
    typeof parsed.start_tree_ref !== "string" ||
    typeof parsed.mission_start_tree_ref !== "string" ||
    typeof parsed.end_tree_ref !== "string" ||
    typeof parsed.exit_code !== "number" ||
    parsed.exit_code !== 0 ||
    !Array.isArray(parsed.current_changed_files) ||
    !Array.isArray(parsed.cumulative_changed_files) ||
    typeof parsed.current_delta_output !== "string" ||
    typeof parsed.cumulative_delta_output !== "string"
  ) {
    return null;
  }
  const delta = parseDelegatedWorkspaceDeltaOutput(
    parsed.output,
    parsed.command,
    parsed.start_tree_ref,
    parsed.mission_start_tree_ref,
  );
  if (
    delta === null ||
    delta.endTreeRef !== parsed.end_tree_ref ||
    !sameStringArray(parsed.current_changed_files, delta.currentChangedFiles) ||
    !sameStringArray(parsed.cumulative_changed_files, delta.cumulativeChangedFiles) ||
    parsed.current_delta_output !== delta.currentDeltaOutput ||
    parsed.cumulative_delta_output !== delta.cumulativeDeltaOutput
  ) {
    return null;
  }
  return delta;
}

export function isContentDiffCommand(command: string): boolean {
  const normalized = normalizeGitWorkingDirectory(command);
  if (normalized === null) {
    return false;
  }
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
  const normalized = normalizeGitWorkingDirectory(command);
  if (normalized === null) {
    return false;
  }
  if (!normalized.startsWith("git status ")) {
    return false;
  }
  const options = normalized.slice("git status ".length).split(" ").sort().join(" ");
  return completeChangedFilesStatusOptions.includes(options) ||
    options === completeChangedFilesStatusOptionsWithNul;
}

function normalizeGitWorkingDirectory(command: string): string | null {
  const normalized = normalizeCommand(command);
  const canonicalMatch = normalized.match(
    new RegExp(`^git -C ${escapeRegExp(PRIMARY_SANDBOX_REPOSITORY_ROOT)} (.+)$`),
  );
  if (canonicalMatch !== null) {
    return canonicalMatch[1] === undefined ? null : `git ${canonicalMatch[1]}`;
  }
  const match = normalized.match(/^git -C (\.\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+) (.+)$/);
  if (match === null) {
    return normalized.startsWith("git ") ? normalized : null;
  }
  return match[2] === undefined ? null : `git ${match[2]}`;
}

export function completeChangedFilesFromCommand(
  output: string,
  command: string,
): string[] | null {
  const entries = completeChangedFileStatusesFromCommand(output, command);
  return entries === null ? null : entries.map(({ file }) => file);
}

export function completeChangedFileStatusesFromCommand(
  output: string,
  command: string,
): CompleteChangedFileStatus[] | null {
  const normalized = normalizeCommand(command);
  if (!isCompleteChangedFilesCommand(normalized) || output.length > 12_000) {
    return null;
  }
  const usesNul = normalized.split(" ").includes("-z");
  const records = usesNul
    ? output.split("\u0000")
    : output.replace(/\r\n/g, "\n").split("\n");
  const files: CompleteChangedFileStatus[] = [];
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
    files.push({ file, status });
  }
  const seen = new Set<string>();
  return files.filter(({ file }) => {
    if (seen.has(file)) {
      return false;
    }
    seen.add(file);
    return true;
  });
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

export function parseDiffHeader(
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
    let decoded = "";
    let bytes: number[] = [];
    const flushBytes = (): void => {
      if (bytes.length > 0) {
        decoded += new TextDecoder().decode(Uint8Array.from(bytes));
        bytes = [];
      }
    };
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character !== "\\") {
        flushBytes();
        decoded += character ?? "";
        continue;
      }
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal !== undefined) {
        bytes.push(Number.parseInt(octal, 8));
        index += octal.length;
        continue;
      }
      flushBytes();
      const escaped = value[index + 1];
      if (escaped === undefined) {
        decoded += "\\";
        continue;
      }
      decoded += ({
        a: "\u0007",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\u000b",
        "\\": "\\",
        '"': '"',
      } as Record<string, string>)[escaped] ?? escaped;
      index += 1;
    }
    flushBytes();
    return decoded;
  }
}

function changedFilesFromNameStatus(output: string): string[] | null {
  const files: string[] = [];
  for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const match = line.match(/^([A-Z][0-9]*)\t(.+)$/) ?? line.match(/^([A-Z][0-9]*)\s+(.+)$/);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return null;
    }
    const status = match[1];
    const pathValues = match[2].split("\t");
    const rawPath = status.startsWith("R") || status.startsWith("C")
      ? pathValues.at(-1)
      : pathValues[0];
    if (rawPath === undefined || rawPath.length === 0) {
      return null;
    }
    const file = decodeGitPath(rawPath);
    if (file.length === 0) {
      return null;
    }
    files.push(file);
  }
  return uniqueStrings(files);
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validStatusCode(value: string): boolean {
  return /^[ MADRCUTUXB?!]{2}$/.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function sameStringArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => typeof value === "string" && value === right[index]);
}

function assertTreeRef(value: string): void {
  if (!new RegExp(`^${treeRefPattern}$`).test(value)) {
    throw new Error("Tree refs must be hexadecimal object ids.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
