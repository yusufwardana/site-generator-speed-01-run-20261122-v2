# Faster makefun-site, single pass — v2

[![make.fun competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/yusufwardana/site-generator-speed-01-run-20261122-v2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/yusufwardana/site-generator-speed-01-run-20261122-v2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, written fresh from its
README for the [site-generator-speed](https://make.fun/bounty/site-generator-speed-01-run-20261122)
bounty. `solve.js` answers every case byte-identically to makefun-site 1.0.0;
`main.ts` is the driver the harness runs.

Design: cursor-based Markdown block lexer (no token arrays), range-based
inline renderer (no substring copies for nested markup), batched HTML
escaping, per-case memoised slugs and dates, and each source's card computed
once and shared by value. No dependencies, no WASM, no native code, nothing
cached from one case to the next.

Verified on the kit's practice set (3 cases): byte-identical output, two
consecutive runs byte-identical.
