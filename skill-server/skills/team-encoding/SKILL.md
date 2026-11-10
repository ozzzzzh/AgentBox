# Team Encoding

MARKER_TEAM_ENCODING

## Naming

- TypeScript: `camelCase` for values, `PascalCase` for types, `UPPER_SNAKE_CASE` for constants.
- SQL: `snake_case`; do not abbreviate business terms.
- Python: `snake_case`; modules must not shadow standard library names.

## Errors

- Never swallow an error without a log or a typed rethrow.
- Public APIs return typed errors; do not expose raw provider errors.
- Add a regression test for every bug fix.

## Files

- One responsibility per file; keep entrypoints thin.
- Do not commit generated files, local dumps, or browser profiles.
