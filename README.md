# BucketPilot for Odoo 18

BucketPilot lets you back up selected project files to a BucketPilot storage bucket from inside Odoo. Connect your workspace, choose the source files and destination, and run the backup immediately or on a schedule. Follow execution progress and file-level results in Odoo.

**Release 1.0.0** · Odoo **18.0** · Add-on version **18.0.1.0.0**

## What it does

- Browse storage buckets from a connected BucketPilot workspace.
- Select project files and folders with Git ignore rules and explicit include or exclude choices.
- Run a backup immediately, schedule it once, or repeat it daily, weekly, or monthly.
- Follow progress, see confirmed uploads and review previous runs in **Backup History**.
- Receive optional branded completion reports through Odoo's outgoing email service.

The add-on covers **project files**. Use your usual Odoo procedures for database, filestore and restore operations.

## Requirements

- A self-hosted Odoo 18 installation that accepts custom Python add-ons.
- Git available to the Odoo service, plus the Python packages `Jinja2` and `requests`.
- A BucketPilot workspace with a connected bucket and API access. A read-only key can browse buckets; use a read/write key for backups.
- Read access to the approved project source folder, writable persistent Odoo data storage, and outbound HTTPS to BucketPilot and your storage provider.

## Install and run

1. Put the `bucketpilot/` folder in a configured Odoo add-ons directory and restart Odoo.
2. Enable developer mode, choose **Apps → Update Apps List**, then find **BucketPilot** and click **Activate**.
3. Open **BucketPilot → Connection** and validate your API key.
4. Open **Backups** to select files, choose a destination and review the backup before saving.

BucketPilot detects the source root in standard project layouts. Use `BUCKETPILOT_PROJECT_ROOT` to select a different directory or configure a custom deployment. The installation guides explain this setting and the optional API key storage and email configuration.

[English installation guide](bucketpilot/INSTALLATION.en.md) · [دليل التثبيت بالعربية](bucketpilot/INSTALLATION.ar.md)

## License

[GNU General Public License](bucketpilot/LICENSE.txt)
