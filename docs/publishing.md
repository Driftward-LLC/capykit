# Publishing Capykit

Capykit publishes two distribution surfaces from the same verified build:

- `@driftward/capykit` on npm, with the `capykit` and `capykit-mcp` binary entries.
- Linux and macOS executable artifacts under `dist/standalone/`, with SHA-256 checksums.

## npm installation

Install from npm on a supported Node.js 22+ machine:

```bash
npm install --global @driftward/capykit
capykit --version
capykit --help
```

Uninstall with:

```bash
npm uninstall --global @driftward/capykit
```

Upgrade with:

```bash
npm install --global @driftward/capykit@latest
capykit --version
```

The package is configured for public npm provenance with `publishConfig.provenance`.
Release automation must publish with `npm publish --provenance` from GitHub Actions
or another npm-supported trusted publisher.

## Standalone artifacts

Build the package and generate release artifacts locally:

```bash
npm run build
npm run build:standalone
```

The standalone build writes:

- `dist/standalone/capykit-linux-x64`
- `dist/standalone/capykit-linux-arm64`
- `dist/standalone/capykit-darwin-x64`
- `dist/standalone/capykit-darwin-arm64`
- `dist/standalone/SHA256SUMS`
- `dist/standalone/checksums.json`

Each artifact is executable and supports the same CLI commands as the npm binary:

```bash
./dist/standalone/capykit-linux-x64 --version
./dist/standalone/capykit-linux-x64 --help
```

Verify checksums before installing a downloaded artifact:

```bash
cd dist/standalone
sha256sum --check SHA256SUMS
```

Install by copying the platform artifact to a directory on `PATH`:

```bash
install -m 0755 dist/standalone/capykit-linux-x64 /usr/local/bin/capykit
```

Uninstall by removing that copied executable:

```bash
rm /usr/local/bin/capykit
```

Upgrade by downloading the newer artifact, verifying `SHA256SUMS`, and replacing
the installed executable atomically.

## Shell completions

Generate shell completion snippets from the CLI:

```bash
capykit completion bash > /etc/bash_completion.d/capykit
capykit completion zsh > /usr/local/share/zsh/site-functions/_capykit
capykit completion fish > ~/.config/fish/completions/capykit.fish
```

Completion output is deterministic and covers the public command surface.
