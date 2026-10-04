# Security

Please report vulnerabilities privately to **support@aiprimetech.io**, not in a public issue.
Include what you found and how to reproduce it. You'll get a reply within a few days.

Meetingly keeps its provider keys on the server only: the desktop app ships with no API keys, and logs
redact tokens automatically. If you use your own API key, it is stored on your computer, encrypted with the
operating system's keychain (DPAPI, macOS Keychain, libsecret), and sent only to the endpoint you chose.
