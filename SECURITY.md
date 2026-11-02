# Security Policy

## Reporting a vulnerability

Please do not disclose wallet-safety vulnerabilities in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use:

`https://github.com/Barrypto/cardano-shared-wallet-cli/security/advisories/new`

If that page is unavailable, open a public issue titled `Security contact
request` without vulnerability details or wallet data, and ask the maintainer
to provide a private reporting channel.

Include the affected command, expected behavior, actual behavior, and a minimal
reproduction that contains no seed phrase, private key, API credential, signed
transaction, or real wallet descriptor.

## Security boundary

This project never needs a seed phrase or private key and does not broadcast
transactions. It constructs native-script transactions from public wallet
descriptors, optionally verifies chain-critical data against Koios and
Blockfrost, and verifies signed CBOR locally before the user submits it with an
external wallet.

Users remain responsible for validating the transaction in their signing
wallet and testing the complete workflow on Cardano Preprod before using
Mainnet funds.
