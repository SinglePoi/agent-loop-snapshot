# Workflow IR v0.1

Workflow IR is a portable, declarative plan derived from a recorded Trace. It is not a historical event log and must never carry source-run credentials, approvals, absolute temporary paths, or hidden model reasoning.

The canonical schema is `packages/schema/schemas/workflow.schema.json`. Consumers parse either JSON or YAML into a JavaScript object and call `validateWorkflow()`; format parsing is intentionally separate so both representations share the same structural and semantic checks.

## Document shape

Every workflow has `schema_version: "0.1.0"`, `workflow_type: "agent-workflow"`, a stable `wf_*` identifier, named inputs, nodes, and named outputs. Input and output definitions use embedded JSON Schema fragments.

Each node declares:

- `depends_on`: zero or more `{ node_id, on }` edges; `on` is `success`, `failure`, or `always`. Multiple edges are a join, while multiple successor nodes naturally run in parallel.
- Optional `condition`: a branch guard over a named input or another node's output.
- Optional `retry`: a bounded retry policy.
- `on_failure`: `stop` for terminal failure or `continue` to make a failure edge available to later nodes.
- `permissions`: the required side-effect level plus optional capabilities, target scopes, and fresh-approval requirement.
- `success_conditions`: at least one output-schema check, condition, or declared verifier.

The four node kinds are `agent_task`, `tool_call`, `verification`, and `human_approval`. A verification node and verifier-based success condition name a top-level verifier. Verifiers support JSON Schema, a runtime-provided assertion, or a human prompt.

## Example

```yaml
schema_version: "0.1.0"
workflow_type: agent-workflow
workflow_id: wf_release_note
name: Draft and approve release note
inputs:
  change_summary:
    schema: { type: string }
    required: true
verifiers:
  - verifier_id: verifier_nonempty_note
    kind: json_schema
    schema: { type: string, minLength: 1 }
nodes:
  - node_id: node_draft
    kind: agent_task
    goal: Draft a concise release note.
    depends_on: []
    retry: { max_attempts: 2 }
    on_failure: stop
    permissions: { side_effect: read_only }
    success_conditions:
      - kind: verifier
        verifier_id: verifier_nonempty_note
  - node_id: node_approval
    kind: human_approval
    approval_id: release_note_publish
    prompt: Approve publishing this release note?
    depends_on:
      - { node_id: node_draft, on: success }
    on_failure: stop
    permissions: { side_effect: external_write, requires_approval: true }
    success_conditions:
      - kind: condition
        condition:
          from: { kind: node_output, name: node_draft }
          operator: exists
outputs:
  note:
    from: { node_id: node_draft }
    schema: { type: string }
```

`validateWorkflow()` rejects malformed documents and then checks duplicate node/verifier IDs, missing dependencies, missing input or node-output references, missing verifier references, unknown output nodes, self-dependencies, and dependency cycles.

## Trace compilation

`compileTraceToWorkflow(trace)` in `@agent-loop-snapshot/replay` accepts a valid `TraceSnapshot` and returns a conservative, editable candidate workflow alongside a `sourceMap` and report. Model and tool calls with the same correlation key are grouped as one logical node; retry failures remain in `report.removedFailureSteps` with source event IDs and error codes. Multiple source parents become workflow dependencies, preserving parallel branches and joins.

The compiler infers input **schemas** from `run.started`, but does not copy input values or defaults. It likewise omits tool arguments, model prompts/results, decision summaries, historical approvals, and other payload text. Call targets are listed only as environment-constant candidates for later human review. Semantic execution and runtime adapter resolution begin in later milestones.

## Semantic replay

`SemanticReplayRunner` executes a validated workflow with new inputs through a caller-supplied Semantic Agent adapter. The adapter receives the node goal, declared constraints, new input values, prior node outputs, and the current attempt; it may use a different internal tool sequence than the source Trace.

Every Agent invocation is wrapped by `ReplayPolicyEngine`. The effective side-effect level is the more restrictive of the node permission and adapter descriptor, so an adapter that can write cannot be invoked through a read-only node. Custom assertion and human verifiers also require an explicit verifier adapter and a separate policy decision. `external_write` and stronger operations are denied by default unless a fresh, matching approval is supplied.

Each completed Agent output is checked against all declared output-schema, condition, and verifier success conditions. Failure consumes a bounded node retry; exhausted retries fail or continue according to `on_failure`. The final report intentionally distinguishes `process: matched|diverged` (declared node order with no retry or skip) from `result: equivalent|not_equivalent` (all declared success conditions and output schemas passed).

## Runtime compatibility

An adapter may declare fine-grained `semantic.node.agent_task`, `semantic.node.tool_call`, `semantic.node.verification`, and `semantic.node.human_approval` capabilities in addition to `agent.execute`. `inspectSemanticAgentCompatibility()` returns the required and unsupported capabilities before execution. If an adapter declares any of these fine-grained capabilities, missing requirements cause Semantic Replay to fail before the first Agent call; adapters that declare none retain a legacy “all node kinds” compatibility mode.

`ScriptedSemanticRuntimeAdapter` is an independent deterministic second runtime supplied for compatibility tests. The same Workflow IR runs against it and an arbitrary reference adapter, while a restricted instance demonstrates the preflight degradation report. Real runtimes need only implement the structural `SemanticAgentAdapter` interface and accurately declare their node capabilities.
