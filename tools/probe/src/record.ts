import type {
  RuntimeEvent,
  PermissionDecision,
  PermissionRequest,
  RuntimeConfig,
  TurnHandle,
  TurnResult,
} from "@mia/agent-adapter";
import type { FixtureState } from "@mia/controlled-mcp";

/** The probe's command-line options, as commander parsed them. */
export interface ProbeOptions {
  model: string;
  out: string;
  examples: string;
  only?: string;
}

export interface StepRecord {
  name: string;
  session_id: string;
  first_turn: boolean;
  prompt: string;
  events: RuntimeEvent[];
  permission_requests: {
    /** The runtime's raw permission payload, snake_case as it arrived. */
    request: unknown;
    decision: PermissionDecision;
    abandoned: boolean;
  }[];
  turn: TurnResult | null;
  ledger_after: FixtureState | null;
  hook_evidence: Record<string, unknown>[] | null;
  notes: string[];
  checks: Record<string, boolean | string>;
}

export type Decider = (
  request: PermissionRequest,
  step: StepRecord,
) => Promise<PermissionDecision> | PermissionDecision;

export interface StepSpec {
  name: string;
  config: RuntimeConfig;
  sessionId: string;
  firstTurn: boolean;
  prompt: string;
  turnIndex: number;
  decide: Decider;
  during?: (handle: TurnHandle, step: StepRecord) => Promise<void>;
}
