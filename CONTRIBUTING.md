# Contributing to ClawNexus

Thank you for your interest in contributing to ClawNexus! This guide will help you get started.

## Development Environment

### Prerequisites

- **Node.js** >= 22
- **pnpm** (latest)
- A running [OpenClaw](https://github.com/openclaw/openclaw) instance (for integration testing)

### Setup

```bash
git clone https://github.com/SilverstreamsAI/ClawNexus.git
cd ClawNexus
pnpm install
pnpm build
```

### Project Structure

ClawNexus is a pnpm monorepo with three packages:

- `packages/daemon` — The main daemon + CLI (`clawnexus`)
- `packages/skill` — OpenClaw Skill package (`clawnexus-skill`)
- `packages/sdk` — Client SDK (`@clawnexus/sdk`)

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter clawnexus test
pnpm --filter @clawnexus/sdk test
```

### Building

```bash
# Build all packages
pnpm build

# Build a specific package
pnpm --filter clawnexus build
```

## Code Style

- **TypeScript** with strict mode enabled
- All user-facing content (comments, docs, CLI output, error messages) must be in **English**
- Keep code simple and avoid over-engineering
- No TODO/FIXME/HACK comments in committed code

## Submitting Changes

### Pull Requests

1. Fork the repository and create a feature branch from `main`
2. Make your changes, ensuring all tests pass (`pnpm test`)
3. Ensure the project builds successfully (`pnpm build`)
4. Write clear, concise commit messages
5. Open a pull request against `main`

### Commit Messages

Follow conventional commit format:

```
type(scope): short description

Optional longer description
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`

### What Makes a Good PR

- Focused on a single change
- Includes tests for new functionality
- Updates documentation if needed
- Passes all existing tests

## Reporting Issues

- Use [GitHub Issues](https://github.com/SilverstreamsAI/ClawNexus/issues) to report bugs or request features
- Include steps to reproduce for bug reports
- Specify your OS, Node.js version, and ClawNexus version

## License

By contributing to ClawNexus, you agree that your contributions will be licensed under the [MIT License](LICENSE).
