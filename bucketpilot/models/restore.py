import re
import tempfile
import time
from datetime import timedelta

from psycopg2.errors import UniqueViolation

from odoo import api, fields, models
from odoo.tools import SQL

from .backup import TERMINAL, identifier
from ..storage import BackupError, BucketPilotAPI, Credential, MAX_FILE, Sources, path_parts, stream_digest


RESTORE_ACTIVE = ("queued", "preparing", "running")
RESTORE_STATES = [
    ("queued", "Queued"), ("preparing", "Preparing file list"), ("running", "Restoring"),
    ("completed", "Completed"), ("completed_with_issues", "Completed with issues"), ("failed", "Failed"),
]
ALREADY_ACTIVE = "A restore for this backup is already in progress. Open Restore History to follow it."
ITEM_STATES = [
    ("pending", "Pending"), ("restored", "Restored"), ("existing", "Already exists"),
    ("missing", "Missing from bucket"), ("skipped", "Skipped"), ("failed", "Failed"),
]


class RestoreRun(models.Model):
    _name = "bucketpilot.restore"
    _description = "BucketPilot filestore restore"
    _order = "id desc"

    public_id = fields.Char(required=True, default=identifier, index=True)
    backup_id = fields.Many2one("bucketpilot.run", required=True, ondelete="restrict", index=True)
    backup_name = fields.Char(required=True)
    reason = fields.Char(size=500)
    requester_id = fields.Many2one("res.users", ondelete="set null")
    bucket = fields.Json(required=True)
    identity = fields.Char(required=True)
    source_binding = fields.Char(required=True)
    mode = fields.Selection([("backup", "Entire backup"), ("folder", "Folder"), ("file", "File")], required=True)
    source_path = fields.Char()
    selection_item_id = fields.Integer()
    state = fields.Selection(RESTORE_STATES, default="queued", required=True, index=True)
    total = fields.Integer(required=True)
    cursor_item_id = fields.Integer()
    seeded = fields.Boolean()
    started = fields.Datetime()
    finished = fields.Datetime()
    next_retry = fields.Datetime(index=True)
    error = fields.Char()
    last_path = fields.Char()
    _sql_constraints = [("public_id", "unique(public_id)", "The restore identifier already exists.")]

    def init(self):
        self.env.cr.execute(SQL("""
            CREATE UNIQUE INDEX IF NOT EXISTS bucketpilot_one_active_restore
            ON bucketpilot_restore (backup_id) WHERE state IN ('queued', 'preparing', 'running')
        """))

    @api.model
    def _domain(self, backup, mode, item_id=0, path=""):
        domain = [("run_id", "=", backup.id), ("kind", "=", "file")]
        if mode == "file" and item_id:
            domain.append(("id", "=", item_id))
        elif mode == "folder" and path:
            path_parts(path)
            prefix = path.replace("%", r"\%").replace("_", r"\_")
            domain.append(("path", "=like", prefix + "/%"))
        elif mode != "backup":
            raise BackupError("Choose a confirmed file, a source folder, or the entire backup.")
        return domain

    @api.model
    def _review(self, backup, mode, item_id, path):
        sources = Sources(self.env.cr.dbname)
        if backup.archived or backup.state not in TERMINAL or not backup.prefix:
            raise BackupError("Restore is available for finished backups with confirmed uploads.")
        if sources.custom or backup.config.get("source_binding") != sources.binding:
            raise BackupError("This backup must belong to the currently configured Odoo filestore.")
        domain = self._domain(backup, mode, item_id, path)
        items = self.env["bucketpilot.item"]
        confirmed = domain + [("state", "=", "done")]
        count = items.search_count(confirmed)
        if not count:
            raise BackupError("No confirmed uploads match this selection.")
        first = items.search(confirmed, order="id", limit=1)
        excluded = items.search_count(domain + [("state", "!=", "done")])
        return {
            "total": count, "excluded": excluded, "source_path": first.path if mode == "file" else path,
            "object_key": backup._object_key(first) if mode == "file" else backup.prefix,
            "root": str(sources.root),
        }

    @api.model
    def _enqueue(self, backup, requester, mode, item_id, reason):
        if mode not in ("backup", "file"):
            raise BackupError("Choose an individual file or the entire backup.")
        if not isinstance(reason, str) or not reason.strip() or len(reason.strip()) > 500:
            raise BackupError("Enter a restore reason of up to 500 characters.")
        self.env.cr.execute(SQL("SELECT id FROM bucketpilot_run WHERE id = %s FOR UPDATE", backup.id))
        backup.invalidate_recordset()
        review = self._review(backup, mode, item_id, "")
        if self.search_count([("backup_id", "=", backup.id), ("state", "in", RESTORE_ACTIVE)], limit=1):
            raise BackupError(ALREADY_ACTIVE)
        try:
            with self.env.cr.savepoint():
                return self.create({
                    "backup_id": backup.id, "backup_name": backup.name, "requester_id": requester, "reason": reason.strip(),
                    "bucket": backup.config["bucket"], "identity": backup.identity,
                    "source_binding": backup.config["source_binding"], "mode": mode,
                    "source_path": review["source_path"], "selection_item_id": item_id, "total": review["total"],
                })
        except UniqueViolation as issue:
            if issue.diag.constraint_name != "bucketpilot_one_active_restore":
                raise
            raise BackupError(ALREADY_ACTIVE) from None

    def _prepare(self):
        domain = self._domain(self.backup_id, self.mode, self.selection_item_id, self.source_path or "")
        rows = self.env["bucketpilot.item"].search(
            domain + [("state", "=", "done"), ("id", ">", self.cursor_item_id)], order="id", limit=200)
        if rows:
            self.env["bucketpilot.restore.item"].create([{
                "restore_id": self.id, "source_path": row.path, "object_key": self.backup_id._object_key(row),
                "size": row.size, "content_sha256": row.content_sha256,
            } for row in rows])
            self.cursor_item_id = rows[-1].id
        if len(rows) < 200:
            if self.env["bucketpilot.restore.item"].search_count([("restore_id", "=", self.id)]) != self.total:
                raise BackupError("The backup file list is incomplete. Restore cannot continue.")
            self.write({"seeded": True, "state": "running"})

    def _summary(self):
        self.ensure_one()
        groups = self.env["bucketpilot.restore.item"]._read_group(
            [("restore_id", "=", self.id)], ["state"], ["__count"])
        counts = dict(groups)
        result = {key: counts.get(key, 0) for key in ("restored", "existing", "missing", "skipped", "failed")}
        processed = sum(result.values())
        transfer = self.env["bucketpilot.restore.transfer"].search([("restore_key", "=", self.id)], limit=1)
        phase = "waiting" if self.state == "queued" else "preparing" if self.state == "preparing" else ""
        current = ""
        received = expected = 0
        fraction = 0
        if self.state == "running":
            phase = "retrying" if self.next_retry else "checking"
            if transfer.updated and transfer.updated > fields.Datetime.now() - timedelta(seconds=60):
                item = self.env["bucketpilot.restore.item"].browse(transfer.item_key).exists()
                if item and item.restore_id == self and item.state == "pending" and not item.next_retry:
                    phase, current = transfer.phase, item.source_path
                    received, expected = transfer.received, item.size
                    fraction = {"checking": .04, "downloading": .10 + .78 * min(received / max(expected, 1), 1),
                                "verifying": .92, "saving": .98}.get(phase, 0)
        prepared = sum(counts.values())
        total = max(self.total, 1)
        percentage = 6 + 94 * (processed + fraction) / total if self.seeded else 6 * prepared / total
        return {**result, "processed": processed, "total": self.total, "prepared": prepared,
                "percentage": min(percentage, 100), "phase": phase, "current_path": current,
                "received": received, "expected": expected, "state": self.state,
                "label": dict(RESTORE_STATES)[self.state], "active": self.state in RESTORE_ACTIVE,
                "last_path": self.last_path or "", "error": self.error or ""}

    def _bound_client(self):
        client = BucketPilotAPI(Credential(self.env.cr.dbname).read())
        if client.identity(client.bucket(self.bucket["id"])) != self.identity:
            raise BackupError("The current connection does not match the original backup bucket.")
        return client

    def _step(self, clients):
        now = fields.Datetime.now()
        try:
            sources = Sources(self.env.cr.dbname)
            if sources.custom or sources.binding != self.source_binding:
                raise BackupError("The configured filestore changed. Restore cannot write to this location.")
            if not self.seeded:
                if self.state == "queued":
                    self.write({"state": "preparing", "started": self.started or now})
                self._prepare()
                return
            items = self.env["bucketpilot.restore.item"]
            pending = [("restore_id", "=", self.id), ("state", "=", "pending")]
            item = items.search(pending + ["|", ("next_retry", "=", False), ("next_retry", "<=", now)], order="id", limit=1)
            if not item:
                waiting = items.search(pending, order="next_retry", limit=1)
                if waiting:
                    self.next_retry = waiting.next_retry
                else:
                    summary = self._summary()
                    self.write({"state": "completed_with_issues" if summary["missing"] or summary["failed"] else "completed",
                                "finished": now, "next_retry": False})
                return
            if self.id not in clients:
                clients[self.id] = self._bound_client()
            self.write({"last_path": item.source_path, "next_retry": False, "error": False})
            item._restore(sources, clients[self.id], self.bucket, now)
        except BackupError as issue:
            if issue.code == "temporary":
                self.write({"error": str(issue), "next_retry": now + timedelta(seconds=max(60, issue.delay))})
            else:
                self.write({"state": "failed", "error": str(issue), "finished": now, "next_retry": False})

    def _retry(self):
        self.ensure_one()
        self.env.cr.execute(SQL("SELECT id FROM bucketpilot_restore WHERE id = %s FOR UPDATE", self.id))
        self.invalidate_recordset()
        if self.state not in ("failed", "completed_with_issues"):
            raise BackupError("This restore has no finished errors to retry.")
        if not self.seeded and self.backup_id.archived:
            raise BackupError("The original backup history was cleared before this restore saved its file list.")
        items = self.env["bucketpilot.restore.item"].search([
            ("restore_id", "=", self.id), ("state", "in", ("failed", "missing")),
        ])
        try:
            with self.env.cr.savepoint():
                self.write({"state": "running" if self.seeded else "queued", "error": False,
                            "finished": False, "next_retry": False})
                items.write({"state": "pending", "error": False, "attempts": 0, "next_retry": False})
        except UniqueViolation as issue:
            if issue.diag.constraint_name != "bucketpilot_one_active_restore":
                raise
            raise BackupError(ALREADY_ACTIVE) from None

    @api.model
    def _cron_process(self):
        deadline = time.monotonic() + 12
        clients = {}
        while time.monotonic() < deadline:
            with self.env.registry.cursor() as cr:
                env = api.Environment(cr, self.env.uid, self.env.context)
                cr.execute("SELECT pg_try_advisory_xact_lock(hashtext('bucketpilot.restore.worker'))")
                if not cr.fetchone()[0]:
                    return
                cr.execute("SELECT pg_advisory_xact_lock_shared(hashtext('bucketpilot.connection'))")
                cr.execute(SQL("""
                    SELECT id FROM bucketpilot_restore
                    WHERE state IN %s AND (next_retry IS NULL OR next_retry <= %s)
                    ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
                """, RESTORE_ACTIVE, fields.Datetime.now()))
                row = cr.fetchone()
                if not row:
                    return
                env[self._name].browse(row[0])._step(clients)
                cr.commit()


class RestoreItem(models.Model):
    _name = "bucketpilot.restore.item"
    _description = "BucketPilot restore file"
    _order = "id"

    restore_id = fields.Many2one("bucketpilot.restore", required=True, ondelete="cascade", index=True)
    source_path = fields.Char(required=True)
    object_key = fields.Char(required=True)
    size = fields.Integer()
    content_sha256 = fields.Char()
    state = fields.Selection(ITEM_STATES, default="pending", required=True, index=True)
    attempts = fields.Integer()
    next_retry = fields.Datetime()
    error = fields.Char()
    created_folders = fields.Json()

    def _publish_progress(self, phase, received=0):
        # A separate row and transaction let the browser see progress before the worker commits the file.
        with self.env.registry.cursor() as cr:
            cr.execute(SQL("""
                INSERT INTO bucketpilot_restore_transfer (restore_key, item_key, phase, received, updated)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (restore_key) DO UPDATE SET
                    item_key = EXCLUDED.item_key, phase = EXCLUDED.phase,
                    received = EXCLUDED.received, updated = EXCLUDED.updated
            """, self.restore_id.id, self.id, phase, received, fields.Datetime.now()))
            cr.commit()

    def _verify_download(self, stream):
        if self.content_sha256:
            algorithm, expected = "sha256", self.content_sha256
        else:
            parts = self.source_path.split("/")
            if len(parts) != 3 or not re.fullmatch(r"[a-f0-9]{40}", parts[-1]) or parts[1] != parts[-1][:2]:
                return
            algorithm, expected = "sha1", parts[-1]
        if stream_digest(stream, algorithm) != expected:
            raise BackupError("The file contents do not match the recorded backup.", "checksum")

    def _restore(self, sources, client, bucket, now):
        created = list(self.created_folders or [])
        attempts = self.attempts + 1
        values = {"attempts": attempts, "next_retry": False, "error": False}
        self._publish_progress("checking")
        last_update = time.monotonic()

        def downloaded(received):
            nonlocal last_update
            now = time.monotonic()
            if now - last_update >= .5:
                last_update = now
                self._publish_progress("downloading", received)

        try:
            parts = path_parts(self.source_path)
            if len(parts) > 2 and parts[1] == "checklist":
                values.update(state="skipped", error="Odoo regenerates its filestore cleanup markers.")
            else:
                meta = client.metadata(bucket["id"], self.object_key)
                if sources.restore_exists(self.source_path):
                    values.update(state="existing", error="A file already exists at the original path.")
                else:
                    if not 0 <= self.size <= MAX_FILE:
                        raise BackupError("The recorded file size is outside the supported restore limit.")
                    with tempfile.TemporaryFile(dir=sources.root.parent) as stream:
                        self._publish_progress("downloading")
                        client.download(bucket["id"], self.object_key, bucket["provider"], stream, self.size,
                                        version=meta.get("versionId"), progress=downloaded)
                        self._publish_progress("verifying", self.size)
                        self._verify_download(stream)
                        self._publish_progress("saving", self.size)
                        if sources.restore_file(self.source_path, stream, created):
                            values["state"] = "restored"
                        else:
                            values.update(state="existing", error="A file already exists at the original path.")
        except OSError:
            values.update(state="failed", error="Temporary restore storage is unavailable.")
        except BackupError as issue:
            if issue.code == "temporary" and attempts < 5:
                values.update(state="pending", error=str(issue),
                              next_retry=now + timedelta(seconds=max(issue.delay, 30 * 2**attempts)))
            else:
                values.update(state="missing" if issue.code == "missing" else "failed", error=str(issue))
        self.write({**values, "created_folders": created})


class RestoreTransfer(models.Model):
    _name = "bucketpilot.restore.transfer"
    _description = "BucketPilot live restore transfer"
    _log_access = False

    restore_key = fields.Integer(required=True)
    item_key = fields.Integer(required=True)
    phase = fields.Char(required=True)
    received = fields.Integer()
    updated = fields.Datetime(required=True)
    _sql_constraints = [("restore_key", "unique(restore_key)", "A restore has one live transfer.")]
