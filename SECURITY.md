# Security Policy

## Reporting a vulnerability

Do not include tokens, credentials, private keys, personal data, or exploit details in a public issue.

For a public AgentTools repository, prefer GitHub's private vulnerability reporting / Security Advisory flow when it is enabled. If no private reporting channel is available, open a minimal issue stating that a security report is needed without including sensitive details.

## Secret handling

AgentTools treats credentials as runtime-local data.

- Keep tokens, API keys, cookies, private keys, Discord connection state, and service credentials out of tracked files.
- Use environment variables or the service-specific local secret store.
- `*.local.*`, `.env`, `.connect`, state, logs, databases, and common private-key/credential files are excluded from Git.
- Run `node agenttools-mcp-gateway/scripts/public-release-audit.js` before publishing.
- Public CI also scans Git history for common secret formats.

If a credential is committed accidentally, revoke/rotate it first. Removing it from the latest commit does not remove it from Git history.
