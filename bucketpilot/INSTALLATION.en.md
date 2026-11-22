# Install BucketPilot on Odoo 18

**English** · [العربية](INSTALLATION.ar.md)

## Before you install

- Use an Odoo 18 server that supports custom Python apps, such as self-hosted Community or Enterprise.
- Have a BucketPilot workspace, a connected bucket and an API key. Use a read/write key to create backups.
- The Odoo server needs Git and the Python packages `Jinja2` and `requests`.

## 1. Add the app to Odoo

1. Ask your server administrator to put the `bucketpilot` app folder in a configured Odoo add-ons directory and restart Odoo. The folder should contain `__manifest__.py` directly.
2. Give Odoo read access to the project files and write access to its persistent data directory.
3. In Odoo, activate **Developer Mode**, then go to **Apps → Update Apps List**. Search for **BucketPilot** and click **Activate**.
4. Open **BucketPilot** from the Odoo app switcher.

## 2. Connect and create your first backup

1. Open **BucketPilot → Connection**. Enter your BucketPilot API key and click **Validate and connect**.
2. Open **Backups**. Enter a name, select the bucket and destination folder, and choose which project files to include.
3. Choose **Run Now** or set a schedule, then review and confirm.
4. Follow the result in **Backup History**. Odoo's **BucketPilot: Process backup requests** scheduled action handles the backup even when your browser is closed. For your first test, use a non-sensitive sample file in a separate test installation and an authorized test bucket.

## Optional setup for your server

**Choose where file browsing starts.** BucketPilot detects the root of a standard project and applies Git ignore rules. To select another folder in Docker, edit this line under `services → odoo → environment` in `compose.yaml`:

```yaml
BUCKETPILOT_PROJECT_ROOT: ${BUCKETPILOT_PROJECT_ROOT:-/mnt/project}
```

Replace `/mnt/project` with the absolute path Odoo sees inside its container, or set `BUCKETPILOT_PROJECT_ROOT` in the project's Compose `.env` file. On a server without Docker, set the same variable in the Odoo service environment.

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
