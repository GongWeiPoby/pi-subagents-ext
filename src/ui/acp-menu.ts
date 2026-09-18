import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { acpBinaryCommandPath, installAcpBinary } from "../acp/installer.js";
import {
  type AcpLaunchCandidate,
  type ApprovedAcpAgent,
  catalogAcpAgents,
  deriveAcpHandle,
  launchCandidateFor,
  loadAcpApprovals,
  removeAcpApproval,
  upsertAcpApproval,
} from "../acp/registry.js";
import { selectItem } from "./select-item.js";

function commandText(candidate: AcpLaunchCandidate): string {
  const env = Object.entries(candidate.staticEnv)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(" ");
  return `${env ? `${env} ` : ""}${candidate.command} ${candidate.args.map(arg => JSON.stringify(arg)).join(" ")}`.trim();
}

async function approveCandidate(ctx: ExtensionCommandContext, candidate: AcpLaunchCandidate): Promise<void> {
  const handle = deriveAcpHandle(candidate.registryId);
  const binaryCommand = candidate.requiresInstalledBinary ? acpBinaryCommandPath(candidate) : undefined;
  const approved = await ctx.ui.confirm(
    `Approve ${candidate.displayName} as @${handle}?`,
    `Version: ${candidate.registryVersion}\nSource: ${candidate.sourceUrl}\n` +
      (candidate.requiresInstalledBinary
        ? `Archive: ${candidate.archive}\nSHA-256: ${candidate.sha256 ?? "not supplied"}\nCommand after install: ${binaryCommand}`
        : `Command: ${commandText(candidate)}`) +
      (candidate.distribution === "uvx"
        ? "\n\nuvx uses the user-level uv cache, not an isolated prefix."
        : "") +
      "\n\nThis exact Codeg pin may download code to the machine. ACP permission requests use YOLO mode (allow all).",
  );
  if (!approved) return;
  let command = candidate.command;
  if (candidate.requiresInstalledBinary) {
    ctx.ui.notify(`Installing ${candidate.displayName} ${candidate.registryVersion}…`, "info");
    try {
      command = await installAcpBinary(candidate, { signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      ctx.ui.notify(`Could not install ${candidate.displayName}: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
  }
  const approval: ApprovedAcpAgent = {
    registryId: candidate.registryId,
    displayName: candidate.displayName,
    handle,
    registryVersion: candidate.registryVersion,
    sourceUrl: candidate.sourceUrl,
    command,
    args: candidate.args,
    staticEnv: candidate.staticEnv,
    approvedAt: new Date().toISOString(),
    enabled: true,
  };
  const result = upsertAcpApproval(approval);
  ctx.ui.notify(
    result.ok
      ? `Approved @${handle}. It is available in this session.`
      : result.error,
    result.ok ? "info" : "error",
  );
}

function catalogCandidates(): AcpLaunchCandidate[] {
  return catalogAcpAgents()
    .map(agent => launchCandidateFor(agent))
    .filter((candidate): candidate is AcpLaunchCandidate => candidate !== undefined);
}

async function showCatalog(ctx: ExtensionCommandContext): Promise<void> {
  let filter = "";
  for (;;) {
    const candidates = catalogCandidates();
    const visible = filter
      ? candidates.filter(item =>
        `${item.displayName} ${item.registryId} ${item.distribution}`.toLowerCase().includes(filter))
      : candidates;
    const title = filter
      ? `ACP agents matching "${filter}" (${visible.length})`
      : `ACP agents (${visible.length})`;
    const extras = ["Filter list…"] as const;
    const picked = await selectItem(
      ctx.ui,
      title,
      [...extras, ...visible],
      item => typeof item === "string"
        ? item
        : `${item.displayName} ${item.registryVersion} · ${item.distribution}${item.requiresInstalledBinary ? " · installs on approval" : ""}`,
    );
    if (!picked) return;
    if (picked === "Filter list…") {
      const query = await ctx.ui.input("Filter ACP agents", filter);
      if (query != null) filter = query.trim().toLowerCase();
      continue;
    }
    await approveCandidate(ctx, picked);
    return;
  }
}

async function showApproved(ctx: ExtensionCommandContext): Promise<void> {
  const approvals = loadAcpApprovals().agents;
  if (approvals.length === 0) {
    ctx.ui.notify("No ACP agents approved on this machine.", "info");
    return;
  }
  const selected = await selectItem(ctx.ui, "Approved ACP agents", approvals, approval =>
    `@${approval.handle} · ${approval.displayName} ${approval.registryVersion} · ${approval.enabled ? "enabled" : "disabled"}`,
  );
  if (!selected) return;
  const action = await ctx.ui.select(selected.displayName, [
    selected.enabled ? "Disable" : "Enable",
    "Remove approval",
    "Back",
  ]);
  if (!action || action === "Back") return;
  if (action === "Remove approval") {
    const confirmed = await ctx.ui.confirm("Remove ACP approval?", `Remove @${selected.handle} and reject future starts?`);
    if (!confirmed) return;
    const removed = removeAcpApproval(selected.registryId);
    ctx.ui.notify(
      removed
        ? `Removed @${selected.handle}. Current turns may finish; new attempts are rejected.`
        : `Could not remove @${selected.handle}.`,
      removed ? "info" : "warning",
    );
    return;
  }
  const result = upsertAcpApproval({ ...selected, enabled: !selected.enabled });
  ctx.ui.notify(
    result.ok
      ? `${selected.displayName} ${selected.enabled ? "disabled" : "enabled"} in this session.`
      : result.error,
    result.ok ? "info" : "error",
  );
}

export async function showAcpAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const choice = await ctx.ui.select("External ACP agents", [
    "Approve agent",
    `Approved agents (${loadAcpApprovals().agents.length})`,
  ]);
  if (choice === "Approve agent") await showCatalog(ctx);
  else if (choice?.startsWith("Approved agents")) await showApproved(ctx);
}
