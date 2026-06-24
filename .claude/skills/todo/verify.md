# `/todo` skill — manual verification

The skill has no unit tests (it is an instruction file). Run this once after any change
to `SKILL.md`. Requires `gh` authenticated against the current repo's remote.

## Checklist

1. **Auth gate** — temporarily ensure you understand the failure path: with `gh`
   authenticated, `/todo ping test` should proceed. (If you ever hit an unauthenticated
   machine, `/todo` must stop and say "run `gh auth login`".)

2. **Add + label bootstrap** — in a repo whose `todo` label may not yet exist:

   ```
   /todo verify the todo skill end to end
   ```

   Expect: a `todo` label is created if absent, a new issue is opened with that label,
   assigned to you, and the skill reports the issue number + URL. Confirm in the GitHub
   Issues UI that the label and assignee are set.

3. **Query** —

   ```
   /todo what should I do next?
   ```

   Expect: the skill runs `gh issue list --label todo --assignee @me --state open` and
   reasons over the results (a recommendation with a short rationale), not a raw dump.

4. **Complete** —

   ```
   /todo done: verify the todo skill end to end
   ```

   Expect: the matching issue from step 2 is closed via `gh issue close`, and the skill
   confirms which number/title it closed.

5. **Ambiguous complete** — with two similarly-titled open todos, `/todo done: verify`
   should ask which issue number rather than closing one blindly.

## Cleanup

Close or delete any issues created during verification:

```
gh issue list --label todo --assignee @me --state open
gh issue close <number>
```
