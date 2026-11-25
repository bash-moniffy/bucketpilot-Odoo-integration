import logging
import time
from datetime import timedelta, timezone
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape

from odoo import api, fields, models
from odoo.tools import SQL

from ..calendar import next_run
from ..storage import BackupError, BucketPilotAPI, Credential, Sources, fingerprint, selected, stream_digest

_logger = logging.getLogger(__name__)
MAIL_TEMPLATES = Environment(
    loader=FileSystemLoader(Path(__file__).resolve().parents[1] / "templates"),
    autoescape=select_autoescape(["html"]),
)
MAIL_COLORS = {
    "completed": ("#206640", "#e8f5ed"),
    "completed_with_errors": ("#93520b", "#fff4df"),
    "failed": ("#a12e40", "#fff0f2"),
    "cancelled": ("#586474", "#eef2f6"),
}
FREQUENCY_LABELS = {
    "now": "Run Now",
    "once": "Run Once Later",
    "daily": "Daily",
    "weekly": "Weekly",
    "monthly": "Monthly",
}

ACTIVE = ("pending", "queued", "scanning", "running")
TERMINAL = ("completed", "completed_with_errors", "failed", "cancelled")
TRANSIENT = ("temporary",)
RUN_STATES = [(state, state.replace("_", " ").capitalize()) for state in (*ACTIVE, *TERMINAL)]


def timestamp(value):
    return int(value.replace(tzinfo=timezone.utc).timestamp()) if value else 0


def human_bytes(value):
    try:
        size = int(value)
    except (ValueError, TypeError):
        return "—"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1000 or unit == "TB":
            return f"{size:.1f}".removesuffix(".0") + " " + unit
        size /= 1000


def identifier(_record):
    return str(uuid4())


class BackupDraft(models.Model):
    _name = "bucketpilot.draft"
    _description = "BucketPilot private builder draft"

    owner_id = fields.Many2one("res.users", required=True, ondelete="cascade")
    scope = fields.Char(required=True)
    revision = fields.Integer(default=1)
    generation = fields.Integer()
    config = fields.Json(required=True)
    _sql_constraints = [("owner_scope", "unique(owner_id, scope)", "A draft already exists.")]


class BackupCommand(models.Model):
    _name = "bucketpilot.command"
    _description = "BucketPilot idempotent command receipt"

    owner_id = fields.Many2one("res.users", required=True, ondelete="cascade")
    request_id = fields.Char(required=True)
    generation = fields.Integer()
    result = fields.Json(required=True)
    _sql_constraints = [("owner_request", "unique(owner_id, request_id)", "This request already exists.")]


class BackupPlan(models.Model):
    _name = "bucketpilot.plan"
    _description = "BucketPilot backup plan"

    public_id = fields.Char(required=True, default=identifier, index=True)
    name = fields.Char(required=True)
    config = fields.Json(required=True)
    credential = fields.Char(required=True)
    identity = fields.Char(required=True)
    revision = fields.Integer(default=1)
    next_date = fields.Datetime(index=True)
    last_date = fields.Datetime()
    paused = fields.Boolean()
    deleted = fields.Boolean(index=True)
    hold = fields.Char()
    _sql_constraints = [("public_id", "unique(public_id)", "The plan identifier already exists.")]

    def _reserve(self, execution_type, snapshot=None):
        self.ensure_one()
        now = fields.Datetime.now()
        original = snapshot or self
        run = self.env["bucketpilot.run"].create({
            "plan_id": self.id, "plan_public_id": self.public_id, "name": original.name,
            "config": {**original.config, "destination_source_folder": None, "destination_flat_files": None},
            "credential": original.credential, "identity": original.identity,
            "execution_type": execution_type, "requested": now, "bucket_identity": original.identity,
        })
        self.last_date = now
        return run


class BackupRun(models.Model):
    _name = "bucketpilot.run"
    _description = "BucketPilot backup execution"

    public_id = fields.Char(required=True, default=identifier, index=True)
    plan_id = fields.Many2one("bucketpilot.plan", index=True, ondelete="set null")
    plan_public_id = fields.Char(index=True)
    name = fields.Char(required=True)
    config = fields.Json(required=True)
    restore_ids = fields.One2many("bucketpilot.restore", "backup_id")
    credential = fields.Char()
    identity = fields.Char()
    execution_type = fields.Char(required=True)
    requested = fields.Datetime(required=True, index=True)
    started = fields.Datetime()
    finished = fields.Datetime()
    next_retry = fields.Datetime(index=True)
    attempts = fields.Integer()
    state = fields.Selection(RUN_STATES, default="pending", index=True, required=True)
    error = fields.Char()
    prefix = fields.Char(index=True)
    bucket_identity = fields.Char(index=True)
    archived = fields.Boolean(index=True)
    scan_errors = fields.Integer()
    notification_sent = fields.Boolean()
    _sql_constraints = [("public_id", "unique(public_id)", "The execution identifier already exists.")]

    def _summary(self):
        self.ensure_one()
        item_model = self.env["bucketpilot.item"]
        groups = item_model._read_group([("run_id", "=", self.id), ("kind", "=", "file")],
                                        ["state"], ["__count", "size:sum"])
        counts = {state: (count, size or 0) for state, count, size in groups}
        successful, uploaded = counts.get("done", (0, 0))
        failed, failed_size = counts.get("failed", (0, 0))
        skipped, skipped_size = counts.get("skipped", (0, 0))
        return dict(successful=successful, failed=failed, skipped=skipped, uploaded_bytes=uploaded,
                    processed_bytes=uploaded + failed_size + skipped_size,
                    total_files=sum(count for count, _ in counts.values()),
                    processed_files=successful + failed + skipped, scan_errors=self.scan_errors)

    def _set_terminal(self, state, error=False):
        self.write({"state": state, "finished": fields.Datetime.now(), "error": error, "next_retry": False})

    def _bound_api(self):
        key = Credential(self.env.cr.dbname).read()
        if not key or fingerprint(key) != self.credential:
            raise BackupError("Restore the original API key to continue.", "connection_changed")
        return BucketPilotAPI(key)

    def _check_remote(self, client):
        bucket = self.config["bucket"]
        live = client.bucket(bucket["id"])
        if client.identity(live) != self.identity:
            raise BackupError("Original workspace or bucket settings no longer match.", "settings_changed")
        if live["provider"] not in ("aws", "r2", "gcs"):
            raise BackupError("This storage provider does not support the backup uploader.")
        if self.plan_id.hold:
            self.plan_id.hold = False
        return bucket

    def _allocate(self, client, bucket):
        prefix = self.config["prefix"]
        base = f"{prefix + '/' if prefix else ''}{self.requested:%Y-%m-%d}"
        for version in range(100):
            candidate = base + (f"_bucket_v{version}" if version else "") + "/"
            exists = self.search_count([("prefix", "=", candidate), ("id", "!=", self.id),
                                        ("bucket_identity", "=", self.identity)])
            if exists or client.occupied(bucket["id"], candidate):
                continue
            self.prefix = candidate
            return
        raise BackupError("No free backup folder could be allocated for this date.")

    def _seed(self):
        self.env["bucketpilot.item"].create([
            {"run_id": self.id, "path": rule["path"] or "/", "kind": "directory" if rule["directory"] else "file"}
            for rule in self.config["rules"] if rule["include"]
        ])
        self.write({"state": "scanning", "started": fields.Datetime.now(), "error": False, "attempts": 0,
                    "next_retry": False})
        self.plan_id.hold = False

    def _destination_layout(self, sources):
        config = {**self.config, "destination_source_folder": False}
        if sources.custom:
            return config

        items = self.env["bucketpilot.item"]
        items.flush_model(["run_id", "kind", "path"])
        self.env.cr.execute(SQL("""
            SELECT DISTINCT
                CASE WHEN strpos(path, '/') > 0 THEN split_part(path, '/', 1) ELSE '' END
            FROM bucketpilot_item
            WHERE run_id = %s AND kind = 'file'
            LIMIT 2
        """, self.id))
        folders = self.env.cr.fetchall()
        folder = folders[0][0] if len(folders) == 1 else ""
        config["destination_source_folder"] = folder or False
        # Earlier executions may already have checkpoints with their original keys.
        if "destination_flat_files" not in config:
            return config

        flat = {rule["path"]: rule["path"].rsplit("/", 1)[-1] for rule in config["rules"]
                if rule["include"] and not rule["directory"]}
        names = set(flat.values())
        prefix = folder + "/" if folder else ""
        collisions = items.search_count([
            ("run_id", "=", self.id), ("kind", "=", "file"),
            ("path", "in", [prefix + name for name in names]), ("path", "not in", list(flat)),
        ], limit=1) if names else 0
        if len(names) != len(flat) or collisions:
            raise BackupError("Selected files would have the same name in the destination. Back them up in separate runs.")
        config["destination_flat_files"] = flat
        return config

    def _scan(self, sources):
        items = self.env["bucketpilot.item"]
        folder = items.search([("run_id", "=", self.id), ("kind", "=", "directory"), ("state", "=", "pending")],
                              order="id", limit=1)
        if not folder:
            changes = {"state": "running"}
            if "destination_source_folder" in self.config and self.config["destination_source_folder"] is None:
                changes["config"] = self._destination_layout(sources)
            self.write(changes)
            return
        try:
            rows = sources.listing("" if folder.path == "/" else folder.path)
        except BackupError:
            self.scan_errors += 1
            folder.state = "failed"
            return
        rules = self.config["rules"]
        page = rows[folder.offset:folder.offset + 100]
        write = []
        for row in page:
            if not selected(rules, row["path"]):
                continue
            write.append({"run_id": self.id, "path": row["path"],
                          "kind": "directory" if row["directory"] else "file", "size": row["size"] or 0})
        known = set(items.search([("run_id", "=", self.id), ("path", "in", [item["path"] for item in write])]).mapped("path"))
        if write:
            items.create([item for item in write if item["path"] not in known])
        if len(rows) > folder.offset + len(page):
            folder.offset += len(page)
        else:
            folder.state = "done"

    def _object_key(self, item):
        self.ensure_one()
        if item.object_key:
            return item.object_key
        folder = self.config.get("destination_source_folder")
        relative_path = item.path.removeprefix(folder + "/") if folder else item.path
        object_path = (self.config.get("destination_flat_files") or {}).get(item.path, relative_path)
        return self.prefix + object_path if self.prefix else ""

    def _file(self, sources, client, bucket):
        now = fields.Datetime.now()
        items = self.env["bucketpilot.item"]
        domain = [("run_id", "=", self.id), ("kind", "=", "file"), ("state", "in", ("pending", "put"))]
        item = items.search(domain + ["|", ("next_retry", "=", False), ("next_retry", "<=", now)],
                            order="id", limit=1)
        if not item:
            waiting = items.search(domain, order="next_retry", limit=1)
            if waiting:
                self.next_retry = waiting.next_retry
                return
            metrics = self._summary()
            failures = metrics["failed"] + metrics["scan_errors"]
            self._set_terminal(("completed_with_errors" if metrics["successful"] else "failed") if failures else "completed")
            return
        self.next_retry = False
        self.error = False
        try:
            key = self._object_key(item)
            if len(key.encode()) > 1024:
                raise BackupError("The object key exceeds the storage length limit.")
            if item.state == "pending":
                with sources.snapshot(item.path) as (stream, size):
                    checksum = stream_digest(stream, "sha256")
                    client.put(bucket["id"], key, bucket["provider"], stream, size)
                item.write({"size": size, "object_key": key, "content_sha256": checksum, "state": "put",
                            "attempts": 0, "error": False, "next_retry": False})
            else:
                client.confirm(bucket["id"], key)
                item.write({"state": "done", "attempts": item.attempts + 1, "error": False, "next_retry": False})
        except BackupError as issue:
            if issue.code in ("connection_changed", "settings_changed", "access", "missing"):
                raise
            attempts = item.attempts + 1
            retry = issue.code in TRANSIENT and attempts < 5
            item.write({"attempts": attempts, "error": str(issue), "state": item.state if retry else "failed", "failed_phase": item.state,
                        "next_retry": now + timedelta(seconds=max(issue.delay, 30 * 2**attempts)) if retry else False})

    def _step(self, verified):
        now = fields.Datetime.now()
        try:
            sources = Sources(self.env.cr.dbname)
            sources.verify(self.config)
            client = self._bound_api()
            if self.state in ("pending", "queued"):
                bucket = self._check_remote(client)
                verified[self.id] = bucket
                with sources.opened("", True):
                    pass
                if not self.prefix:
                    self._allocate(client, bucket)
                self._seed()
            elif self.state == "scanning":
                self._scan(sources)
            elif self.state == "running":
                bucket = verified.get(self.id)
                if not bucket:
                    bucket = self._check_remote(client)
                    verified[self.id] = bucket
                self._file(sources, client, bucket)
        except BackupError as issue:
            if issue.code in ("connection_changed", "settings_changed", "access", "missing"):
                reasons = {"access": "access_unavailable", "missing": "bucket_missing"}
                self.plan_id.hold = reasons.get(issue.code, issue.code)
                self.write({"error": str(issue), "next_retry": now + timedelta(minutes=1)})
            elif issue.code in TRANSIENT and self.attempts < 4:
                self.write({"attempts": self.attempts + 1, "error": str(issue),
                            "next_retry": now + timedelta(seconds=max(issue.delay, 30 * 2**self.attempts))})
            else:
                self._set_terminal("failed", str(issue))

    @api.model
    def _schedule_due(self, now):
        Plan = self.env["bucketpilot.plan"]
        due = Plan.search([("paused", "=", False), ("deleted", "=", False),
                           ("next_date", "!=", False), ("next_date", "<=", now)], limit=25)
        sources = Sources(self.env.cr.dbname)
        for plan in due:
            self.env.cr.execute("SELECT id FROM bucketpilot_plan WHERE id = %s FOR UPDATE SKIP LOCKED", [plan.id])
            if not self.env.cr.fetchone():
                continue
            plan.invalidate_recordset()
            if plan.paused or plan.deleted or not plan.next_date or plan.next_date > now:
                continue
            if self.search_count([("plan_id", "=", plan.id), ("state", "in", ACTIVE)]):
                continue
            if plan.config.get("source_binding") != sources.binding:
                plan.write({"hold": "source_changed", "next_date": False})
                continue
            schedule = plan.config["schedule"]
            plan._reserve("scheduled")
            plan.next_date = next_run(schedule, now) or False

    @api.model
    def _notification_status(self):
        server = bool(self.env["ir.mail_server"].search_count([("active", "=", True), ("smtp_host", "!=", False)], limit=1))
        email = self.env.ref("base.main_company").email or ""
        from odoo.tools import email_normalize
        recipient = email_normalize(email) or False
        return server and bool(recipient), recipient

    def _completion_report(self):
        self.ensure_one()
        summary = self._summary()
        schedule = self.config["schedule"]
        zone = ZoneInfo(schedule["timezone"])

        def local(value):
            if not value:
                return "—"
            localized = value.replace(tzinfo=timezone.utc).astimezone(zone)
            return f"{localized:%b} {localized.day}, {localized:%Y, %H:%M}"

        empty = self.state == "completed" and not summary["successful"]
        status = "Finished — no files uploaded" if empty else dict(RUN_STATES)[self.state]
        color, background = MAIL_COLORS[self.state]
        duration = "—"
        if self.started and self.finished:
            duration = f"{max(0, int((self.finished - self.started).total_seconds()))} s"

        sources = {"included": [], "excluded": []}
        for rule in self.config.get("rules", [])[:100]:
            group = "included" if rule["include"] else "excluded"
            sources[group].append({"path": rule["path"] or "Entire source", "directory": rule["directory"]})

        return {
            "site": self.env.ref("base.main_company").name,
            "plan": self.name,
            "id": self.public_id,
            "status_label": status,
            "color": color,
            "background": background,
            "headline": ("No files were uploaded. Review the backup details for the recorded outcome." if empty
                         else "Your backup execution has finished. Here is the recorded result."),
            "bucket": self.config["bucket"]["name"],
            "folder": self.prefix or self.config["prefix"] or "/",
            "frequency": FREQUENCY_LABELS[schedule["frequency"]],
            "execution_type": self.execution_type.replace("_", " ").capitalize(),
            "timezone": schedule["timezone"],
            "requested": local(self.requested),
            "started": local(self.started),
            "completed": local(self.finished),
            "duration": duration,
            "successful": summary["successful"],
            "failed": summary["failed"],
            "skipped": summary["skipped"],
            "uploaded": human_bytes(summary["uploaded_bytes"]),
            "scan_errors": summary["scan_errors"],
            "error": self.error,
            "sources": sources,
            "details_url": self.get_base_url().rstrip("/") + "/bucketpilot/history/" + self.public_id,
            "details_label": "View backup details",
        }

    def _queue_email(self):
        self.notification_sent = True
        ready, recipient = self._notification_status()
        if not ready:
            return
        report = self._completion_report()
        body = MAIL_TEMPLATES.get_template("completion-email.html").render(report=report)
        self.env["mail.mail"].create({"subject": f"BucketPilot · {self.name} · {self.state.replace('_', ' ')}",
                                     "email_to": recipient, "email_from": recipient, "body_html": body,
                                     "auto_delete": True})

    @api.model
    def _cron_process(self):
        deadline = time.monotonic() + 12
        verified = {}
        while time.monotonic() < deadline:
            with self.env.registry.cursor() as cr:
                env = api.Environment(cr, self.env.uid, self.env.context)
                worker = env[self._name]
                cr.execute("SELECT pg_try_advisory_xact_lock(hashtext('bucketpilot.worker'))")
                if not cr.fetchone()[0]:
                    return
                cr.execute("SELECT pg_advisory_xact_lock_shared(hashtext('bucketpilot.connection'))")
                now = fields.Datetime.now()
                worker._schedule_due(now)
                cr.execute(SQL("""
                    SELECT id FROM bucketpilot_run
                    WHERE state IN %s AND (next_retry IS NULL OR next_retry <= %s)
                    ORDER BY CASE WHEN state IN ('scanning', 'running') THEN 0 ELSE 1 END, requested, id
                    LIMIT 1 FOR UPDATE SKIP LOCKED
                """, ACTIVE, now))
                result = cr.fetchone()
                if result:
                    run = worker.browse(result[0])
                    run._step(verified)
                try:
                    with cr.savepoint():
                        for report in worker.search([("state", "in", TERMINAL), ("archived", "=", False),
                                                     ("notification_sent", "=", False)], limit=10):
                            report._queue_email()
                except Exception:
                    _logger.warning("BucketPilot could not queue a completion notification.")
                cr.commit()
                if not result:
                    return


class BackupItem(models.Model):
    _name = "bucketpilot.item"
    _description = "BucketPilot file checkpoint"

    run_id = fields.Many2one("bucketpilot.run", required=True, index=True, ondelete="cascade")
    path = fields.Char(required=True)
    object_key = fields.Char()
    content_sha256 = fields.Char()
    kind = fields.Selection([("directory", "Directory"), ("file", "File")], required=True)
    state = fields.Selection([(key, title) for key, title in (
        ("pending", "Pending"), ("put", "Uploaded, awaiting confirmation"), ("done", "Confirmed"),
        ("skipped", "Skipped"), ("failed", "Failed"))], default="pending", required=True, index=True)
    failed_phase = fields.Char()
    size = fields.Integer()
    offset = fields.Integer()
    attempts = fields.Integer()
    error = fields.Char()
    next_retry = fields.Datetime()
    _sql_constraints = [("run_path", "unique(run_id, path)", "A file checkpoint already exists.")]
