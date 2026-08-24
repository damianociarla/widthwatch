# Security policy

Report vulnerabilities privately through GitHub Security Advisories. Do not test the hosted demo against targets you do not own or have authorization to assess.

## Hosted scanner threat model

- Only credential-free HTTP(S) URLs on ports 80 and 443 are admitted.
- Loopback, link-local, private, reserved, metadata and non-public DNS answers are rejected.
- Every Chromium connection goes through a loopback proxy that resolves, validates and pins a public IP before connecting; HTTPS CONNECT is restricted to port 443 and protocol upgrades are rejected.
- Chromium service workers are disabled. Media is blocked and requests, elements, widths, navigation time, queue depth and concurrent browsers are bounded.
- The container runs as a non-root user and receives no AWS application role.
- The hosted API does not accept cookies, headers, scripts, file URLs, uploads, authentication state, or private pages.
- Results live only in process memory for 30 minutes. App Runner restarts can discard them.

CloudFront/WAF absorbs common and volumetric request abuse, but no cloud bill can be described as mathematically impossible. The compute hard cap, global application quota, AWS Budget alerts, CloudWatch alarms and a documented kill switch are all required before enabling the public endpoint.

