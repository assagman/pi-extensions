/**
 * Phase-specific instructions injected into the main agent's system prompt.
 * Each phase tells the agent what to do, what artifacts to produce, and how to signal completion.
 */
import type { Phase } from "./progress.js";

export const DEFAULT_ARTIFACT_DIR = ".delta";

export function getPhaseGoal(phase: Phase): string {
  const goals: Record<Phase, string> = {
    idle: "",
    done: "",
    failed: "",

    requirements: "Turn the user's goal into crisp, testable acceptance criteria.",
    review_requirements: "Strictly review requirements for clarity and testability.",
    design: "Define the design/architecture to satisfy the acceptance criteria.",
    review_design: "Critique the design and force clarity before planning.",
    plan: "Create an executable step-by-step plan with verification mapped to AC.",
    review_plan: "Review the plan for completeness, ordering, and verifiability.",
    implement: "Implement the plan, making minimal correct changes.",
    test: "Verify implementation against AC with commands + outputs.",
    review_impl: "Final quality gate: evaluate objectively against AC + evidence.",
    deliver: "Summarize deliverables, how to verify, and remaining limitations.",
  };
  return goals[phase] || "";
}

export function getDefaultArtifactPath(phase: Phase): string | undefined {
  const p = (name: string) => `${DEFAULT_ARTIFACT_DIR}/${name}.md`;
  const map: Partial<Record<Phase, string>> = {
    requirements: p("requirements"),
    review_requirements: p("review_requirements"),
    design: p("design"),
    review_design: p("review_design"),
    plan: p("plan"),
    review_plan: p("review_plan"),
    implement: p("implement"),
    test: p("test"),
    review_impl: p("review_impl"),
    deliver: p("deliver"),
  };
  return map[phase];
}

function phaseArtifactInstruction(phase: Phase): string {
  const file = getDefaultArtifactPath(phase);
  if (!file) return "";

  return `\n### Artifact (required)\n- Write your phase output to: \`${file}\` (overwrite; keep it clean + structured).\n- In your \`delta_advance\` call, set: \`artifacts: { phaseFile: "${file}" }\`\n`;
}

const ADVANCE_INSTRUCTION = `
When you have completed this phase, call the \`delta_advance\` tool with:
- \`summary\`: 3–8 bullet lines (short) describing what you did + decisions + what to read next
- \`artifacts\`: must include \`phaseFile\` pointing to the artifact file you wrote for this phase
- \`verdict\`: for review_* phases: "approved" | "needs_changes" | "blocked" | "abandoned"
- \`issueClass\`: for review_impl when verdict=needs_changes: one of
  "fix_only" | "test_gap" | "plan_gap" | "design_gap" | "req_gap"
- \`reasons\`: for needs_changes/blocked/abandoned: list specific actionable reasons
- \`checks\`: checklist booleans for the gate (key→true/false)
- \`evidence\`: commands run + short output excerpts (when applicable)

Do NOT proceed to the next phase without calling \`delta_advance\` first.`;

const PHASE_INSTRUCTIONS: Record<Phase, string> = {
  idle: "",
  done: "",
  failed: "",

  requirements: `## 🧾 DELTA PHASE: REQUIREMENTS

You are in the **requirements** phase.
Your job is to turn the user's goal into crisp, testable success criteria.

### What to do:
1. Restate the goal in your own words (1-3 lines)
2. List assumptions and non-goals
3. Write explicit acceptance criteria (AC) that are objectively verifiable
4. Identify unknowns; if critical, use \`questionnaire\` to ask the user

### Output expectations:
- Write the full requirements artifact (structured markdown)
- Keep the \`delta_advance.summary\` short (3–4 sentences or 3–8 bullets)

${phaseArtifactInstruction("requirements")}
${ADVANCE_INSTRUCTION}`,

  review_requirements: `## 🔎 DELTA PHASE: REVIEW (Requirements)

You are in the **requirements review** gate.
Be strict: unclear requirements cause the most rework.

### What to do:
1. READ the requirements artifact (check Artifacts list above).
2. Verify it against the checklist below.
3. Update/append your review notes to the review artifact.

### Gate checklist (checks):
- each_ac_is_testable
- edge_cases_covered
- scope_is_clear
- unknowns_resolved_or_tracked

### Verdict:
- approved: requirements are unambiguous and testable
- needs_changes: refine AC / assumptions / scope
- blocked: cannot proceed without user input or missing info
- abandoned: task is impossible / invalid / not worth continuing

### Output expectations:
- Update/append review notes to the artifact file
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("review_requirements")}
${ADVANCE_INSTRUCTION}`,

  design: `## 🧩 DELTA PHASE: DESIGN

You are in the **design** phase.
Define how you'll satisfy the acceptance criteria: architecture, APIs, data flow, key decisions.

### What to do:
1. READ the requirements artifact (see Artifacts above) to understand what to build.
2. Propose approach + alternatives briefly.
3. Identify files/modules to touch and responsibilities.
4. Define APIs/types/interfaces.
5. Identify risks, failure modes, rollback/migration considerations.

### Output expectations:
- Write the full design artifact (structured markdown)
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("design")}
${ADVANCE_INSTRUCTION}`,

  review_design: `## 🧠 DELTA PHASE: REVIEW (Design)

You are in the **design review** gate.
Critique the design as if you're trying to break it.

### What to do:
1. READ the design artifact (see Artifacts above).
2. Critique it against the requirements and checklist.

### Gate checklist (checks):
- design_covers_all_ac
- risks_identified
- interfaces_are_coherent
- conventions_followed

### Verdict:
- approved / needs_changes / blocked / abandoned

### Output expectations:
- Update/append review notes to the artifact file
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("review_design")}
${ADVANCE_INSTRUCTION}`,

  plan: `## 📋 DELTA PHASE: PLAN

You are in the **planning** phase.
Convert design into an executable step-by-step plan with verification steps.

### What to do:
1. READ the design and requirements artifacts.
2. Break work into atomic steps (numbered).
3. For each step, include file paths and what changes.
4. Map acceptance criteria to verification steps (tests/commands/manual checks).
5. If prior gate feedback exists, address **all** issues explicitly.

### Output expectations:
- Write the full plan artifact (structured markdown)
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("plan")}
${ADVANCE_INSTRUCTION}`,

  review_plan: `## 🧾 DELTA PHASE: REVIEW (Plan)

You are in the **plan review** gate.

### What to do:
1. READ the plan artifact.
2. Verify it is atomic, ordered, and verifiable.

### Gate checklist (checks):
- steps_are_atomic
- dependencies_ordered
- ac_to_verification_mapping_present
- risks_and_edge_cases_addressed
- commands_identified

### Verdict:
- approved / needs_changes / blocked / abandoned

### Output expectations:
- Update/append review notes to the artifact file
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("review_plan")}
${ADVANCE_INSTRUCTION}`,

  implement: `## 🔨 DELTA PHASE: IMPLEMENT

Execute the plan.

### Rules:
- READ the plan artifact first.
- Implement one step at a time.
- No TODOs / placeholders.
- Keep changes minimal and consistent with conventions.
- If plan must change, adjust rationally and note why in summary.

### Output expectations:
- Update the implementation artifact with: files changed + key diffs (short excerpts) + rationale
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("implement")}
${ADVANCE_INSTRUCTION}`,

  test: `## 🧪 DELTA PHASE: TEST

Verify the implementation against acceptance criteria.

### What to do:
1. Run existing test suite (if present)
2. Add tests where needed to cover AC
3. Run typecheck/lint (if present)
4. Provide evidence: commands + key outputs

### Output expectations:
- Write/overwrite the test artifact with commands + key outputs
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("test")}
${ADVANCE_INSTRUCTION}`,

  review_impl: `## ✅ DELTA PHASE: REVIEW (Implementation)

This is the **final quality gate**.
Evaluate objectively against the acceptance criteria and evidence.

### Gate checklist (checks):
- ac_satisfied
- tests_pass
- typecheck_pass
- lint_pass
- security_ok
- edge_cases_ok

### Verdict:
- approved: ready to deliver
- needs_changes: must specify issueClass:
  - fix_only: code changes without plan/design change
  - test_gap: missing/weak tests or evidence
  - plan_gap: plan inadequate/incorrect
  - design_gap: design needs revision
  - req_gap: requirements/AC need revision
- blocked / abandoned

### Output expectations:
- Write/overwrite the review artifact with a strict evaluation (AC-by-AC) + any gaps
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("review_impl")}
${ADVANCE_INSTRUCTION}`,

  deliver: `## 📦 DELTA PHASE: DELIVER

Finalize the handoff.

### What to do:
1. Summarize what changed and why
2. Provide "how to run/verify" steps (commands)
3. Note any follow-ups or limitations

### Output expectations:
- Write the deliverable handoff notes
- Keep \`delta_advance.summary\` short

${phaseArtifactInstruction("deliver")}
${ADVANCE_INSTRUCTION}`,
};

export function getPhaseInstructions(phase: Phase): string {
  return PHASE_INSTRUCTIONS[phase] || "";
}

export function getPhaseEmoji(phase: Phase): string {
  const emojis: Record<Phase, string> = {
    idle: "⏸",
    requirements: "🧾",
    review_requirements: "🔎",
    design: "🧩",
    review_design: "🧠",
    plan: "📋",
    review_plan: "🧾",
    implement: "🔨",
    test: "🧪",
    review_impl: "✅",
    deliver: "📦",
    done: "✓",
    failed: "✗",
  };
  return emojis[phase] || "?";
}

export function getPhaseLabel(phase: Phase): string {
  const labels: Record<Phase, string> = {
    idle: "idle",
    requirements: "requirements",
    review_requirements: "review:req",
    design: "design",
    review_design: "review:design",
    plan: "plan",
    review_plan: "review:plan",
    implement: "implement",
    test: "test",
    review_impl: "review:impl",
    deliver: "deliver",
    done: "done",
    failed: "failed",
  };
  return labels[phase] || phase;
}
