# Security

DemoMotion controls a real browser and may record sensitive information.

- Never record passwords, API keys, session secrets, payment data, or private customer data.
- Values passed through `browser_fill` are redacted from `capture.json`; they can still be visible in the recorded UI.
- Run the MCP server only for trusted local MCP clients.
- Treat target websites as untrusted input.
- Prefer dedicated demo accounts and seeded demo data.
- Review the final capture before publishing.

Report vulnerabilities privately to the repository maintainer rather than filing a public issue with exploit details.
