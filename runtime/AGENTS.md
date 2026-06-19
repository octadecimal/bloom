# runtime/ — the authoritative plane

This is **where games run** for real-money play. **No AI, ever.**

- Authoritative source of truth; the client can never override the server.
- No nondeterminism beyond the certified index draw.
- The **audit log is append-only**; every round must stay bit-reproducible — record
  `(package id + version, seed drawn, math-engine version, bet, timestamp, outcome)`.
- This is the **operator-integration edge**. Bloom does NOT own wallet, accounts, or
  KYC/AML — those belong to the operator platform.
