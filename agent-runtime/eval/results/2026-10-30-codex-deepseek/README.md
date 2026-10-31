# Baseline: Codex + DeepSeek

- Date: 2026-10-30
- Runtime: codex app-server 0.165.0
- Model: deepseek-flash (Responses API)
- Tasks: 10 (eval/tasks.json)
- Result: 9/10 passed (90.0%)
- Avg steps: 6.9; avg duration: 41.4s; avg first token: 2.7s
- Approvals: 2; tool errors: 22
- Failure: add-test check passed but the turn timed out after 180s (model stalled after a successful apply_patch).

Reproduction:

```powershell
node dist/cli/index.js eval --tasks eval/tasks.json --out-dir .probe/eval-results/run-1 `
  --runtime codex --provider deepseek --model deepseek-flash `
  --base-url https://api.deepseek.com --api-key-env DEEPSEEK_API_KEY --env-file .env `
  --home .probe/codex-home --command "<path-to-codex.exe>" `
  --approval allow --approval-policy on-request --permissions :workspace `
  --max-steps 30 --turn-timeout-ms 180000
```
