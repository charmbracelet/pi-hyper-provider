# AGENTS.md

Pi package integrating Charm's Hyper inference provider with the rest of Pi.

- Use imperative, scoped commit messages, not Conventional Commits, like:
  `system a: system b: do a shared thing`.
- Do not commit without explicit user instruction to.
- Never open PRs yourself. You may only provide commands to do so and let the
  user open PRs themselves.
- Prefer to rely on Pi's packages and public API as much as feasible. It
  provides _most_ functionality we'll need, so before implementing anything
  yourself, peruse `./node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
  and `./node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`.
	- @earendil-works/pi-coding-agent: Interactive coding agent CLI
	- @earendil-works/pi-agent-core: Agent runtime with tool calling and state
	  management
	- @earendil-works/pi-ai: Unified multi-provider LLM API (OpenAI, Anthropic,
	  Google, …)

## Commands

Use `mise` to automatically apply the configured Node version and task wrappers.

```sh
mise run fmt # format all files with Biome; run often
mise run lint # lint all files with Biome; run often
mise run typecheck # check types with tsc; run often
mise run check # biome check --write, then typecheck sequentially; run before committing/ending your turn
mise run lint ::: typecheck # lint and typecheck in parallel
```

Release tasks are custom and run `mise run check` internally:

```sh
mise run release:bump -- <patch|minor|major|prepatch|preminor|premajor|prerelease|x.y.z>
mise run release:pack
mise run release:publish -- --tag <tag> [--otp <otp>]
```

## Gotchas

- There is no test script in this package right now; validate with the narrowest
  relevant command above, then `mise run check` when feasible.
- Do not bypass `mise` with raw `npm` unless strictly necessary; mise tasks may
  do additional work.
