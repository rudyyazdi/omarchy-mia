// The page of `mia debug watch`. It applies the server's messages (WatchMessage in watch-feed.ts) to a tree
// of <details> sections. The server renders, redacts and escapes every fragment, so this only places them.
const tree = document.getElementById("tree");
const state = document.getElementById("state");

/** Every node shown, by the id the server gives it. Rebuilt on each connection, which replays from the start. */
const nodes = new Map();
let newestTask = null;

const element = (tag, className) => {
  const created = document.createElement(tag);
  created.className = className;
  return created;
};

const countEvents = (node, count) => {
  node.eventCount = count;
  node.rawLine.textContent = `raw events (${count})`;
  node.raw.hidden = count === 0;
};

/** A node's section: its line, its fields, the nodes under it, then its raw events, collapsed. */
const section = (className) => {
  const node = {
    details: element("details", className),
    line: element("summary", "line"),
    fields: element("div", "fields"),
    children: element("div", "children"),
    raw: element("details", "raw"),
    rawLine: element("summary", "line"),
    events: element("div", "events"),
    eventCount: 0,
  };
  node.raw.append(node.rawLine, node.events);
  node.details.append(node.line, node.fields, node.children, node.raw);
  countEvents(node, 0);
  return node;
};

const show = (node, view) => {
  node.line.innerHTML = view.summary;
  node.fields.innerHTML = view.body;
};

const reset = () => {
  nodes.clear();
  newestTask = null;
  const conversation = section("node conversation");
  conversation.details.open = true;
  nodes.set("conversation", conversation);
  tree.replaceChildren(conversation.details);
};

/** The node a message names as its parent; one the page lacks puts the message at the conversation level. */
const parentOf = (message) => nodes.get(message.parent) ?? nodes.get("conversation");

/** Adds a node, or replaces the header of one already shown. Only the newest task starts open. */
const upsert = (message) => {
  const known = nodes.get(message.id);
  if (known) {
    show(known, message.view);
    return;
  }
  const node = section(`node ${message.kind}`);
  nodes.set(message.id, node);
  show(node, message.view);
  parentOf(message).children.append(node.details);
  if (message.kind !== "task") return;
  if (newestTask) newestTask.details.open = false;
  node.details.open = true;
  newestTask = node;
};

const appendEvent = (message) => {
  const parent = parentOf(message);
  const event = element("details", "event");
  const line = element("summary", "line");
  const fields = element("div", "fields");
  line.innerHTML = message.view.summary;
  fields.innerHTML = message.view.body;
  event.append(line, fields);
  parent.events.append(event);
  countEvents(parent, parent.eventCount + 1);
};

const source = new EventSource("events");

const handlers = {
  conversation: (message) => show(nodes.get("conversation"), message.view),
  node: upsert,
  event: appendEvent,
  stopped: (message) => {
    source.close();
    state.textContent = message.message;
  },
};

source.addEventListener("open", () => {
  reset();
  state.textContent = "live";
});
source.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  handlers[message.op]?.(message);
});
source.addEventListener("error", () => {
  state.textContent =
    source.readyState === EventSource.CLOSED
      ? "the watch refused this page (too many pages, or it is stopping)"
      : "disconnected; reconnecting…";
});
