# Changelog

All notable changes to this integration are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/), bumped by the Release workflow.

## [Unreleased]

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

[Unreleased]: https://github.com/prohand/gladys-proxmox/compare/v2.2.0...HEAD
[2.2.0]: https://github.com/prohand/gladys-proxmox/compare/v2.1.1...v2.2.0
[2.1.1]: https://github.com/prohand/gladys-proxmox/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/prohand/gladys-proxmox/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/prohand/gladys-proxmox/compare/v1.0.3...v2.0.0
[1.0.3]: https://github.com/prohand/gladys-proxmox/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/prohand/gladys-proxmox/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/prohand/gladys-proxmox/releases/tag/v1.0.1
