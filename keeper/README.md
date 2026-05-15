# Keeper Bot

Off-chain automation service for the Solana protocol. Built with Deno for easy deployment as a standalone binary.

## What is a Keeper?

A keeper bot is an off-chain service that monitors on-chain state and submits transactions when certain conditions are met. Common use cases:

- **Cranking**: Calling permissionless instructions on a schedule (e.g., updating oracle prices, settling expired positions)
- **Liquidation**: Monitoring under-collateralized positions and triggering liquidations
- **Arbitrage**: Detecting price discrepancies and executing trades
- **Indexing**: Watching on-chain events for off-chain dashboards

## Quick Start

```bash
# Development
cd keeper
deno task dev

# Start service
RPC_URL=https://api.devnet.solana.com deno task start

# Compile to standalone binary
deno task compile
./keeper-bot start
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RPC_URL` | Yes | — | Solana RPC endpoint |
| `WALLET_PATH` | No | `~/.config/solana/id.json` | Path to wallet JSON |
| `VERBOSE` | No | `false` | Enable verbose logging |

## Project Structure

```
keeper/
├── src/
│   ├── main.ts      # CLI entry point (argument parsing, command routing)
│   ├── config.ts     # Environment variable loading and validation
│   └── service.ts    # Main service loop (your keeper logic goes here)
├── deno.json         # Deno configuration and dependencies
└── README.md
```

## Implementing Your Keeper

1. **Define what to watch**: Edit `service.ts` to fetch the on-chain state you care about
2. **Define when to act**: Add conditions that trigger transactions
3. **Submit transactions**: Use the SDK's instruction builders to create and send transactions
4. **Handle errors**: Implement retry logic with exponential backoff for transient RPC errors

The keeper uses the SDK (`@solana-boilerplate/sdk`) for all on-chain interactions, ensuring consistency with the frontend and tests.
