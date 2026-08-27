# Security

## Security model

- The upstream Harness URL must be an HTTP loopback address (`127.0.0.1`, `localhost` or `::1`).
- The bridge listens on a random loopback port and is exposed through an HTTPS Cloudflare Quick Tunnel.
- Pairing links expire after five minutes and contain a 256-bit secret in the URL fragment.
- A device is usable only after the six-digit code is checked and approved on the computer.
- Android generates an EC P-256 device key in Android Keystore. The private key is not exported.
- Sessions use an HttpOnly, Secure, SameSite=Strict cookie and expire after one hour.
- Revoking a device closes its active sessions and WebSocket connections.

Quick Tunnels are convenient but are not a substitute for an enterprise access policy or an availability SLA. Only enable remote access on a computer you control, keep the desktop and Android WebView updated, and revoke devices you no longer use.

## Reporting a vulnerability

Please open a GitHub security advisory instead of publishing credentials, pairing links, device records or exploit details in a public issue.
