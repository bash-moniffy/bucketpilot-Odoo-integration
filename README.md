# BucketPilot for Odoo 18

BucketPilot lets you back up files from the Odoo filestore to a BucketPilot storage bucket from inside Odoo. Connect your workspace, choose the source files and destination, and run the backup immediately or on a schedule. Follow execution progress and file-level results in Odoo.

Odoo **18.0** · Add-on source version **18.0.2.1.1**

## What it does

- Browse storage buckets from a connected BucketPilot workspace.
- Browse and search the Odoo filestore, expand folders, and include or exclude individual files or entire folders.
- Run a backup immediately, schedule it once, or repeat it daily, weekly, or monthly.
- Follow progress, see confirmed uploads and review previous runs in **Backup History**.
- Restore an individual file or an entire backup to the original filestore paths from **Backup History**. Review the reason, progress, and file results in **Restore History**.
- Receive optional branded completion reports through Odoo's outgoing email service.

The default backup covers attachments Odoo stores on disk. Database records and attachments stored in PostgreSQL require a separate database backup.

## Requirements

- A self-hosted Odoo 18 installation that accepts custom Python add-ons.
- The Python packages `Jinja2` and `requests`. The Odoo service does not need Git to run backups.
- A BucketPilot workspace with a connected bucket and API access. A read-only key can browse buckets; use a read/write key for backups.
- Read access to the Odoo filestore or an approved custom source, writable persistent Odoo data storage, and outbound HTTPS to BucketPilot and your storage provider.

## Install and run

The module source is at the repository root. For an installation from Git, make the checkout directory `bucketpilot` so Odoo discovers the expected technical module name:

```sh
git clone git@github.com:bash-moniffy/bucketpilot-Odoo-integration.git /path/to/custom-addons/bucketpilot
```

Use the parent `/path/to/custom-addons` in Odoo's `addons_path`.

1. Clone this repository into a directory named `bucketpilot` inside your Odoo add-ons path, then restart Odoo.
2. Enable developer mode, choose **Apps → Update Apps List**, then find **BucketPilot** and click **Activate**.
3. Open **BucketPilot → Connection** and validate your API key.
4. Open **Backups** to select files, choose a destination and review the backup before saving.

The explorer opens `<data_dir>/filestore` and gives Odoo Settings administrators access to their database's folder by default. The server administrator can set `BUCKETPILOT_FILESTORE_ADMIN_DB` to authorize one trusted database to browse and back up the whole filestore. Set `BUCKETPILOT_PROJECT_ROOT` only to use a different approved source directory.

Files selected individually in the filestore go directly into the dated destination. A folder selection keeps its internal paths. After upgrading from project-file backups, review and save each existing schedule with a new file selection.

An Odoo Settings administrator can restore confirmed filestore files to the original paths for the currently configured filestore. The worker downloads the recorded object keys, recreates missing folders as needed, and skips existing files. Use **Restore History** to track what was restored, skipped, missing or failed.

[English installation guide](INSTALLATION.en.md) · [دليل التثبيت بالعربية](INSTALLATION.ar.md)

## License

[GNU General Public License](LICENSE.txt)
