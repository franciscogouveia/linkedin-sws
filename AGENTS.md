# Repository Guidelines

## Project Structure & Module Organization

This workspace currently contains no application source, tests, assets, or package manifests. The `.agents/`, `.codex/`, `.aws/`, and `.git/` directories are reserved metadata locations; do not place application code there.

When introducing the first implementation, group source under `src/`, tests under `tests/`, and supporting documentation under `docs/` where appropriate. Add assets only when needed. Update this guide with actual paths once the project structure is established.

## Build, Test, and Development Commands

No build system, development server, or test runner is configured. Commands such as `npm test` and `make build` are not currently available.

- `ls -la`: inspect the workspace, including hidden directories.
- `rg --files --hidden -g '!.git/**' -g '!.aws/**'`: list project files while excluding Git metadata and AWS configuration.

When adding tooling, document exact installation, local run, build, lint, and test commands alongside the relevant manifest. Prefer reproducible dependency installation and commit the applicable lockfile.

## Coding Style & Naming Conventions

No language-specific style or formatter is established. Use consistent indentation within each file, descriptive names, and small modules with clear responsibilities. Select a formatter and linter appropriate to the first implementation, and record their commands here. Avoid unrelated formatting changes.

## Testing Guidelines

No testing framework or coverage threshold exists yet. Add tests for new behavior and regression tests for bug fixes. Use descriptive test names that explain the scenario and expected result. Document the framework, test locations, and execution command when tests are introduced.

## Commit & Pull Request Guidelines

Git history is unavailable in this workspace, so existing commit conventions cannot be verified. Use concise, imperative commit subjects, such as `Add configuration validation`.

Pull requests should explain the problem, changes, and validation performed. Link relevant issues and include screenshots for visible UI changes. Explicitly identify any checks that could not run.

## Security & Configuration

Keep credentials, tokens, and local configuration out of version control. Provide configuration examples with placeholder values. Treat `.aws/` as sensitive metadata and avoid copying its contents into documentation or logs.
