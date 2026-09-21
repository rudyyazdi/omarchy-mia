#!/usr/bin/env python3
"""Turn an opencode GitHub Action review comment into line-anchored PR review
comments, and on later pushes triage prior threads (resolve addressed ones,
reply to responses).

The action can only post one top-level issue comment, so the reviewer prompts
return a JSON object and this script reproduces it as a real pull-request review
(one thread per changed line) plus a summary for findings that cannot be
anchored to the diff. Previous runs' review summaries and top-level action
comments are cleaned up only after the new review is posted. Open threads
are kept for triage, including bot-only ones.

Usage:
  post-review.py dump-threads
  post-review.py post
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

TOKEN = None
RESOLVE_TOKEN = None
API = None
REPO = None
PR = None
NAME = None
RUN_ID = ""
PR_DIFF = ""
THREADS_FILE = "prior-threads.json"
MARKER = None
REVIEWER_RE = None
SEVERITY = {"high": "**High**", "medium": "**Medium**", "low": "**Low**"}

_bot_login = None
_owner = None
_repo = None


def load_env():
    global TOKEN, RESOLVE_TOKEN, API, REPO, PR, NAME, RUN_ID, PR_DIFF, THREADS_FILE
    global MARKER, REVIEWER_RE, _owner, _repo
    TOKEN = os.environ["GITHUB_TOKEN"]
    # User PAT for resolveReviewThread only. GITHUB_TOKEN cannot resolve threads
    # (Resource not accessible by integration); keep TOKEN for bot identity.
    RESOLVE_TOKEN = os.environ.get("RESOLVE_TOKEN") or TOKEN
    API = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    REPO = os.environ["GITHUB_REPOSITORY"]
    PR = os.environ["PR_NUMBER"]
    NAME = os.environ["REVIEW_NAME"]
    RUN_ID = os.environ.get("GITHUB_RUN_ID", "")
    PR_DIFF = os.environ.get("PR_DIFF", "")
    THREADS_FILE = os.environ.get("PRIOR_THREADS", "prior-threads.json")
    MARKER = f"<!-- opencode-review:{NAME} -->"
    REVIEWER_RE = re.compile(rf'"reviewer"\s*:\s*"{re.escape(NAME)}"', re.I)
    _owner, _repo = REPO.split("/", 1)


def req(method, path, data=None, accept="application/vnd.github+json", raw=False, token=None):
    url = path if path.startswith("http") else API + path
    body = json.dumps(data).encode() if data is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("Authorization", f"Bearer {token or TOKEN}")
    request.add_header("Accept", accept)
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    request.add_header("User-Agent", "opencode-review")
    if body is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode()
            if raw:
                return response.status, text
            return response.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return 0, str(error)


def graphql(query, variables=None, token=None):
    status, data = req(
        "POST",
        "/graphql",
        {"query": query, "variables": variables or {}},
        token=token,
    )
    if status != 200 or not isinstance(data, dict):
        print(f"warn: graphql returned {status}: {data}")
        return None
    if data.get("errors"):
        print(f"warn: graphql errors: {data['errors']}")
        return None
    return data.get("data")


def paged(path):
    items = []
    page = 1
    while True:
        joiner = "&" if "?" in path else "?"
        status, data = req("GET", f"{path}{joiner}per_page=100&page={page}")
        if status != 200 or not isinstance(data, list):
            print(f"warn: GET {path} returned {status}: {data}")
            return None
        items.extend(data)
        if len(data) < 100:
            break
        page += 1
    return items


def bot_login():
    global _bot_login
    if _bot_login is None:
        status, user = req("GET", "/user")
        if status == 200 and isinstance(user, dict) and user.get("login"):
            _bot_login = user["login"]
        else:
            _bot_login = "github-actions[bot]"
    return _bot_login


def is_bot_login(login):
    if not login:
        return False
    bot = bot_login()
    return login == bot or login in ("github-actions[bot]", "github-actions")


def is_bot(item):
    login = (item.get("user") or item.get("author") or {}).get("login")
    return is_bot_login(login)


def extract_json(body):
    body = body.replace(MARKER, "")
    fenced = re.search(r"```(?:json)?\s*(.*?)```", body, re.S)
    if fenced:
        body = fenced.group(1)
    start = body.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(body)):
        char = body[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(body[start : index + 1])
                except ValueError:
                    return None
    return None


def find_action_comment():
    comments = paged(f"/repos/{REPO}/issues/{PR}/comments")
    if comments is None:
        return None
    for comment in comments:
        if not is_bot(comment):
            continue
        if f"/actions/runs/{RUN_ID}" not in (comment.get("body") or ""):
            continue
        payload = extract_json(comment["body"])
        if isinstance(payload, dict) and str(payload.get("reviewer", "")).lower() == NAME.lower():
            return comment
    print(f"warn: no bot action comment carrying reviewer={NAME} for run {RUN_ID}")
    return None


def parse_diff(text):
    lines = {}
    path = None
    line_no = 0
    in_hunk = False
    for line in text.splitlines():
        if line.startswith("diff --git "):
            path = None
            line_no = 0
            in_hunk = False
        elif line.startswith("+++ "):
            rest = line[4:].split("\t", 1)[0]
            if rest.startswith("b/"):
                path = rest[2:]
            elif rest == "/dev/null":
                path = None
            else:
                path = rest
        elif line.startswith("@@"):
            match = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)", line)
            if match:
                line_no = int(match.group(1))
                in_hunk = True
        elif path and in_hunk and line.startswith("+"):
            lines.setdefault(path, set()).add(line_no)
            line_no += 1
        elif path and in_hunk and line.startswith("-"):
            pass
        elif path and in_hunk and line.startswith(" "):
            lines.setdefault(path, set()).add(line_no)
            line_no += 1
    return lines


def valid_lines():
    if PR_DIFF and os.path.exists(PR_DIFF):
        with open(PR_DIFF, encoding="utf-8", errors="replace") as handle:
            return parse_diff(handle.read())
    status, text = req(
        "GET",
        f"/repos/{REPO}/pulls/{PR}",
        accept="application/vnd.github.v3.diff",
        raw=True,
    )
    if status != 200:
        print(f"warn: could not fetch PR diff ({status})")
        return None
    return parse_diff(text)


def fetch_review_threads():
    query = """
    query($owner:String!,$repo:String!,$pr:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$pr){
          reviewThreads(first:100){
            pageInfo{ hasNextPage }
            nodes{
              id
              isResolved
              isOutdated
              path
              line
              comments(first:100){
                pageInfo{ hasNextPage }
                nodes{
                  databaseId
                  author{login}
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }
    """
    data = graphql(query, {"owner": _owner, "repo": _repo, "pr": int(PR)})
    if not data:
        return None
    connection = (
        data.get("repository", {})
        .get("pullRequest", {})
        .get("reviewThreads", {})
        or {}
    )
    if connection.get("pageInfo", {}).get("hasNextPage"):
        print("warn: reviewThreads truncated at 100; later threads may be missed")
    nodes = connection.get("nodes") or []
    for thread in nodes:
        if (thread.get("comments") or {}).get("pageInfo", {}).get("hasNextPage"):
            print(f"warn: comments truncated at 100 on thread {thread.get('id')}")
    return nodes


def ours(thread):
    comments = thread.get("comments", {}).get("nodes") or []
    return any(MARKER in (c.get("body") or "") for c in comments)


def has_human_reply(thread):
    comments = thread.get("comments", {}).get("nodes") or []
    return any(not is_bot_login((c.get("author") or {}).get("login")) for c in comments)


def serialize_thread(thread):
    comments = []
    for comment in thread.get("comments", {}).get("nodes") or []:
        body = comment.get("body") or ""
        if len(body) > 600:
            body = body[:600] + "…"
        comments.append(
            {
                "id": comment.get("databaseId"),
                "author": (comment.get("author") or {}).get("login"),
                "body": body,
                "created_at": comment.get("createdAt"),
            }
        )
    return {
        "thread_id": thread["id"],
        "path": thread.get("path"),
        "line": thread.get("line"),
        "is_outdated": bool(thread.get("isOutdated")),
        "comments": comments,
    }


def dump_threads():
    threads = fetch_review_threads()
    if threads is None:
        print("warn: could not load review threads; writing empty prior-threads.json")
        open_threads = []
    else:
        open_threads = [serialize_thread(t) for t in threads if not t.get("isResolved") and ours(t)]
    with open(THREADS_FILE, "w", encoding="utf-8") as handle:
        json.dump(open_threads, handle, indent=2)
        handle.write("\n")
    print(f"wrote {len(open_threads)} open {NAME} thread(s) to {THREADS_FILE}")
    return 0


def load_prior_threads():
    if not os.path.exists(THREADS_FILE):
        return []
    try:
        with open(THREADS_FILE, encoding="utf-8", errors="replace") as handle:
            data = json.load(handle)
    except (ValueError, OSError) as error:
        print(f"warn: could not parse {THREADS_FILE} ({error}); treating as no prior threads")
        return []
    return data if isinstance(data, list) else []


def root_comment_id(thread_id, prior):
    for thread in prior:
        if thread.get("thread_id") == thread_id:
            comments = thread.get("comments") or []
            if comments and comments[0].get("id") is not None:
                return comments[0]["id"]
    return None


def normalize_body(text):
    return re.sub(r"\s+", " ", (text or "").replace(MARKER, "")).strip()


def thread_has_body(thread_id, body, prior):
    want = normalize_body(body)
    if not want:
        return False
    for thread in prior:
        if thread.get("thread_id") != thread_id:
            continue
        return any(normalize_body(c.get("body")) == want for c in (thread.get("comments") or []))
    return False


def reply_to_thread(thread_id, body, prior):
    root_id = root_comment_id(thread_id, prior)
    if root_id is None:
        print(f"warn: no root comment for thread {thread_id}")
        return False
    if thread_has_body(thread_id, body, prior):
        print(f"skip duplicate reply on thread {thread_id}")
        return True
    text = body.strip()
    if MARKER not in text:
        text = f"{text}\n\n{MARKER}"
    status, result = req(
        "POST",
        f"/repos/{REPO}/pulls/{PR}/comments/{root_id}/replies",
        {"body": text},
    )
    if status not in (200, 201):
        status, result = req(
            "POST",
            f"/repos/{REPO}/pulls/{PR}/comments",
            {"body": text, "in_reply_to": root_id},
        )
    if status not in (200, 201):
        print(f"warn: reply to {thread_id} failed ({status}): {result}")
        return False
    # So a later identical action in the same run also no-ops.
    for thread in prior:
        if thread.get("thread_id") == thread_id:
            thread.setdefault("comments", []).append({"id": None, "author": bot_login(), "body": text})
            break
    print(f"replied on thread {thread_id}")
    return True


def resolve_thread(thread_id):
    mutation = """
    mutation($id:ID!){
      resolveReviewThread(input:{threadId:$id}){
        thread{ isResolved }
      }
    }
    """
    data = graphql(mutation, {"id": thread_id}, token=RESOLVE_TOKEN)
    if not data:
        print(f"warn: could not resolve thread {thread_id}")
        return False
    print(f"resolved thread {thread_id}")
    return True


def apply_thread_actions(actions, prior):
    if not isinstance(actions, list):
        return set()
    known = {t.get("thread_id") for t in prior if t.get("thread_id")}
    touched = set()
    for action in actions:
        if not isinstance(action, dict):
            continue
        thread_id = action.get("thread_id")
        kind = (action.get("action") or "").lower().strip()
        body = (action.get("body") or "").strip()
        if not thread_id or thread_id not in known:
            print(f"warn: skipping unknown thread action: {action!r}")
            continue
        if kind == "reply":
            if not body:
                print(f"warn: reply on {thread_id} missing body")
                continue
            if reply_to_thread(thread_id, body, prior):
                touched.add(thread_id)
        elif kind == "resolve":
            if body:
                reply_to_thread(thread_id, body, prior)
            if resolve_thread(thread_id):
                touched.add(thread_id)
        else:
            print(f"warn: unknown thread action {kind!r} on {thread_id}")
    return touched


def open_locations(prior):
    locs = set()
    for thread in prior:
        path = thread.get("path")
        line = thread.get("line")
        if path and line is not None:
            locs.add((path, int(line)))
    return locs


def cleanup_old(new_review_id, preserve_comment_ids):
    comments = paged(f"/repos/{REPO}/pulls/{PR}/comments")
    if comments is None:
        return
    threads = fetch_review_threads() or []
    # Conversations and resolved threads are kept on purpose so triage history
    # and human replies survive cleanup on later pushes.
    keep_comment_ids = set(preserve_comment_ids)
    for thread in threads:
        if not ours(thread):
            continue
        if has_human_reply(thread) or thread.get("isResolved"):
            for comment in thread.get("comments", {}).get("nodes") or []:
                if comment.get("databaseId") is not None:
                    keep_comment_ids.add(comment["databaseId"])

    for comment in comments:
        if not is_bot(comment):
            continue
        if MARKER not in (comment.get("body") or ""):
            continue
        if comment.get("pull_request_review_id") == new_review_id:
            continue
        if comment["id"] in keep_comment_ids:
            continue
        if comment.get("in_reply_to_id") and comment["in_reply_to_id"] in keep_comment_ids:
            continue
        status, _ = req("DELETE", f"/repos/{REPO}/pulls/comments/{comment['id']}")
        print(f"removed old review comment {comment['id']}: {status}")

    reviews = paged(f"/repos/{REPO}/pulls/{PR}/reviews")
    if reviews is None:
        return
    for review in reviews:
        if not is_bot(review):
            continue
        if MARKER in (review.get("body") or "") and review["id"] != new_review_id:
            status, _ = req("PUT", f"/repos/{REPO}/pulls/{PR}/reviews/{review['id']}", {"body": MARKER})
            print(f"blanked old review {review['id']}: {status}")
    issues = paged(f"/repos/{REPO}/issues/{PR}/comments")
    if issues is None:
        return
    for comment in issues:
        if is_bot(comment) and REVIEWER_RE.search(comment.get("body") or ""):
            status, _ = req("DELETE", f"/repos/{REPO}/issues/comments/{comment['id']}")
            print(f"removed stale top-level comment {comment['id']}: {status}")


def preserve_ids_from_prior(prior):
    ids = set()
    for thread in prior:
        for comment in thread.get("comments") or []:
            if comment.get("id") is not None:
                ids.add(comment["id"])
    return ids


def post():
    comment = find_action_comment()
    if not comment:
        print("no action comment to convert; skipping post")
        return 0

    payload = extract_json(comment["body"])
    if not isinstance(payload, dict):
        print("warn: action comment was not the expected JSON; leaving it in place")
        return 1

    prior = load_prior_threads()
    status, pull = req("GET", f"/repos/{REPO}/pulls/{PR}")
    if status != 200 or not isinstance(pull, dict):
        print(f"warn: could not read PR head ({status}); leaving action comment in place")
        return 1
    head = pull["head"]["sha"]

    summary = (payload.get("summary") or "").strip()
    findings = payload.get("findings")
    if not isinstance(findings, list):
        findings = []
    actions = payload.get("thread_actions")
    if not isinstance(actions, list):
        actions = []
    anchorable = valid_lines()
    if anchorable is None:
        print("warn: could not determine diff lines; leaving action comment in place")
        return 1

    existing = open_locations(prior)
    comments = []
    fallback = []
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        path = finding.get("path")
        body = (finding.get("body") or "").strip()
        severity = (finding.get("severity") or "").lower()
        try:
            line = int(finding.get("line"))
        except (TypeError, ValueError):
            line = None
        if not body:
            continue
        if path and line is not None and (path, line) in existing:
            print(f"skip duplicate finding {path}:{line} — open thread already covers it")
            continue
        if path and line is not None and line in anchorable.get(path, set()):
            prefix = f"{SEVERITY[severity]} — " if severity in SEVERITY else ""
            comments.append({"path": path, "line": line, "side": "RIGHT", "body": f"{prefix}{body}\n\n{MARKER}"})
        else:
            where = f"{path or '?'}:{line if line is not None else '?'}"
            fallback.append(f"- `{where}` — {body}")

    if not comments and not fallback and not summary and not actions:
        status, _ = req("DELETE", f"/repos/{REPO}/issues/comments/{comment['id']}")
        print(f"nothing to report; deleted action comment: {status}")
        cleanup_old(None, preserve_ids_from_prior(prior))
        return 0

    # Post the review (or skip on triage-only) before applying thread actions so
    # a failed post leaves the action comment and does not double-reply on retry.
    new_review_id = None
    if comments or fallback or summary:
        parts = [MARKER]
        if summary:
            parts.append(summary)
        if fallback:
            parts.append("**Findings off the changed lines**\n" + "\n".join(fallback))
        status, review = req(
            "POST",
            f"/repos/{REPO}/pulls/{PR}/reviews",
            {"commit_id": head, "event": "COMMENT", "body": "\n\n".join(parts), "comments": comments},
        )
        if status not in (200, 201) or not isinstance(review, dict) or not review.get("id"):
            print(f"warn: could not post review ({status}): {review}; leaving action comment in place")
            return 1
        new_review_id = review["id"]
        print(f"posted review {new_review_id} with {len(comments)} inline comment(s)")

    apply_thread_actions(actions, prior)

    status, _ = req("DELETE", f"/repos/{REPO}/issues/comments/{comment['id']}")
    print(f"deleted action comment: {status}")
    cleanup_old(new_review_id, preserve_ids_from_prior(prior))
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ("dump-threads", "post"):
        load_env()
        if sys.argv[1] == "dump-threads":
            return dump_threads()
        return post()
    print(f"usage: {sys.argv[0]} dump-threads|post", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
