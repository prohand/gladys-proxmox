# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

### Fixed

- The backups widget reads the last backup of each node only, no longer the disks (one smartctl run per disk) it does not show, and a pull repeated while a node is still being read joins that read instead of starting another one.
- Deleting a device whose last read failed no longer leaves the connection status red until the next reconnection.
- A Proxmox host that sends its answer a few bytes at a time no longer hangs the refresh: every request is now bounded to 30 s in total, on top of the 15 s of silence already allowed.
- No more `DEP0123` deprecation warning in the logs when the Proxmox host is given as an IP address.
- One round of the refresh loop reads the guest list once, even when the nodes polled in the same round take a while.

### Changed

- Node 22 or later is required to run the integration outside its Docker image (the image already ships Node 24).

## [2.3.0] - 2026-10-07

### Added

- A GitHub Release is published for every version, so the version link of the Supervision page leads somewhere.

### Fixed

- The connection status follows the reads: a Proxmox that answered only after Gladys started stayed red for good, and one that went down later stayed green.
- A widget pull answers within 9 s: past that the card says it is loading while the read completes, instead of the core giving up at 15 s and leaving the card dead until the dashboard is reloaded.

## [2.2.0] - 2026-10-06

### Added

- `SECURITY.md`: how to report a vulnerability.
- `CHANGELOG.md`, rebuilt from the release history.

### Changed

- Development dependencies updated to their latest versions (ESLint 10.12, Prettier 3.9.9, globals 17.13).

### Fixed

- Nodes and guests are read on schedule again: devices are published with `should_poll: true`, without which Gladys never polls them, and an integration-owned loop reads the devices created before that flag. Backups, SMART, disk temperatures, guest states and the scene triggers they feed were only updated when a device was created or a widget opened.

## [2.1.1] - 2026-09-29

### Changed

- Show a failed action in red, not green (#13)

## [2.1.0] - 2026-09-24

### Changed

- Backups widget: one card per node (name, date, colored badge)

## [2.0.0] - 2026-09-23

### Added

- Add dashboard widgets, scene triggers and scene actions (Gladys 5.1)

### Changed

- Give the SMART status its own scene action

## [1.0.3] - 2026-08-20

### Removed

- Drop the time zone from "Last backup", and report the disks

## [1.0.2] - 2026-08-19

### Changed

- Refresh the "Backups and display" settings wording

## [1.0.1] - 2026-08-19

First public release.

### Added

- Proxmox VE failed-task monitoring integration
- Report backups and VM/LXC status instead of failed tasks
- Add support for a second Proxmox server

### Changed

- Accept a pasted URL as the host, and name what a network error really is
- Simpler Proxmox-themed cover image
- Read a device as soon as the user adds it

### Fixed

- Shorten the store description and go back to 1.0.0
- Publish a poll frequency Gladys accepts, and hold the real interval
- Declare min/max on every feature, and report statuses as text

[Unreleased]: https://github.com/prohand/gladys-proxmox/compare/v2.3.0...HEAD
[2.3.0]: https://github.com/prohand/gladys-proxmox/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/prohand/gladys-proxmox/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/prohand/gladys-proxmox/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/prohand/gladys-proxmox/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/prohand/gladys-proxmox/compare/v1.0.3...v2.0.0
[1.0.3]: https://github.com/prohand/gladys-proxmox/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-proxmox/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-proxmox/releases/tag/v1.0.1
