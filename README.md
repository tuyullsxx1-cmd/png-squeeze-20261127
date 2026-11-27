[![Squeeze screenshots into the smallest PNG, 27 November 2026](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/tuyullsxx1-cmd/png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/tuyullsxx1-cmd/png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

# png-squeeze

One Node 22 program (`main.ts`, built-ins only) that rewrites each 1280×720
screenshot as the smallest lossless PNG it can: it decodes the stored RGBA
input, picks the cheapest exact form for it (palette with ≤256 colours,
grey, grey+alpha, RGB, RGBA, or a single transparent colour keyed through
tRNS), chooses each row's filter (fixed, minimum-sum, fewest-pairs, or
brute-force-by-zlib), and re-compresses the winner at zlib level 9.

Fully deterministic: no clock, no randomness, no network.

## Practice set (kit)

| instance | theme | bytes | scale | points |
|----------|-------|-------|-------|--------|
| i001 | flat | 12,496 | 13,547 | 718.4 |
| i002 | rich | 51,852 | 55,063 | 705.5 |
| i003 | alpha | 106,644 | 107,892 | 674.4 |
| i004 | grey | 105,605 | 110,521 | 696.3 |
| i005 | flat | 16,552 | 18,669 | 742.3 |
| i006 | rich | 178,840 | 185,295 | 689.9 |
| i007 | alpha | 60,890 | 64,285 | 701.9 |
| i008 | grey | 24,897 | 26,807 | 714.2 |

**Score 705,347** (mean 705.3 points per instance), every instance below the
scale size. House baseline fixed-paeth scores 420,399 on the same set.
Runtime ~21 s for the whole set of 8 (limit 60 s), two runs byte-identical.
