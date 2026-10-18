# Issue tracker: GitHub

Issues and specs for this repository live as GitHub issues. Use the `gh` CLI
from the repository root; it infers the repository from `git remote -v`.

## Conventions

- **Create**: `gh issue create --title "..." --body-file <file>`
- **Read**: `gh issue view <number> --comments`
- **List**: `gh issue list --state open --json number,title,body,labels,comments`
- **Comment**: `gh issue comment <number> --body-file <file>`
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

GitHub issues and pull requests share one number space. Resolve a bare `#42`
with `gh pr view 42` first, then fall back to `gh issue view 42`.

## Pull requests as a request surface

**PRs as a request surface: no.**

External pull requests are reviewed as code contributions, not as feature
requests in the issue triage queue.

## Skill operations

- **Fetch a ticket**: `gh issue view <number> --comments`.
- **Publish to the tracker**: create a GitHub issue with the drafted Markdown
  body.
