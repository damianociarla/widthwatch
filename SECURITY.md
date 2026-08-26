# Security policy

Report vulnerabilities privately through GitHub Security Advisories. Do not test the hosted demo against targets you do not own or have authorization to assess.

## Hosted scanner threat model

- Only credential-free HTTP(S) URLs on ports 80 and 443 are admitted.
- Loopback, link-local, private, reserved, metadata and non-public DNS answers are rejected.
- Every Chromium connection goes through a loopback proxy that resolves, validates and pins a public IP before connecting; HTTPS CONNECT is restricted to port 443 and protocol upgrades are rejected.
- Chromium service workers are disabled. Media is blocked and requests, transferred bytes, elements, widths, navigation time, queue depth and concurrent browsers are bounded. Each job gets a fresh 10 MiB response / 25 MiB tunnel / 75 MiB total allowance; exhaustion closes its sockets and browser.
- The container runs as a non-root user. Its optional AWS runtime role can only read and write the private `reports/` bucket prefix.
- The hosted API does not accept cookies, headers, scripts, file URLs, uploads, authentication state, or private pages.
- Job state lives in process memory for 30 minutes. Completed standalone reports can also live in the private encrypted report bucket with a seven-day lifecycle. The bucket is private, but the application report URL is a bearer link: anyone who has it can read screenshots and page content until expiry. Do not scan sensitive pages.

CloudFront/WAF absorbs common and volumetric request abuse, but no cloud bill can be described as mathematically impossible. The compute hard cap, global application quota, mandatory AWS Budget email, regional SNS topics and CloudWatch alarms are versioned in CloudFormation. An independent, fail-closed WAF scanner control plane can block only new scan submissions while health, status and report reads remain available; ordinary releases cannot change its state. Emergency disable does not read application or alerting secrets. The scheduled canary uses a separate read-only AWS role and escalates continuing failures through one operational issue. Follow the tested [public scanner incident runbook](docs/runbooks/public-scanner.md). Enable is refused while either operational email subscription is absent or `PendingConfirmation`.

GitHub Actions are restricted to selected publishers and full commit SHAs, with Dependabot maintaining verified updates. Repository rules require pull requests and CI on `main`, prevent release-tag mutation, and restrict deployment environments to the intended refs. See the [GitHub supply-chain runbook](docs/runbooks/github-supply-chain.md).
