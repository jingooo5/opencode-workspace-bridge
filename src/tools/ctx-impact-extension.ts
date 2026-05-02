import { existsSync } from "node:fs";
import type { WorkspaceStore } from "../state/workspace-store.js";
import { openSQLiteIndexStore } from "../indexer/sqlite-store.js";
import { appendImpactLedger, readImpactLedgerTail } from "../state/edit-state.js";

export interface RequiredGate {
  kind: "test" | "build" | "typecheck" | "review";
  reason?: string;
  scope?: string;
  contractId?: string;
}

export interface PendingGate extends RequiredGate {
  ref?: string;
}

export interface ImpactExtensionInput {
  target: string;
  sessionID?: string;
  evidenceCounts: { direct: number; crossRoot: number; unknown: number };
}

export interface ImpactExtensionResult {
  contractIds: string[];
  requiredGates: RequiredGate[];
  pendingGates: PendingGate[];
}

export async function buildImpactExtension(
  store: WorkspaceStore,
  input: ImpactExtensionInput,
): Promise<ImpactExtensionResult> {
  if (!existsSync(store.sqlitePath)) {
    return { contractIds: [], requiredGates: [], pendingGates: [] };
  }
  const opened = await openSQLiteIndexStore(store.sqlitePath, { readonly: true, skipMigrations: true });
  if (!opened.ok) return { contractIds: [], requiredGates: [], pendingGates: [] };
  const sqlite = opened.value;
  try {
    const contractsResult = sqlite.readContracts();
    const contracts = contractsResult.ok ? contractsResult.value : [];
    const matched = contracts.filter((contract) => contractMatchesTarget(contract, input.target));
    const requiredGates: RequiredGate[] = [];
    for (const contract of matched) {
      switch (contract.kind) {
        case "HTTP_ROUTE":
          requiredGates.push({ kind: "test", reason: "consumers untested", contractId: contract.id });
          break;
        case "DTO":
          requiredGates.push({ kind: "test", reason: "consumers untested", contractId: contract.id });
          break;
        case "PACKAGE":
          requiredGates.push({ kind: "build", contractId: contract.id });
          requiredGates.push({ kind: "typecheck", contractId: contract.id });
          break;
        case "CONTRACT_FILE":
          requiredGates.push({ kind: "review", reason: "openapi/proto unparsed in v0.2", contractId: contract.id });
          break;
      }
      if (contract.relPath && /migrations\//.test(contract.relPath)) {
        requiredGates.push({ kind: "test", scope: "integration", contractId: contract.id });
      }
    }

    const contractIds = matched.map((contract) => contract.id);
    const pendingGates = await computePendingGates(store, contractIds, requiredGates);

    await appendImpactLedger(store, {
      at: new Date().toISOString(),
      sessionID: input.sessionID,
      target: input.target,
      contractIds,
      requiredGates,
      evidenceCounts: input.evidenceCounts,
    });

    return { contractIds, requiredGates, pendingGates };
  } finally {
    sqlite.close();
  }
}

async function computePendingGates(
  store: WorkspaceStore,
  contractIds: string[],
  required: RequiredGate[],
): Promise<PendingGate[]> {
  if (required.length === 0) return [];
  const ledger = await readImpactLedgerTail(store, 200);
  const recentlyCovered = new Set<string>();
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const entry of ledger) {
    if (Date.parse(entry.at) < cutoff) continue;
    for (const gate of entry.requiredGates ?? []) {
      if (gate.kind && entry.contractIds) {
        for (const id of entry.contractIds) recentlyCovered.add(`${id}:${gate.kind}`);
      }
    }
  }
  const pending: PendingGate[] = [];
  for (const gate of required) {
    if (!gate.contractId) {
      pending.push(gate);
      continue;
    }
    const key = `${gate.contractId}:${gate.kind}`;
    if (!recentlyCovered.has(key)) pending.push(gate);
  }
  void contractIds;
  return pending;
}

function contractMatchesTarget(contract: { name: string; relPath?: string; id: string }, target: string): boolean {
  const lower = target.toLowerCase();
  return (
    contract.id === target
    || contract.name.toLowerCase() === lower
    || contract.name.toLowerCase().includes(lower)
    || (contract.relPath ? contract.relPath.toLowerCase().includes(lower) : false)
  );
}
