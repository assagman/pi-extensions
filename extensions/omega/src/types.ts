/**
 * Omega types — generic step looper.
 */

/** Persisted state — survives session resume via appendEntry */
export interface OmegaState {
  /** Whether an omega workflow is currently active */
  active: boolean;
  /** User-defined steps (free text, executed in order) */
  steps: string[];
  /** Total number of repetitions of the full step sequence */
  totalRepetitions: number;
  /** Current repetition (1-based) */
  currentRepetition: number;
  /** Current step index (0-based) */
  currentStep: number;
  /** Timestamp when the workflow started */
  startedAt: number;
}

/** Custom entry type for appendEntry persistence */
export const OMEGA_ENTRY_TYPE = "omega-state";

/** Create a fresh initial state */
export function createInitialState(steps: string[], totalRepetitions: number): OmegaState {
  return {
    active: true,
    steps,
    totalRepetitions,
    currentRepetition: 1,
    currentStep: 0,
    startedAt: Date.now(),
  };
}
