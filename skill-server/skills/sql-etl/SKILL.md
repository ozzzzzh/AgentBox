# SQL ETL Review

MARKER_SQL_ETL

When reviewing an ETL SQL change:

1. Identify the incremental key and watermark.
2. Check idempotency: rerunning the same batch must not duplicate rows.
3. Check delete/update semantics and late-arriving data.
4. Verify indexes and partition pruning for the expected data volume.
5. Provide a rollback or backfill plan.
6. Run the smallest representative query and report row counts.
