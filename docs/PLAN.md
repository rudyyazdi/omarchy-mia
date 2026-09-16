# Mia: voice assistant for Omarchy

## Outcome and scope

An open-source client/server voice assistant controlling a user-configured Omarchy host through configured agent runtimes. Desktop and phone clients share one conversation, with optional interactive visuals, explicit device handoff, parallel tasks where tools allow it, and past-conversation retrieval. Remote operation requires the configured host to be awake and online.

Implement the eight testable deliverables below. Client/server separation is foundational from deliverable 1. Each milestone needs a user acceptance demo, relevant automated checks, and an acceptance checkpoint before expanding scope. This is an implementation plan; the planning task does not authorize implementation. Run agents through user-installed Codex, Claude Code, or OpenCode CLIs, reusing their authentication; document prerequisites and detect missing setup rather than assuming a particular developer's environment. Users need only configure the agent runtimes they intend to use.

The project must be usable without the original author's accounts, paths, devices, or private services. Keep credentials, personal configuration, recordings, and logs outside version control; provide generic setup examples. Live service/device acceptance tests use the tester's own configured integrations.

## Out of scope and future expansion

- **Restricted agent tools:** Later, reuse CLI authentication while exposing only Mia-configured tools, without inheriting personal MCP servers, plugins, hooks, or permissions. Keep authentication reuse separate from tool configuration and approval policies in agent adapters so this can be added without rewriting orchestration. Future enforcement must cover the active agent and worker agents using either default or big-gun models, and bypass paths such as unrestricted shell access. Implementing or proving this isolation is not part of the current deliverables; existing approval and interruption requirements still apply.
- **Job-service implementation:** Build scheduling/monitoring in a separate repo. This plan includes its contract and integration (deliverable 8), not its engine or external-service shutdown policy. The contract covers job and job-run identities, schedules/triggers, deterministic or agent work, authorization, notifications, history, cancellation, and recovery.
- **Other deferred work:** Keybinding setup; model-weight fine-tuning (prompt tuning remains in scope); licensing, packaging, and publication; a second production UI adapter (the minimal adapter-boundary check remains in scope).

## Terminology

| Term | Meaning |
| --- | --- |
| Mia | The assistant as a whole. |
| Host | The user's configured Omarchy computer, where agents and computer actions run. |
| Server | Mia's persistent host process managing conversation, tasks, and clients. |
| Client | Desktop or phone app providing voice and optional visuals. |
| Conversation | A stored dialogue and its context, resumable across devices and disconnects. Only one conversation is active at a time. |
| Active client | Client currently handling conversational input, voice playback, and optional visuals together on one device. |
| Device handoff | Explicit transfer of the conversation, voice, and visual state together to another client. |
| Voice model | GPT-Live, responsible for spoken interaction and delegation. |
| Active agent | Agent owning substantive answers and task coordination, running through a configured agent runtime. |
| Worker agent | Agent assigned a delegated task by the active agent. |
| Agent runtime | Installed software running an agent, such as Codex, Claude Code, or OpenCode. |
| Model provider | Company or service supplying a model to an agent runtime. |
| Default / big-gun model | Configured normal / explicitly requested escalation model. |
| Task | Bounded work that may outlive a client connection. |
| Task transfer | Reassigning a task to another agent while preserving context and one execution owner. |
| Job | Scheduled or ongoing work managed by the job service. |
| Job run | One execution of a job, such as today's run of a daily vacuum schedule. |
| Job service | Separate external service managing scheduled or ongoing jobs. |
| Tool | Callable operation available to an agent, subject to approval and concurrency rules. |
| External service | System exposing capabilities through tools, such as a browser integration or job service. |
| Agent adapter | Mia's connection to an agent runtime, including its events and approval interface. |
| Tool adapter | Mia's connection to a tool or external service where needed. |
| UI adapter | Translates display messages and UI events for the chosen UI format, initially A2UI. |
| Approval policy | Rules determining whether a tool call requires explicit user approval. |
| Approval request | Pending request for the user to authorize a specific tool call. |
| Approval decision | The user's approve or reject response to an approval request. |
| View | Visual content shown by the client, such as a chart or test report. |
| UI event | An interaction with a view that may become input to Mia. |
| Hide view | Dismiss visuals while leaving voice and tasks running. |
| Close | Close the client while the server and tasks keep running; task completion notifies the user to reopen the client. |
| Quit | Fully stop Mia's server and clients cleanly, excluding external services. |

Avoid unqualified “session”: distinguish conversation, voice connection, and agent session.

## Agreed requirements

### Conversation and execution

- GPT-Live handles conversation, clarification, and delivery; client delegation sends substantive questions and tasks to the active agent. All task tools belong to that agent or its worker agents. Microphone and playback controls belong to the client; the server coordinates interruption of agent work.
- One conversation controls the host. Opening another client offers device handoff rather than starting a second conversation or agent. Voice and optional visuals stay together on the active device, either desktop or phone; split-device voice/display use is not required. Device handoff transfers both together.
- Configuration selects an agent runtime and model for each of the default and big-gun roles. Preserve configured identifiers; examples include Opus 5, Codex 5.6 Sol, DeepSeek 4.1, Codex Astra, and Claude Fable. Config changes apply to a new conversation.
- Explicit escalation replaces the active agent until switched back or a fresh conversation starts. Never escalate automatically. Independent running tasks retain their assigned model; task transfers preserve context and have one execution owner.
- Concurrency follows tool and external-service constraints: searches can overlap; computer-use actions cannot. Independent agents/tasks must not contend over shared browser, desktop, or file state.
- Hold to speak, release to submit; optional hands-free conversation mode. Interrupting stops playback and blocks new consequential actions while listening. Handle in-flight actions according to actual cancellation support; never imply completed actions were undone.
- Reuse existing permissions, with configurable approval policy per tool where the agent runtime or tool integration supports enforcement, including requiring explicit approval on every call (for example, all tools of a configured password-manager MCP). Task instructions do not override an approval policy requiring confirmation on every call. Configure payment/booking approval rules through the relevant approval policy rather than a hard-coded fee rule. Surface unsupported enforcement before enabling that policy; never silently downgrade it.
- The active agent proposes tool calls; Mia's server and the applicable agent adapter or tool adapter enforce approval before execution. The active client presents the tool, intended action, and relevant non-secret arguments with explicit approve/reject controls. Approval is bound to the exact pending call; changed arguments require renewed approval. Neither model may grant approval on the user's behalf. Pending approval requests survive device handoff/reconnect; no response or a disconnected client is not consent. GPT-Live may explain the request, but does not own enforcement.
- Access includes all host browsers/tabs and signed-in sessions where supported; phone use controls the host, not the phone's own apps. Authorized monitoring notifications need no repeated approval unless their approval policy requires it. Verify uncertain outcomes before retrying consequential actions. Configurable approvals are in scope; comprehensive isolation from inherited CLI capabilities remains deferred.

### Lifecycle

- Close shuts the client's voice/UI while the server and tasks continue. Task completion pings the user with a notification to reopen the client and resume; failure or required input also triggers notification. Do not automatically reopen the microphone or start speaking. Notification delivery mechanism is a solution-design decision.
- A task notification offers resumption of its originating conversation. Ordinary opening offers Continue or New conversation when context exists. Only one conversation is active; resuming another requires an explicit switch. Starting fresh does not cancel running tasks.
- Fresh conversations do not automatically inherit past conversation context. The active agent can search/retrieve past conversations through tools with source references, whether using the default or big-gun model.
- Quit fully stops Mia's server and clients cleanly and handles Mia-owned active tasks, preserving logs and reporting anything that cannot be cancelled.
- Remote access assumes an awake, online host. Unavailability is visible; consequential commands are not silently queued for later execution.

### Visuals and adapters

- Start with [A2UI](https://a2ui.org/) behind a replaceable UI adapter. Keep conversation/task behavior, content meaning, and UI-event handling independent of that choice. Replacement must not require rewriting core orchestration. Demonstrate the boundary with a minimal alternative/test UI adapter.
- Require compact, rich, versioned display messages, incremental updates, and references to large data. Cover text, metrics, charts, tables, test results, image choices, and simple layouts. Ordinary output must not require generated HTML.
- Provide an optional app-style singleton desktop window and phone visuals. The active agent can open useful views and use a configured Hyprland MCP integration to move/fullscreen the host window. Hide view dismisses visuals without stopping voice or tasks; “close the view” has the same meaning. Close Mia shuts the client. When asked to show an already visible view, report that it is visible rather than creating another window. If it is on another workspace, offer to switch when Hyprland MCP or equivalent window control is available; otherwise explain the limitation.
- Mia receives each view's current dimensions and changes. Existing content remains usable during resize; the agent decides whether context warrants a content change. More space may prompt an offer of additional detail, not automatic new analysis on every resize.
- Zooming, sorting, and expanding existing content work directly. Meaningful clicks, such as choosing a PNG, can reach Mia as conversational input equivalent to a spoken choice. Requests for new data, analysis, or external actions go through the agent and existing permissions.

### Logs and tuning

- Keep audio, transcripts, exposed agent/tool events, results, errors, approvals, interruptions, and available usage data indefinitely outside Git. Organize by conversation start timestamp plus unique identifiers, linking tasks and job runs. Redact credentials; do not promise hidden model-provider reasoning or undisclosed prompts.
- Snapshot effective app prompts, exposed agent instructions, configuration, model identities, tool/display contracts, adapter versions, and relevant software versions. Each conversation references immutable prompt versions/content hashes, the architecture version and its design-document revision, and the running client/server build versions (including source commit and any local-change identifier). Retain the referenced snapshots so future edits do not erase debugging context. Linked tasks and job runs record their actual versions if different, including after a restart or device handoff. Distinguish generated speech from audio actually played.
- Start simple: no fixed latency thresholds yet. Record interruption, voice-model/active-agent response, rendering/update timing, and display-message size for later investigation. Separate local, model, and network delays where observable.
- Clients send diagnostic state snapshots on errors, reconnects, device handoffs, and significant state changes, plus a lightweight periodic heartbeat while running. Capture active view/dimensions, client/UI version, connection/microphone/playback state, recent interaction events, errors, and timing. Link records by client, conversation, task, and view identifiers with capture/receipt timestamps; avoid repeatedly sending unchanged detail.
- Store client diagnostics with server logs under the same retention policy. Expose relevant records through an agent diagnostic tool, rather than injecting them into every model request. Exclude credentials and sensitive approval content. Screenshots are optional and separately configurable; routine snapshots are structured state, not continuous screen recording. Missing or stale diagnostics must be apparent, including after disconnection or Close.

## Delivery approach

Each deliverable extends a working user journey. Provide one repeatable demo with expected results and test relevant failure cases as soon as the capability appears. Keep an acceptance record identifying each requirement as demonstrated live, verified with a test substitute, or blocked. Missing required capabilities block acceptance; a substitute is not a live pass.

Establish shared agent-adapter checks for approval and interruption in deliverable 1 and repeat them for each runtime. Establish UI-adapter content/event checks in deliverable 4. Re-run relevant earlier journeys as capabilities expand. End-to-end evaluation is continuous, not a final milestone.

## Deliverable 1 — Prove one agent adapter

Detailed implementation plan and C4 diagrams: [D1 implementation plan](D1/PLAN.md).

Connect a minimal text client through the Mia server to the active agent using one configured agent runtime and default model. Prove streamed results, tool approval requests/decisions, and interruption before adding voice. Start logs, basic client diagnostics, and exact prompt/configuration/architecture/build references here.

**User acceptance test:** Send a text task, inspect streamed results, approve one controlled MCP call and reject another. Require approval on every call; verify approval cannot be reused for another call or changed arguments. Interrupt a running task and inspect the recorded outcome.

**Pass:** No execution before required approval. New consequential actions are blocked during interruption; in-flight actions that cannot stop are reported honestly. Failures are visible, and unsupported approval policies are not silently weakened. Logs identify the actual agent, prompts, and builds; retained snapshots survive later edits. Use controlled fixtures for consequential tests.

## Deliverable 2 — Add desktop voice

Add the voice model (GPT-Live), hold-to-speak/release-to-submit, hands-free conversation, and concise spoken results to the proven agent path.

**User acceptance test:** Ask a substantive question and follow-up, approve/reject a tool request through the client, interrupt speech while work is running, and switch to hands-free mode.

**Pass:** Substantive questions reach the active agent. No stale playback after interruption and no microphone transmission outside the chosen listening mode. Verify no new consequential action starts while a correction is being heard. Record audio, transcripts, actual playback, and observable timing without credentials or sensitive approval content.

## Deliverable 3 — Complete the task lifecycle

Implement Close, reconnect, Continue/New conversation, basic task notifications, and Quit independently of the job service.

**User acceptance test:** Start a long task, Close, receive its completion notification, reopen and continue. Repeat with a failure and a pending approval request. Start a fresh conversation while prior work remains active. Disconnect unexpectedly, then test Quit and restart.

**Pass:** Close preserves server-side work; notifications offer resumption of the originating conversation without activating the microphone or speaking automatically. Pending approvals survive reconnect, and silence is never consent. Starting fresh does not inherit past context or cancel tasks. No duplicate execution after reconnection or uncertain outcomes. Quit stops Mia's server/clients, preserves records, and reports uncancellable work. Diagnostics distinguish unavailable clients from stale state.

## Deliverable 4 — Add one interactive view

Introduce the replaceable UI adapter for A2UI with a small chart or image-choice view, incremental updates, UI events, dimension reporting, and desktop view/window control.

**User acceptance test:** Ask Mia to show a view, select an image by click and by voice, and Hide view while continuing to talk. Ask to show it when it is already visible, then when its window is on another workspace. Resize, move, and fullscreen it where supported.

**Pass:** One desktop window; if already visible on the current workspace, Mia says so without creating another. If on another workspace, Mia offers to switch when Hyprland MCP or an equivalent integration is available. Missing window visibility/control support is explained; no claimed action without evidence. “Close the view” means Hide view, while Close Mia closes the client. Dimensions reach Mia and existing content remains usable; the agent decides whether to offer more detail. A meaningful selection reaches the correct conversation/task once. A minimal substitute UI adapter preserves content/event behavior without core changes. Invalid display content cannot execute arbitrary local actions. Capture display errors, message sizes, and render timing.

## Deliverable 5 — Take the journey to the phone

Extend the working voice, view, approval, and task-notification journey to a phone client, with explicit bidirectional device handoff.

**User acceptance test:** Start on desktop, open phone, decline then accept device handoff, continue with voice and visuals, and transfer back. Approve/reject a pending call after handoff. Close during a task and reopen from a phone notification. Exercise connection loss and host unavailability.

**Pass:** One active conversation and client, with voice and visuals moving together and no duplicate agents/actions. Only authorized clients can connect; no unsolicited microphone activation or silently queued consequential commands. Conversation, visual state, and pending approvals remain correctly associated. Phone supports showing/hiding views; workspace controls apply to desktop only.

## Deliverable 6 — Expand agents and concurrency

Add the remaining agent runtimes, explicit big-gun escalation, task transfer, worker agents, and tool-specific parallelism. Use the same adapter acceptance checks for each runtime.

**User acceptance test:** Repeat the text/voice/approval/interruption journey with each configured runtime. Run parallel searches alongside serialized computer-use actions. Escalate one of two independent tasks and verify the other retains its assigned model.

**Pass:** Correct model attribution; no automatic escalation, duplicate execution ownership, or conflicting use of shared browser/desktop/file state. Task transfer preserves context. Default and big-gun agents honor approval policies and interruption. Any runtime missing required behavior remains blocked rather than being marked supported.

## Deliverable 7 — Add recall and richer workflows

Add sourced past-conversation retrieval, richer charts/tables/metrics/test reports, agent retrieval of client diagnostics, and substantial browser/coding workflows.

**User acceptance test:** Start fresh and retrieve an earlier decision. Show Apple's stock price over seven days, switch to a table, and accept an offer of more detail after enlarging the view. Find/book a haircut within configured constraints; build and test a Dreame vacuum-control plugin and show the test report. Trigger a controlled rendering failure and ask why the chart disappeared.

**Pass:** Retrieved history is identifiable as past context, not a new command. Market data has sources, dates/timezone, and non-trading-day treatment. Booking obeys approval policy; simulate a lost submission response and verify the outcome before retrying. Plugin outcomes are verified with relevant tests; device-dependent checks identify required hardware. The plugin is an acceptance task, not a required embedded Mia integration. Client diagnostics support an evidence-based explanation of the controlled UI failure without requiring reproduction; absent/stale evidence is reported as uncertainty. Repeat representative journeys across devices and compare prompt versions without replaying real-world side effects.

## Deliverable 8 — Integrate the job service

Connect the separate job service for deterministic schedules and intelligent monitoring, reusing the established notification/resumption journey. Ordinary long-running Mia tasks must already work without this service.

**Separate-repo interface:** CLI/API to create, inspect, list, update, pause/resume, and cancel jobs and inspect job runs/results. Include schedules/triggers, deterministic actions or agent tasks, model where needed, authorization, notification destination, originating conversation, stable identities, status/errors, cancellation outcomes, restart recovery, missed runs, duplicate suppression, and monitoring freshness.

**User acceptance test:** Schedule a daily 10 am vacuum action without model involvement per job run. Create an intelligent X-news monitor for company breaking news that notifies a configured Slack destination. Inspect/cancel both through Mia and directly through the job-service CLI. Close Mia's client and verify notifications still offer the correct conversation on return.

**Pass:** Jobs persist independently and execute/notify within authorized criteria without duplicates. Results remain retrievable if notification delivery is delayed. State actual monitoring access/latency limits. Use a contract substitute while the separate service is unavailable, but mark live job acceptance blocked until the real service and integrations pass. Repeat relevant earlier journeys to verify integration preserves voice, approvals, views, and lifecycle behavior.

## Prompt budget and implementation guidance

Start with two versioned templates: voice-model instructions and shared agent instructions. Agents using the default or big-gun model initially share the agent template. Add summary/specialist prompts only when justified; aim for two to four app-owned templates. Version tool and display definitions alongside them.

Evaluate task success, transcription/delegation errors, interruption correctness, duplicate actions, latency, message size, spoken brevity, and available cost. Compare saved examples without replaying real-world side effects. Tuning means prompt iteration.

The implementer should verify current Live, CLI, MCP, and A2UI capabilities before implementation and choose implementation details independently. Confirm required capabilities early; present concrete alternatives for the maintainer when missing capabilities block requirements. Each milestone report states what works, the user acceptance demo, automated verification, and remaining blockers. Do not substitute a narrower behavior and mark it complete.
