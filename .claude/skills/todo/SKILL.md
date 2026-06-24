---
name: todo
description: Capture, list, and complete personal todos as GitHub issues. Use when the user types /todo to jot a task, asks what to do next from their todos, or marks a todo done. Wraps the gh CLI; namespaces personal todos with a `todo` label assigned to @me.
---

# /todo — personal todos as GitHub issues

Capture and manage the user's personal todos as GitHub issues in the current repo.
This skill is pure instructions: you (the model) run `gh` commands directly. There is
no script to execute.

## Preconditions (always check first)

1. Confirm `gh` is authenticated:

   ```
   gh auth status
   ```

   If this fails, STOP and tell the user:
   "GitHub CLI isn't authenticated — run `gh auth login`, then try `/todo` again."
   Do not attempt any issue operation until auth succeeds.

2. Ensure the `todo` label exists (idempotent — `--force` upserts, so this is safe to
   run every time before creating and won't error if the label already exists):

   ```
   gh label create todo --description "Personal todo captured via /todo" --color ededed --force
   ```

## Determine intent

Read whatever the user typed after `/todo` and pick exactly one mode:

- **Complete** — the text clearly says an existing todo is finished, e.g. it starts
  with `done:` / `complete:` / `close:` (a colon-prefixed marker) or plainly states a
  task is done. Treat a bare leading word like "done" WITHOUT a colon as a normal task
  to Add unless the rest of the text clearly refers to finishing an existing todo
  (e.g. `/todo done documenting the API` is an Add, not a Complete). When unsure, fall
  through to the ambiguity rule below. → go to **Complete**.
- **Query** — the text is a question or a list/show request ("what should I do next?",
  "list", "show", "what's open", "show #chat", or empty input). → go to **Query**.
- **Add** — anything else (an imperative task to capture, e.g. "wire up the Mongo
  checkpointer"). → go to **Add**.

If the input is genuinely ambiguous between capturing a task and asking a question,
ask ONE clarifying question instead of guessing.

## Add

Create an issue from the user's text. The one-liner is the title; if the user supplied
extra detail, put it in the body.

```
gh issue create --title "<the todo text>" --label todo --assignee @me
```

- To add detail: append `--body "<longer detail>"`.
- Optional tags: if the user's text contains `#word` tokens, add each as a label with
  `--label <word>` (bootstrap each first with the same idempotent
  `gh label create <word> ... --force` as above) and STRIP the `#word` tokens from the
  title so the tag isn't duplicated in the title text. The `todo` label is ALWAYS
  applied regardless.
- Report back the created issue number and URL (gh prints the URL on success).

## Query

List the user's open todos, then reason over them — prioritize, summarize, or answer
"what should I do next?". Do not just dump the raw list; think about it.

```
gh issue list --label todo --assignee @me --state open
```

- If the user narrowed the request (e.g. `show #chat`), add `--label <tag>` or
  `--search "<terms>"`.
- For "what should I do next?", read the titles and creation order and recommend a
  next item with a one-line reason.

## Complete

Close the issue that matches what the user finished.

1. List candidates:

   ```
   gh issue list --label todo --assignee @me --state open
   ```

2. Match the user's text to the best single open todo by title.
3. If exactly one clearly matches, close it:

   ```
   gh issue close <number>
   ```

   Then confirm which issue (number + title) you closed.
4. If two or more plausibly match, or none do, ask the user which issue number to close
   rather than closing the wrong one.

## Out of scope

Don't edit issue bodies, reopen closed issues, set milestones/projects/due dates, or
target any repo other than the current one. Keep it to create / list / close.
