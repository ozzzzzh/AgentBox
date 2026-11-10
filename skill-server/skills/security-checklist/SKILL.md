# Security Checklist

MARKER_SECURITY_CHECKLIST

- No secrets in source, logs, screenshots, or test fixtures.
- Validate authorization at the server boundary, not only in the UI.
- Default to no network egress; allowlist destinations explicitly.
- Redact tokens and personal data from errors and audit logs.
- Deny writes outside the workspace unless explicitly approved.
