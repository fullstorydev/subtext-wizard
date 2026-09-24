---
'@subtextdev/subtext-wizard': minor
---

Read real usage out of Claude Code's `stream-json` result event instead of asking the model to estimate it. The wizard now records the run's actual token count and, via the result `subtype`, tells a finished run apart from one that hit the turn limit or died mid-execution (both of which still exit 0). Every `complete` event carries `token_source` (`harness` / `agent` / `none`) so counts are never compared across harnesses that measure and harnesses that guess. Terminal runs also print a line of run economics (tokens, cost, turns, duration).
