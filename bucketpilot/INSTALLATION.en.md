# Install BucketPilot on Odoo 18

**English** · [العربية](INSTALLATION.ar.md)

## Before you install

- Use an Odoo 18 server that supports custom Python apps, such as self-hosted Community or Enterprise.
- Have a BucketPilot workspace, a connected bucket and an API key. Use a read/write key to create backups.
- The Odoo server needs the Python packages `Jinja2` and `requests`.

## 1. Add the app to Odoo

1. Ask your server administrator to put the `bucketpilot` app folder in a configured Odoo add-ons directory and restart Odoo. The folder should contain `__manifest__.py` directly.
2. Use an Odoo Settings administrator account to back up the filestore. The Odoo service needs read access to its filestore and write access to its persistent data directory.
3. In Odoo, activate **Developer Mode**, then go to **Apps → Update Apps List**. Search for **BucketPilot** and click **Activate**.
4. Open **BucketPilot** from the Odoo app switcher.

## 2. Connect and create your first backup

1. Open **BucketPilot → Connection**. Enter your BucketPilot API key and click **Validate and connect**.
2. Open **Backups**. Enter a name, select the bucket and destination folder, and choose files or folders from **Filestore root**. The first level lists the folders available to your database. Open a folder to choose individual files, or select **Entire current folder** to include everything available in that folder.
3. Choose **Run Now** or set a schedule, then review and confirm.
4. Follow the result in **Backup History**. Odoo's **BucketPilot: Process backup requests** scheduled action handles the backup even when your browser is closed. For your first test, use a non-sensitive sample file in a separate test installation and an authorized test bucket.

Files selected individually go directly into the dated destination. Selecting a folder keeps the paths inside it.

The filestore contains attachments stored on disk, under Odoo's internal file names. PostgreSQL records and attachments stored in the database require a database backup. Git is not required.

**Upgrading from project-file backups?** Open each saved schedule you want to keep, select files or folders from the current source, and save it again. Create a new backup for any older one-time run you want to repeat.

## Optional setup for your server

**Allow full filestore backups.** By default, each Odoo database can back up its own folder in the filestore. To let the Odoo Settings administrators of one trusted database browse and back up the whole filestore, set `BUCKETPILOT_FILESTORE_ADMIN_DB` in the Odoo service environment to that database's name. For example, under `services → odoo → environment` in Docker Compose:

```yaml
BUCKETPILOT_FILESTORE_ADMIN_DB: bucketpilot
```

Use this setting only for a database you trust with all files in that Odoo filestore. Restart Odoo after changing it.

**Choose a different source folder only if needed.** By default, BucketPilot reads `<data_dir>/filestore` from the running Odoo configuration. Leave `BUCKETPILOT_PROJECT_ROOT` unset or empty to use that default. If your administrator wants to back up a different approved folder, set its absolute path in the Odoo service environment. For Docker Compose, add this under `services → odoo → environment` and set the value in the project's `.env` file:

```yaml
BUCKETPILOT_PROJECT_ROOT: ${BUCKETPILOT_PROJECT_ROOT:-}
```

For Docker, the path is the location inside the container. Mount the folder and give the Odoo service read access. A custom source is shared by the databases served by that Odoo service. Use a dedicated folder containing only files approved for backup. BucketPilot does not apply `.gitignore` rules.

**Create the key storage manually only if needed.** BucketPilot normally creates `bucketpilot-secrets` in Odoo's persistent `data_dir` when you save a valid API key. If directory creation fails, check that Odoo can write to `data_dir`. In this Docker setup, use the following command to create a private directory owned by the Odoo service user:

```sh
docker compose exec -T --user root odoo install -d -m 0700 -o odoo -g odoo /var/lib/odoo/bucketpilot-secrets
```

Set this optional entry under the same `environment` section. Keep the directory on persistent storage outside the backup source.

```yaml
BUCKETPILOT_SECRET_DIRECTORY: /var/lib/odoo/bucketpilot-secrets
```

On Linux without Docker, run `sudo install -d -m 0700 -o odoo -g odoo /srv/odoo-private/bucketpilot-secrets` with your actual service user and group, then set `BUCKETPILOT_SECRET_DIRECTORY` to that path in the Odoo service environment.

Apply Compose changes with `docker compose up -d odoo`, or restart the native Odoo service. Save the API key again in **Connection** if you changed or created its storage directory.

## Optional email reports

Configure an active server in **Odoo Settings → Emails → Outgoing Email Servers** and use **Test Connection**. Set the recipient in the main company's **Email** field under **Settings → Users & Companies → Companies**. Verify the address and SMTP status under **BucketPilot → Connection → Backup email notifications**.
