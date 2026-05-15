# Solana AI Boilerplate

A production-ready Solana project template designed for **AI-assisted development** with Claude Code.

## Features

- **Monorepo structure**: On-chain program, TypeScript SDK, Next.js frontend, Deno keeper bot
- **AI-optimized CLAUDE.md**: Comprehensive AI context file with development guides, patterns, and rules
- **Battle-tested WAD math**: Fixed-point arithmetic library with u256 overflow protection
- **Network-aware builds**: Mainnet/devnet/localnet build scripts with feature flags
- **Test infrastructure**: Jest setup with structured JSON output and PDA collision prevention
- **Instruction handler pattern**: 3-phase pattern (validate → CPI → state update) with detailed guides

## Prerequisites

| Tool | Version | Docs |
|------|---------|------|
| Rust | latest stable | [rustup.rs](https://rustup.rs) |
| Solana CLI | ≥ 1.18 | [Installation guide](https://solana.com/docs/intro/installation) |
| Anchor | **0.32.1** | [Installation guide](https://www.anchor-lang.com/docs/installation) |
| Node.js | **24.14.0** (≥ 24.0.0) | [nodejs.org](https://nodejs.org) |
| pnpm | ≥ 9.0.0 | [pnpm.io/installation](https://pnpm.io/installation) |

> **Note:** Anchor 0.32.x requires a specific Solana CLI version. Run `anchor --version` and `solana --version` after install to confirm compatibility.

## Quick Start

```bash
# Build the program
anchor build

# Install dependencies
pnpm install

# Run tests
pnpm test

# Build SDK
pnpm sdk:build

# Start keeper (Deno)
pnpm keeper:dev
```

## Project Structure

```
├── programs/protocol/    # On-chain Anchor program (Rust)
│   └── src/
│       ├── lib.rs            # Entry points
│       ├── instructions/     # One file per instruction
│       ├── state/            # Account structures
│       ├── math/             # Business logic + WAD library
│       ├── constants.rs      # PDA seeds, protocol params
│       └── error.rs          # Error codes
├── sdk/                  # TypeScript SDK
├── app/                  # Next.js frontend
├── keeper/               # Deno off-chain automation
├── tests/                # Integration tests
├── scripts/              # Build & deploy scripts
├── docs/                 # Architecture & specification
└── CLAUDE.md             # AI agent context (read this first!)
```

## Working with AI

This boilerplate is designed for AI-assisted development. The key files:

1. **`CLAUDE.md`** — AI reads this automatically every session. Contains project rules, patterns, and architecture.
2. **`docs/SPECIFICATION.md`** — Define your instructions here before asking AI to implement them.
3. **`docs/ARCHITECTURE.md`** — Document account model and PDA seeds.

### Recommended workflow:

1. Write the spec in `docs/SPECIFICATION.md`
2. Update `CLAUDE.md` with architecture decisions
3. Ask AI to implement one instruction at a time
4. Run tests, feed results back to AI
5. Repeat

See `CLAUDE.md` for detailed AI collaboration patterns.

### Prompt Cheatsheet

A one-page reference for writing effective AI prompts, SPECIFICATION.md checklists, and debugging templates:

**[Prompt Cheatsheet (Gist)](https://gist.github.com/nulLeeKH/48137abfef05ab15d1482a8a2820c85a)**

## Build for Different Networks

```bash
./scripts/build.sh mainnet    # Production build
./scripts/build.sh devnet     # Devnet features enabled
./scripts/build.sh localnet   # Local development
```

## Related Tools

| Tool | Description |
|------|-------------|
| [Helius MCP Server](https://github.com/helius-labs/mcp-server-helius) | 60+ Solana APIs integrated directly into Claude Code via MCP |
| [Solana Fender](https://github.com/nicola-attico/solana-fender) | Static analysis tool for Anchor programs — catches common vulnerabilities |
| [SendAI Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) | 60+ pre-built Solana actions for SDK and bot development |
| [Código AI](https://www.codigo.ai/) | Generate Anchor boilerplate from CIDL (Código Interface Description Language) |

## License

MIT
