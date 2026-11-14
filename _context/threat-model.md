# Threat model

<!--
Threat model (ADR 0014, module threat_model). `controls.py validate` reads this file.

Format:
- One `## TB-<n> <name>` heading for each trust boundary: a place where data or a
  request crosses from one level of trust to another, for example browser to API,
  API to payment provider, or CI to the cloud account.
- Under it, one `### TM-<n> <name>` heading for each threat at that boundary, with
  two lines:
  - `- STRIDE: <one or more of Spoofing, Tampering, Repudiation, Information
    disclosure, Denial of service, Elevation of privilege>`
  - `- Controls: <the CTRL-… IDs from _context/controls/controls.toml that answer
    it, or none>`
  Add more lines, such as `- Notes:`, when they help.
- IDs are unique. Never reuse a removed ID.
- The Risk map can name boundary paths in `[[boundary]]` tables with these TB IDs.
  A change to such a path needs a change to this file.

Example (synthetic):

## TB-1 Browser to API

The client app calls the API over HTTPS with a session cookie.

### TM-1 Stolen session cookie
- STRIDE: Spoofing
- Controls: CTRL-AUTH-01

## TB-2 API to payment provider

The API sends payment instructions and receives signed webhooks.

### TM-2 Forged or replayed webhook
- STRIDE: Spoofing, Tampering
- Controls: CTRL-PAY-04

### TM-3 Release without the buyer's approval
- STRIDE: Elevation of privilege
- Controls: CTRL-PAY-03
-->
