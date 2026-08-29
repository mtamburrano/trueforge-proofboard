import { buildDelegatedWorkspaceDeltaCommand } from "../dist/index.js";

export const WORKSPACE_BASELINE_TREE = "a".repeat(40);
export const WORKSPACE_END_TREE = "b".repeat(40);

export function workspaceDeltaEvidenceDetails({
  startTreeRef = WORKSPACE_BASELINE_TREE,
  missionStartTreeRef = WORKSPACE_BASELINE_TREE,
  endTreeRef = WORKSPACE_END_TREE,
  currentFiles = ["src/index.ts", "test/index.test.js"],
  cumulativeFiles = currentFiles,
} = {}) {
  const statusOutput = (files) => files.map((file) => `M\t${file}`).join("\n");
  const output = [
    `TRUEFORGE_WORKSPACE_DELTA start=${startTreeRef} mission_start=${missionStartTreeRef} end=${endTreeRef}`,
    "TRUEFORGE_WORKSPACE_DELTA current_begin",
    statusOutput(currentFiles),
    "TRUEFORGE_WORKSPACE_DELTA current_end",
    "TRUEFORGE_WORKSPACE_DELTA cumulative_begin",
    statusOutput(cumulativeFiles),
    "TRUEFORGE_WORKSPACE_DELTA cumulative_end",
    "",
  ].join("\n");
  return JSON.stringify({
    coordinator_collected: true,
    workspace_delta: true,
    command: buildDelegatedWorkspaceDeltaCommand(startTreeRef, missionStartTreeRef),
    output,
    start_tree_ref: startTreeRef,
    mission_start_tree_ref: missionStartTreeRef,
    end_tree_ref: endTreeRef,
    current_changed_files: currentFiles,
    cumulative_changed_files: cumulativeFiles,
    current_delta_output: statusOutput(currentFiles),
    cumulative_delta_output: statusOutput(cumulativeFiles),
    exit_code: 0,
  });
}

export async function persistWorkspaceStart(missions, missionId, workItemId, {
  startTreeRef = WORKSPACE_BASELINE_TREE,
  missionStartTreeRef = WORKSPACE_BASELINE_TREE,
  sessionId = "session-handoff",
  turnId = "turn-workspace-start",
  toolCallId = "call-workspace-start",
  threadId = "thread-handoff",
  owner = "bounded-implementer",
} = {}) {
  await missions.attachTrueforgeWorkspaceBaseline(missionId, missionStartTreeRef);
  const workItem = await missions.startWorkItemDelegation(missionId, workItemId, {
    owner,
    threadId,
    turnId,
    startTreeRef,
    missionStartTreeRef,
  });
  const evidence = await missions.addEvidence(missionId, {
    workItemId,
    kind: "tool_result",
    result: "passed",
    source: "trueforge",
    summary: "The coordinator captured the per-work-item workspace start tree.",
    details: JSON.stringify({
      coordinator_collected: true,
      workspace_tree_snapshot: true,
      tree_ref: startTreeRef,
      mission_start_tree_ref: missionStartTreeRef,
    }),
    executionOrigin: { kind: "trueforge", sessionId, turnId, toolCallId },
  });
  return { workItem, evidence };
}
