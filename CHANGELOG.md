# Changelog

## 18.0.2.1.1

- Review individual-file and all-file restores in a dialog and record the reason before queuing.
- Show live restore stages and transfer progress, with a searchable restore history.
- Align Restore History with Backup History and show pending and running schedules first by default.

## 18.0.2.1.0

- Restore a confirmed file, source folder, or finished backup to its original filestore paths without overwriting local files.
- Show the exact object key in Backup History and track background restore progress and file outcomes in Restore History.

## 18.0.2.0.0

- Discover the Odoo filestore root automatically and browse folders and files from that level.
- Upload individually selected filestore files by filename without their parent directories.
- Upload files from a single filestore folder directly under the backup destination, preserving its internal paths.
- Support an optional administrator-configured source directory without a Git dependency.
- Allow a server-designated database's Odoo Settings administrators to back up the full filestore. Other databases have access to their own folder.
- Require source reselection for existing plans before running them against the new source.

## 18.0.1.0.0

First public release of BucketPilot for Odoo 18.

- Connect a BucketPilot workspace and browse its storage buckets inside Odoo.
- Build file backups with Git ignore rules, source selections and protected paths.
- Run backups on demand or on a schedule, and monitor execution and file checkpoints.
- Detect the source root in standard installations and allow an explicit path for custom layouts.
- Send optional HTML completion reports through Odoo's outgoing mail configuration.
- Include short Arabic and English installation guides.

The earlier builds using `18.0.1.1.0` and `18.0.1.1.1` were development snapshots.
