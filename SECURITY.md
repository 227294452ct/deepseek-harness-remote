# Security

## Security model

- The upstream Harness URL must be an HTTP loopback address (`127.0.0.1`, `localhost` or `::1`).
- The bridge listens on a random loopback port and is exposed through an HTTPS Cloudflare Quick Tunnel.
- Pairing links expire after five minutes and contain a 256-bit secret in the URL fragment.
- A device is usable only after the six-digit code is checked and approved on the computer.
- Android generates an EC P-256 device key in Android Keystore. The private key is not exported.
- Sessions use an HttpOnly, Secure, SameSite=Strict cookie and expire after one hour.
- Revoking a device closes its active sessions and WebSocket connections.
- Drive enumeration and desktop capability endpoints require the same authenticated device session as the proxied Harness UI.
- The desktop WebSocket additionally enforces an exact trusted `Origin`, a 4 KiB message limit, input allowlists, coordinate bounds and a message-rate limit.
- Desktop input is executed by a bundled PowerShell helper that has no listening port, accepts only bounded JSON commands on stdin, and uses a fixed `SendInput` P/Invoke implementation. It never evaluates received strings.
- Only one viewer receives the control lease. Disconnect, heartbeat timeout, device revocation, lock screen, gateway shutdown and helper failure all revoke the lease and release held input.
- Desktop capture stops when there are no viewers, drops frames for slow clients instead of queueing them, and is unavailable on the Windows secure desktop.

Quick Tunnels are convenient but are not a substitute for an enterprise access policy or an availability SLA. Only enable remote access on a computer you control, keep the desktop and Android WebView updated, and revoke devices you no longer use.

## Reporting a vulnerability

Please open a GitHub security advisory instead of publishing credentials, pairing links, device records or exploit details in a public issue.
