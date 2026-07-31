# @charmland/pi-hyper-provider

[![npm version](https://img.shields.io/npm/v/@charmland/pi-hyper-provider.svg)](https://www.npmjs.com/package/@charmland/pi-hyper-provider)

A [Pi] extension that registers Charm's [Hyper] inference provider with Pi,
supporting API keys or OAuth, dynamic model discovery, and optionally showing
your team name and Hypercredit balance in the status line.

[Pi]: https://pi.dev
[Hyper]: https://hyper.charm.land

```sh
# via NPM
pi install npm:@charmland/pi-hyper-provider

# via git
pi install git:github.com/charmbracelet/pi-hyper-provider
```

> [!IMPORTANT]
> As of v83, Pi only creates and updates provider extensions' model caches when
> launched interactively. If you mostly use Pi in headless or non-interactive
> environments, open the TUI whenever you want to get new models or updated
> metadata.

## Usage

- To authenticate with OAuth, open `pi`, send `/login`, pick `Subscription`, and select the
  `Charm Hyper` provider.
- To authenticate with an API key, set the `HYPER_API_KEY` environment variable
  then open `pi`.

Pick a Hyper model by sending `/model` and filtering by either provider name
`hyper` or `model-name` like `glm-5.1`.

After Hyper credentials are configured, Pi discovers available models and
persists the latest successful catalog in its standard model store. A previously
discovered catalog remains available when a later refresh fails. By default,
your remaining Hypercredit balance is shown in the status line while a Hyper
model is active.

Use `/hyper-status` to configure the status line interactively and toggle things
on/off or reset to the defaults. `teamName` defaults to `false` and
`hypercredits` defaults to `true`. You can also set values directly:

```sh
/hyper-status teamName true
/hyper-status hypercredits false
/hyper-status reset
```

## Contributing

See the [contributing guide](https://github.com/charmbracelet/pi-hyper-provider?tab=contributing-ov-file#contributing).

## Releasing

1. `mise run release:bump <patch|minor|major|prepatch|preminor|premajor|prerelease>`
   to increment the version
2. `mise run release:pack` to dry-run build the release tarball
3. `mise run release:publish` to publish

## Whatcha think?

We’d love to hear your thoughts on this project. Need help? We gotchu. You can
find us on:

- [Twitter](https://twitter.com/charmcli)
- [Slack][slack]
- [Discord][discord]
- [The Fediverse](https://mastodon.social/@charmcli)
- [Bluesky](https://bsky.app/profile/charm.land)

[slack]: https://charm.land/slack
[discord]: https://charm.land/discord

## License

[MIT](https://github.com/charmbracelet/pi-hyper-provider/raw/main/LICENSE)

---

Part of [Charm](https://charm.land).

<a href="https://charm.land/"><img alt="The Charm logo" width="400" src="https://stuff.charm.sh/charm-banner-softy.jpg" /></a>
