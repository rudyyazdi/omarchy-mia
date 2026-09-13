# Mia: voice assistant for Omarchy

## Outcome and scope

An open-source client/server voice assistant controlling a user-configured Omarchy host through configured agent runtimes. Desktop and phone clients share one conversation, with optional interactive visuals, explicit device handoff, parallel tasks where tools allow it, and past-conversation retrieval. Remote operation requires the configured host to be awake and online.

Implement the eight testable deliverables below. Client/server separation is foundational from deliverable 1. Each milestone needs a user acceptance demo, relevant automated checks, and an acceptance checkpoint before expanding scope. This is an implementation plan; the planning task does not authorize implementation. Run agents through user-installed Codex, Claude Code, or OpenCode CLIs, reusing their authentication; document prerequisites and detect missing setup rather than assuming a particular developer's environment. Users need only configure the agent runtimes they intend to use.

The project must be usable without the original author's accounts, paths, devices, or private services. Keep credentials, personal configuration, recordings, and logs outside version control; provide generic setup examples. Live service/device acceptance tests use the tester's own configured integrations.

## Out of scope and future expansion

- **Restricted agent tools:** Later, reuse CLI authentication while exposing only Mia-configured tools, without inheriting personal MCP servers, plugins, hooks, or permissions. Keep authentication reuse separate from tool configuration and approval policies in agent adapters so this can be added without rewriting orchestration. Future enforcement must cover the active agent and worker agents using either default or big-gun models, and bypass paths such as unrestricted shell access. Implementing or proving this isolation is not part of the current deliverables; existing approval and interruption requirements still apply.
- **Job-service implementation:** Build scheduling/monitoring in a separate repo. This plan includes its contract and integration (deliverable 7), not its engine or external-service shutdown policy. The contract covers job and job-run identities, schedules/triggers, deterministic or agent work, authorization, notifications, history, cancellation, and recovery.
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
- Provide an optional app-style singleton desktop window and phone visuals. The active agent can open useful views and use a configured Hyprland MCP integration to move/fullscreen the host window. Hide view dismisses visuals without stopping voice or tasks; Close shuts the client.
- Mia receives each view's current dimensions and changes. Existing content remains usable during resize; the agent decides whether context warrants a content change. More space may prompt an offer of additional detail, not automatic new analysis on every resize.
- Zooming, sorting, and expanding existing content work directly. Meaningful clicks, such as choosing a PNG, can reach Mia as conversational input equivalent to a spoken choice. Requests for new data, analysis, or external actions go through the agent and existing permissions.

### Logs and tuning

- Keep audio, transcripts, exposed agent/tool events, results, errors, approvals, interruptions, and available usage data indefinitely outside Git. Organize by conversation start timestamp plus unique identifiers, linking tasks and job runs. Redact credentials; do not promise hidden model-provider reasoning or undisclosed prompts.
- Snapshot effective app prompts, exposed agent instructions, configuration, model identities, tool/display contracts, adapter versions, and relevant software versions. Each conversation references immutable prompt versions/content hashes, the architecture version and its design-document revision, and the running client/server build versions (including source commit and any local-change identifier). Retain the referenced snapshots so future edits do not erase debugging context. Linked tasks and job runs record their actual versions if different, including after a restart or device handoff. Distinguish generated speech from audio actually played.
- Start simple: no fixed latency thresholds yet. Record interruption, voice-model/active-agent response, rendering/update timing, and display-message size for later investigation. Separate local, model, and network delays where observable.
- Clients send diagnostic state snapshots on errors, reconnects, device handoffs, and significant state changes, plus a lightweight periodic heartbeat while running. Capture active view/dimensions, client/UI version, connection/microphone/playback state, recent interaction events, errors, and timing. Link records by client, conversation, task, and view identifiers with capture/receipt timestamps; avoid repeatedly sending unchanged detail.
- Store client diagnostics with server logs under the same retention policy. Expose relevant records through an agent diagnostic tool, rather than injecting them into every model request. Exclude credentials and sensitive approval content. Screenshots are optional and separately configurable; routine snapshots are structured state, not continuous screen recording. Missing or stale diagnostics must be apparent, including after disconnection or Close.

## Deliverable 1 — Voice basics

One desktop client, the Mia server, the voice model (GPT-Live), and the active agent using the configured default model. Include hold/release, hands-free mode, interruption, concise speech, errors, logging, and basic client diagnostics from the outset.

**User acceptance test:** Ask a substantive question and follow-up; interrupt a long answer; switch to hands-free. Inspect transcripts, audio, timing, model attribution, and prompt snapshots. Verify the conversation identifies its exact prompts, architecture/design revision, and running builds, with snapshots still retrievable after a later prompt edit.

**Pass:** Substantive questions demonstrably reach the active agent. Coherent turns, no stale playback after interruption, no microphone transmission outside the chosen listening mode, and visible failures without silently replayed work. Client state changes and heartbeat timestamps can be correlated with server events without recording credentials or sensitive approval content.

## Deliverable 2 — Client/server lifecycle

Implement Close, reconnect, Continue/New conversation, and Quit, with persistent conversation/task records. Keep ordinary task persistence distinct from the separate job service.

**User acceptance test:** Start a controlled long task, close the client, reopen and continue, then start fresh. Disconnect unexpectedly. Quit Mia with work active, verify its server and clients have stopped, and restart afterward.

**Pass:** Close preserves the server and running work; reconnect exposes results and pending input without duplicate execution. Fresh context is clean. Quit stops Mia's server and clients, records task outcomes, and reports uncancellable work. Notification delivery is completed in deliverable 7.

## Deliverable 3 — Phone and device handoff

Provide remote voice and basic visual access to the same host with explicit bidirectional device handoff. Voice and visuals share one active client. Full generated views follow in deliverable 6.

**User acceptance test:** Start on desktop, open phone, decline then accept device handoff, continue the same conversation, and transfer back. Verify voice and visual state move together and the previous client is no longer active. Test loss of connectivity.

**Pass:** One conversation and one active client for both voice and visuals; no duplicate agents/actions or unsolicited microphone activation. Conversation and visual state survive device handoff. Access is limited to the user's authorized clients; unavailable-host behavior is clear.

## Deliverable 4 — Tools and execution

Connect existing tools and browser access. Establish per-tool approval policies, client approval requests, outcome verification, and tool-specific concurrency.

**User acceptance test:** Find and book a haircut within supplied constraints. Interrupt to change a preference before submission. Run parallel searches alongside serialized computer actions. Simulate losing the response after booking submission. Configure a test MCP tool to require approval on every call; approve one, reject another, and hand off devices while a third is pending.

**Pass:** Correct host/browser context and booking; no execution before required approval, no reused approval for another/changed call, no blind duplicate submission. Pending approvals reach the active client across device handoff/reconnect. Unsupported approval policies are reported rather than claimed enforced. Explicitly test a running agent attempting another consequential action while the user speaks: it must be blocked. Report in-flight actions that cannot stop. Automated consequential tests use controlled fixtures, not repeated live bookings.

## Deliverable 5 — Agent switching and recall

Support all three existing agent runtimes, explicit escalation, parallel independent tasks, deliberate task transfer, and searchable past conversations.

**User acceptance test:** Start with each configured default; run two independent tasks, escalate one, and check the other retains its model. Start fresh and retrieve an earlier decision.

**Pass:** Correct model attribution, no automatic escalation or duplicate ownership, and sourced history treated as past context rather than a new command. Repeat interruption/concurrency checks for each agent runtime. Missing required capabilities block the affected milestone; merely reporting them is not a pass.

## Deliverable 6 — Visual companion

Deliver the replaceable UI adapter for A2UI, compact updates, interactive views, dimension awareness, desktop window control, and agent retrieval of relevant client diagnostics.

**User acceptance test:** Show Apple's stock price over seven days; switch to a table. Move/fullscreen the window, resize it, and view on phone. Accept an offer of more detail. Choose a PNG by click and by voice; inspect and expand test failures. Trigger a controlled rendering failure, then ask Mia why the chart disappeared; verify it retrieves the relevant client state and error without requiring a screenshot or reproduction.

**Pass:** Correct incremental updates and sourced market data with dates/timezone and non-trading-day treatment. Dimensions reach Mia; context determines whether to offer more detail. Selection reaches the correct conversation/task once. Desktop remains singleton. Invalid content cannot execute arbitrary local actions. A minimal substitute UI adapter demonstrates equivalent content/event behavior without core changes. Record render timings and message sizes for later tuning. Diagnosis of the controlled failure cites the captured evidence; absent or stale records are reported as uncertainty, not invented causes.

## Deliverable 7 — Job-service integration and notifications

Notify about long-task completion/failure/input needs and resume the originating conversation. Integrate with the separately owned job service described under Out of scope and future expansion; use a contract substitute until available.

**Separate-repo interface:** CLI/API to create, inspect, list, update, pause/resume, and cancel jobs and inspect job runs/results. Describe schedule/trigger, deterministic action or agent task, model when needed, constraints/authorization, notification destination, and originating conversation. Expose stable job and job-run identities, status, errors, and cancellation outcomes. Specify restart recovery, missed job runs, duplicate suppression, and monitoring freshness per job.

**User acceptance test:** Close the client during a long task, receive a completion notification to reopen it, and resume from phone. Schedule a daily 10 am vacuum action without model involvement per run; create an intelligent X-news monitor notifying the user on a configured Slack destination. Inspect/cancel both directly through the job-service CLI.

**Pass:** Results remain retrievable if delivery is delayed. Notifications resume the right conversation without duplicating work or automatically speaking. Jobs persist independently and notify within authorized criteria. Report actual monitoring latency/access limits. Contract tests alone do not satisfy live integration acceptance; the job service is a dependency.

## Deliverable 8 — End-to-end acceptance and evaluation

Complete the haircut booking, build/test a Dreame vacuum-control plugin, and monitor X for company breaking news with Slack notification. The plugin is an acceptance task for Mia, not an embedded Mia integration requirement.

**User acceptance test:** Run those workflows across desktop/phone with visuals; interrupt, hand off, close, and reconnect during work. Separately verify clean shutdown with Quit. Inspect full conversation/task/job records. Compare representative tasks before and after a prompt change.

**Pass:** Verified outcomes, usable recovery, understandable failures, and traceable actions across clients, agents, views, and jobs. Test doubles cover consequential failures; final live checks require actual services/devices and existing permissions. Unavailable required dependencies remain explicit blockers.

## Prompt budget and implementation guidance

Start with two versioned templates: voice-model instructions and shared agent instructions. Agents using the default or big-gun model initially share the agent template. Add summary/specialist prompts only when justified; aim for two to four app-owned templates. Version tool and display definitions alongside them.

Evaluate task success, transcription/delegation errors, interruption correctness, duplicate actions, latency, message size, spoken brevity, and available cost. Compare saved examples without replaying real-world side effects. Tuning means prompt iteration.

The implementer should verify current Live, CLI, MCP, and A2UI capabilities before implementation and choose implementation details independently. Confirm required capabilities early; present concrete alternatives for the maintainer when missing capabilities block requirements. Each milestone report states what works, the user acceptance demo, automated verification, and remaining blockers. Do not substitute a narrower behavior and mark it complete.
