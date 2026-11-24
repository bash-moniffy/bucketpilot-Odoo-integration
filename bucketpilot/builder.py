import copy
import json
import re
import time
from collections import deque
from datetime import datetime
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from odoo import fields

from .calendar import TIMEZONES, next_run, normalize
from .models.backup import ACTIVE, TERMINAL, timestamp
from .storage import BackupError, BucketPilotAPI, Credential, Sources, destination, fingerprint, safe_label, selected


STATUSES = {
    "connected": "Connected", "configured": "Key configured", "disconnected": "Disconnected",
    "error": "Needs attention", "limited": "Directory limit reached",
}
TONES = {
    "connected": "success", "ready": "success", "active": "success", "completed": "success", "done": "success",
    "pending": "info", "queued": "info", "scanning": "info", "running": "info", "configured": "info",
    "paused": "warning", "completed_with_errors": "warning", "limited": "warning", "indexing": "info",
    "error": "danger", "failed": "danger", "disconnected": "danger",
}


class Conflict(BackupError):
    pass


def public_id(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise BackupError("Choose a valid backup record.") from None


def value_text(value, limit=120):
    if not isinstance(value, str) or len(value) > limit or re.search(r"[\x00-\x1f\x7f]", value):
        raise BackupError("Enter a valid value.")
    return value.strip()


def page_slice(rows, page, size):
    total = len(rows)
    page = min(page, max((total - 1) // size, 0))
    return {"rows": rows[page * size:(page + 1) * size], "total": total, "page": page}


class Builder:
    def __init__(self, env, uid, zone):
        self.env = env(user=1, su=True)
        self.uid = uid
        self.zone = zone if zone in TIMEZONES else "UTC"
        self.params = self.env["ir.config_parameter"]
        self.store = Credential(self.env.cr.dbname)
        self.sources = Sources(self.env.cr.dbname)
        self.Plan = self.env["bucketpilot.plan"]
        self.Run = self.env["bucketpilot.run"]
        self.Item = self.env["bucketpilot.item"]

    def api(self):
        return BucketPilotAPI(self.store.read())

    def connection_lock(self, exclusive=False):
        if exclusive:
            self.env.cr.execute("SELECT pg_advisory_xact_lock(hashtext('bucketpilot.connection'))")
        else:
            self.env.cr.execute("SELECT pg_advisory_xact_lock_shared(hashtext('bucketpilot.connection'))")

    def generation(self):
        return int(self.params.get_param("bucketpilot.generation", "0"))

    def _meta(self, data, key):
        return {"workspace": safe_label(data["workspace"].get("name"), key),
                "type": safe_label(data["workspace"].get("type"), key),
                "plan": safe_label(data.get("plan"), key),
                "rate": safe_label((data.get("rateLimit") or {}).get("requestsPerMinute"), key)
                if isinstance(data.get("rateLimit"), dict) else None,
                "key_name": safe_label((data.get("key") or {}).get("name"), key)
                if isinstance(data.get("key"), dict) else None}

    def connect(self, key):
        self.connection_lock(exclusive=True)
        previous = self.store.read()
        if key:
            client = BucketPilotAPI(key)
            meta = self._meta(client.me(), key)
            self.params.set_param("bucketpilot.context", json.dumps({"status": "connected", **meta}))
        else:
            self.params.set_param("bucketpilot.context", False)
        if previous != key:
            self.store.replace(key)
            self.params.set_param("bucketpilot.generation", self.generation() + 1)
            self.params.set_param("bucketpilot.snapshot", False)

    def connection(self):
        try:
            key = self.store.read()
        except BackupError as issue:
            return {"status": "error", "message": str(issue), "label": STATUSES["error"], "tone": TONES["error"],
                    "storage_unavailable": True}
        if not key:
            result = {"status": "disconnected", "message": "Connect an API key to view your workspace and buckets."}
        else:
            stored = json.loads(self.params.get_param("bucketpilot.context", "{}"))
            result = {"status": "configured", **stored}
            result["masked"] = key[:5] + "•" * 16 + key[-4:] if len(key) > 9 else "•" * 12
        result["label"] = STATUSES.get(result["status"], "Needs attention")
        result["tone"] = TONES.get(result["status"], "neutral")
        return result

    def snapshot(self, refresh=False):
        context = self.connection()
        if context["status"] == "disconnected" or context.get("storage_unavailable"):
            return {**context, "buckets": []}
        now = time.time()
        cache = json.loads(self.params.get_param("bucketpilot.snapshot", "{}"))
        key = self.store.read()
        signature = fingerprint(key)
        if cache.get("signature") == signature:
            minimum = cache.get("delay", 5) if refresh else max(cache.get("delay", 0), 60 if cache["status"] == "connected" else 15)
            if now - cache["updated"] < minimum:
                return cache
        self.connection_lock()
        client = self.api()
        try:
            details = self._meta(client.me(), client.key)
            rows = client.buckets()
            status = "connected"
            message = "Your BucketPilot workspace is connected."
            delay = 5
        except BackupError as issue:
            details = {name: context.get(name) for name in ("workspace", "type", "plan", "rate", "key_name")}
            rows = []
            status = "limited" if issue.code == "limited" else "error"
            message = str(issue)
            delay = max(15, issue.delay)
        context = dict(details, status=status, message=message)
        cache = dict(context, buckets=rows, signature=fingerprint(client.key), updated=int(now), delay=delay)
        self.params.set_param("bucketpilot.context", json.dumps(context))
        self.params.set_param("bucketpilot.snapshot", json.dumps(cache))
        return cache

    def _record(self, model, value, domain=()):
        row = model.search([("public_id", "=", public_id(value)), *domain], limit=1)
        if not row:
            raise BackupError("This backup record is unavailable.")
        return row

    def plan(self, value):
        return self._record(self.Plan, value, [("deleted", "=", False)])

    def run(self, value):
        return self._record(self.Run, value, [("archived", "=", False)])

    def defaults(self):
        clock = datetime.now(ZoneInfo(self.zone)).strftime("%H:%M")
        return dict(name="", bucket=None, prefix="", prefix_saved=False, destination_mode="manual", rules=[],
                    source_binding=self.sources.binding,
                    schedule=dict(frequency="", timezone=self.zone, time=clock, weekday=1, monthday=1, date=""))

    def editable(self, plan):
        frequency = plan.config["schedule"]["frequency"]
        return frequency not in ("now", "once") or (frequency == "once" and not plan.last_date)

    def edit_defaults(self, plan):
        if not self.editable(plan):
            raise BackupError("This one-time plan already has a saved execution.")
        data = {**copy.deepcopy(plan.config), "plan_id": plan.public_id, "plan_revision": plan.revision, "_edit_dirty": False}
        data["_source_review"] = data.get("source_binding") != self.sources.binding
        if data["_source_review"]:
            data.update(rules=[], source_binding=self.sources.binding)
        return data

    def draft(self, scope="", reset=False):
        self.env.cr.execute("SELECT pg_advisory_xact_lock(hashtext('bucketpilot.draft'), %s)", [self.uid])
        model = self.env["bucketpilot.draft"]
        scope_key = scope or "create"
        row = model.search([("owner_id", "=", self.uid), ("scope", "=", scope_key)], limit=1)
        generation = self.generation()
        if not row or reset or row.generation != generation:
            data = self.edit_defaults(self.plan(scope)) if scope else self.defaults()
            if row:
                row.write({"config": data, "generation": generation, "revision": row.revision + 1})
            else:
                row = model.create({"owner_id": self.uid, "scope": scope_key, "config": data,
                                    "generation": generation})
        elif row.config.get("source_binding") != self.sources.binding:
            data = {**row.config, "rules": [], "source_binding": self.sources.binding}
            row.write({"config": data, "revision": row.revision + 1})
        return row

    def present(self, row, extra=None):
        config = row.config
        schedule = config["schedule"]
        valid = bool(schedule["frequency"] and
                     (schedule["frequency"] == "now" or next_run(schedule, fields.Datetime.now())))
        return {"connection_generation": row.generation, "revision": row.revision, "data": config,
                "validity": {"schedule": valid, "name": bool(config["name"])}, **(extra or {})}

    def _write_plan(self, row, config, scope):
        if not all((config["name"], config["bucket"], config["prefix_saved"],
                    any(rule["include"] for rule in config["rules"]))):
            raise BackupError("Complete all five steps before saving the backup.")
        schedule = normalize(config["schedule"])
        when = next_run(schedule, fields.Datetime.now())
        if schedule["frequency"] != "now" and not when:
            raise BackupError("Choose a future date and time.")
        self.sources.verify(config)
        for rule in config["rules"]:
            with self.sources.opened(rule["path"], rule["directory"]):
                pass
        client = self.api()
        bucket = client.bucket(config["bucket"]["id"])
        if bucket["provider"] not in ("aws", "r2", "gcs"):
            raise BackupError("This provider is unavailable for backups.")
        if config["destination_mode"] == "browser" and client.folder_evidence(bucket["id"], config["prefix"]) == "not_found_in_listing":
            raise BackupError("Choose an available folder or use a manual destination path.")
        capability = (config["prefix"] + "/" if config["prefix"] else "") + "capability-check"
        if not isinstance(client.presign(bucket["id"], capability), str):
            raise BackupError("The selected connection does not provide write access.")
        config = {key: config[key] for key in ("name", "bucket", "prefix", "prefix_saved", "destination_mode", "rules", "schedule", "source_binding")}
        config.update(bucket=bucket, schedule=schedule)
        changes = {"name": config["name"], "config": config, "credential": fingerprint(client.key),
                   "identity": client.identity(bucket), "next_date": when or False, "hold": False}
        response = {}
        if scope:
            plan = self.plan(scope)
            self._lock_plan(plan, config_revision=row.config["plan_revision"])
            if not self.editable(plan):
                raise BackupError("This one-time plan already has a saved execution.")
            self._bound(plan, client)
            if schedule["frequency"] == "now":
                raise BackupError("Use Run Now on the schedule to request another execution.")
            changes["next_date"] = False if plan.paused else when
            plan.write({**changes, "revision": plan.revision + 1})
            new_data = self.edit_defaults(plan)
        else:
            plan = self.Plan.create(changes)
            new_data = self.defaults()
            if schedule["frequency"] == "now":
                run = plan._reserve("manual")
                response["submission"] = {"id": run.public_id, "plan_id": plan.public_id}
        if "submission" not in response:
            response["schedule_saved"] = {"id": plan.public_id, "name": plan.name}
        return new_data, response

    def _path(self, config, data):
        if not config["bucket"]:
            raise BackupError("Choose a bucket first.")
        prefix = destination(data.get("prefix"))
        mode = data.get("mode")
        if mode not in ("manual", "browser"):
            raise BackupError("Choose a destination mode.")
        if mode == "browser" and self.api().folder_evidence(config["bucket"]["id"], prefix) == "not_found_in_listing":
            raise BackupError("The folder could not be verified. Browse again or enter its path manually.")
        config.update(prefix=prefix, prefix_saved=True, destination_mode=mode)

    def _selection(self, config, data):
        changes = data.get("changes")
        if not isinstance(changes, list) or len(changes) > 100:
            raise BackupError("Select up to 100 source rules at a time.")
        self.sources.verify(config)
        rules = config["rules"]
        for change in changes:
            if not isinstance(change, dict) or type(change.get("include")) is not bool or type(change.get("directory")) is not bool:
                raise BackupError("Invalid source selection.")
            path = change.get("path")
            with self.sources.opened(path, change["directory"]):
                pass
            rules = [rule for rule in rules if path and rule["path"] != path and not rule["path"].startswith(path + "/")]
            if selected(rules, path) != change["include"]:
                rules.append({key: change[key] for key in ("path", "directory", "include")})
        if len(rules) > 100:
            raise BackupError("A backup supports up to 100 source rules.")
        config["rules"] = rules

    def _folder(self, config, data):
        if not config["bucket"] or data.get("confirmed") is not True:
            raise BackupError("Confirm creating a folder in the selected bucket.")
        parent = destination(data.get("parent"))
        name = destination(data.get("name"))
        if not name or "/" in name:
            raise BackupError("Enter one folder name without slashes.")
        path = destination(f"{parent}/{name}" if parent else name)
        self.api().create_folder(config["bucket"]["id"], parent + "/" if parent else "", name)
        return path

    def _draft_write(self, operation, revision, data, scope):
        row = self.draft(scope)
        if row.revision != revision:
            raise Conflict("The saved draft changed. Reload the draft before continuing.")
        config = copy.deepcopy(row.config)
        extra = {}
        if operation == "name":
            config["name"] = value_text(data.get("name"))
        elif operation == "timing":
            schedule = normalize(data.get("schedule"))
            if schedule["frequency"] == "once" and not next_run(schedule, fields.Datetime.now()):
                raise BackupError("Choose a future date and time.")
            config.update(schedule=schedule, name=value_text(data.get("name")), _frequency_chosen=True)
        elif operation == "selection":
            self._selection(config, data)
        elif operation == "bucket":
            bucket = self.api().bucket(value_text(data.get("id"), 512))
            if (config.get("bucket") or {}).get("id") != bucket["id"]:
                config.update(prefix_saved=False, prefix="", destination_mode="manual")
            config["bucket"] = bucket
        elif operation == "path":
            self._path(config, data)
        elif operation == "folder":
            extra["created_folder"] = self._folder(config, data)
        elif operation in ("clear", "reset"):
            if data.get("confirmed") is not True:
                raise BackupError("Confirm this change.")
            if operation == "clear":
                config["rules"] = []
            else:
                config = self.edit_defaults(self.plan(scope)) if scope else self.defaults()
        elif operation == "commit":
            config, extra = self._write_plan(row, config, scope)
        else:
            raise BackupError("Unknown builder operation.")
        if scope and operation not in ("reset", "commit"):
            config["_edit_dirty"] = True
        row.write({"revision": row.revision + 1, "config": config})
        return self.present(row, extra)

    def _bound(self, plan, client=None):
        client = client or self.api()
        if fingerprint(client.key) != plan.credential:
            raise BackupError("Restore the original API key to continue.")
        bucket = client.bucket(plan.config["bucket"]["id"])
        if client.identity(bucket) != plan.identity:
            raise BackupError("Original workspace or bucket settings no longer match.")
        return client

    def _lock_plan(self, plan, config_revision):
        self.env.cr.execute("SELECT id FROM bucketpilot_plan WHERE id = %s FOR UPDATE", [plan.id])
        plan.invalidate_recordset()
        if plan.deleted or plan.revision != config_revision:
            raise Conflict("The saved plan changed. Reload the schedules before continuing.")

    def _plan_action(self, operation, revision, data):
        plan = self.plan(data.get("id"))
        self._lock_plan(plan, revision)
        now = fields.Datetime.now()
        frequency = plan.config["schedule"]["frequency"]
        if operation == "run":
            if frequency in ("now", "once"):
                raise BackupError("This plan describes a single execution.")
            self.sources.verify(plan.config)
            if plan.hold:
                raise BackupError("Restore the original connection before requesting a backup.")
            self._bound(plan)
            if self.Run.search_count([("plan_id", "=", plan.id), ("state", "in", ACTIVE)]):
                raise BackupError("This plan already has a backup in progress.")
            run = plan._reserve("manual")
            return {"run_id": run.public_id}
        if operation in ("pause", "resume") and not self.editable(plan):
            raise BackupError("This one-time plan already has a saved execution.")
        if operation == "resume":
            self.sources.verify(plan.config)
            self._bound(plan)
            when = next_run(plan.config["schedule"], now)
            if frequency == "once" and not when:
                raise BackupError("Edit the plan and choose a future time before resuming.")
            plan.write({"paused": False, "hold": False, "next_date": when or False})
        elif operation in ("pause", "delete"):
            plan.write({"paused": True, "deleted": operation == "delete", "next_date": False})
            for queued in self.Run.search([("plan_id", "=", plan.id), ("state", "in", ("pending", "queued")),
                                           ("execution_type", "=", "scheduled")]):
                self.env.cr.execute("SELECT id FROM bucketpilot_run WHERE id = %s FOR UPDATE", [queued.id])
                queued.invalidate_recordset()
                if queued.state in ("pending", "queued"):
                    queued._set_terminal("cancelled")
        else:
            raise BackupError("Unknown plan operation.")
        plan.revision += 1
        return {}

    def _run_action(self, operation, data):
        run = self.run(data.get("id"))
        if operation == "retry_run":
            plan = run.plan_id
            if not plan:
                raise BackupError("The original backup plan is unavailable.")
            self.env.cr.execute("SELECT id FROM bucketpilot_plan WHERE id = %s FOR UPDATE", [plan.id])
        self.env.cr.execute("SELECT id FROM bucketpilot_run WHERE id = %s FOR UPDATE", [run.id])
        run.invalidate_recordset()
        if run.archived:
            raise BackupError("This backup record is unavailable.")
        if operation == "cancel" and run.state in ACTIVE:
            run._set_terminal("cancelled")
            return {}
        if operation == "resume" and run.state in ("cancelled", "failed"):
            if run.plan_id and self.Run.search_count([("plan_id", "=", run.plan_id.id), ("state", "in", ACTIVE)]):
                raise BackupError("This plan already has a backup in progress.")
            self.sources.verify(run.config)
            self._bound(run)
            failed = self.Item.search([("run_id", "=", run.id), ("state", "=", "failed")])
            for item in failed:
                item.write({"state": item.failed_phase or "pending", "error": False, "attempts": 0, "next_retry": False})
            run.write({"state": "scanning" if run.started else "pending", "finished": False, "error": False,
                       "next_retry": False, "attempts": 0, "scan_errors": 0, "notification_sent": False})
            return {}
        if operation == "retry_run" and run.state in ("failed", "cancelled", "completed_with_errors"):
            self.sources.verify(run.config)
            self._bound(run)
            if self.Run.search_count([("plan_id", "=", plan.id), ("state", "in", ACTIVE)]):
                raise BackupError("This plan already has a backup in progress.")
            return {"run_id": plan._reserve("manual", run).public_id}
        raise BackupError("This operation is unavailable for the current execution status.")

    def _clear_history(self):
        runs = self.Run.search([("archived", "=", False), ("state", "in", TERMINAL)], order="id", limit=101)
        for run in runs[:100]:
            self.env.cr.execute("SELECT id FROM bucketpilot_run WHERE id = %s FOR UPDATE", [run.id])
            run.invalidate_recordset()
            if run.state in TERMINAL and not run.archived:
                if not run.notification_sent:
                    run._queue_email()
                self.Item.search([("run_id", "=", run.id)]).unlink()
                run.write({"archived": True, "config": {"archived": True}, "credential": False, "identity": False, "error": False,
                           "name": "Archived execution", "started": False, "scan_errors": 0})
        return {"deleted": len(runs[:100]), "more": len(runs) > 100}

    def command(self, command, scope=""):
        if not isinstance(command, dict):
            raise BackupError("Invalid builder command.")
        request_id = public_id(command.get("request_id"))
        operation, revision, data = command.get("operation"), command.get("revision"), command.get("input")
        if not isinstance(operation, str) or type(revision) is not int or not isinstance(data, dict):
            raise BackupError("Invalid builder command.")
        self.connection_lock()
        self.env.cr.execute("SELECT pg_advisory_xact_lock(hashtext('bucketpilot.draft'), %s)", [self.uid])
        receipts = self.env["bucketpilot.command"]
        receipt = receipts.search([("owner_id", "=", self.uid), ("request_id", "=", request_id)], limit=1)
        generation = self.generation()
        if receipt:
            if receipt.generation != generation:
                raise Conflict("The connection changed. Reload before continuing.")
            return receipt.result.get("payload", receipt.result)
        if operation.startswith("plan_") or operation in ("clear_history", "retry_run", "cancel", "resume"):
            if scope or data.get("confirmed") is not True:
                raise BackupError("Confirm this backup operation.")
            if operation.startswith("plan_"):
                result = self._plan_action(operation[5:], revision, data)
            elif operation == "clear_history":
                result = self._clear_history()
            else:
                result = self._run_action(operation, data)
        else:
            result = self._draft_write(operation, revision, data, scope)
        receipts.create({"owner_id": self.uid, "request_id": request_id, "generation": generation, "result": {"payload": result}})
        return result

    def folders(self, scope, prefix, page):
        config = self.draft(scope).config
        bucket = config["bucket"]
        message = "Folder browsing is not ready. Enter a path manually or create a folder."
        if not bucket:
            return {"folders": [], "message": message, "available": False, "more": False}
        client = self.api()
        live = client.bucket(bucket["id"])
        if live["indexStatus"] != "ready":
            return {"folders": [], "message": message, "available": False, "more": False}
        prefix = destination(prefix)
        prefix = prefix + "/" if prefix else ""
        result = client.objects(bucket["id"], prefix, page + 1)
        folders = {}
        for row in result["objects"]:
            key = row.get("key") if isinstance(row, dict) else None
            if isinstance(key, str) and key.startswith(prefix) and "/" in key[len(prefix):]:
                try:
                    path = destination(prefix + key[len(prefix):].split("/", 1)[0])
                except BackupError:
                    continue
                if path:
                    folders[path] = None
        return {"folders": list(folders), "message": "Latest available indexed folder listing.",
                "available": True, "more": result["totalCount"] > (page + 1) * 50}

    def search_sources(self, query, token, session):
        query = query.casefold()
        saved = session.get("bucketpilot_file_search") or {}
        if token and (saved.get("token") != token or saved.get("query") != query or saved.get("uid") != self.uid or
                      saved.get("source_binding") != self.sources.binding):
            raise BackupError("This source search expired. Run it again.")
        if not token:
            token = str(uuid4())
            saved = {"token": token, "query": query, "uid": self.uid, "pending": [["", 0]],
                     "matches": [], "pages_checked": 0, "skipped": 0, "source_binding": self.sources.binding}
        pending = deque(saved["pending"])
        started = time.monotonic()
        while pending and time.monotonic() - started < 2 and saved["pages_checked"] < 200 and len(saved["matches"]) < 500:
            path, offset = pending.popleft()
            saved["pages_checked"] += 1
            try:
                entries = self.sources.listing(path)
            except BackupError:
                saved["skipped"] += 1
                continue
            for item in entries[offset:offset + 100]:
                if query in item["path"].casefold():
                    saved["matches"].append(item)
                if item["directory"] and len(pending) < 2000:
                    pending.append([item["path"], 0])
            if len(entries) > offset + 100:
                pending.appendleft([path, offset + 100])
        limited = bool(pending and (saved["pages_checked"] >= 200 or len(saved["matches"]) >= 500))
        saved["pending"] = list(pending)
        session["bucketpilot_file_search"] = saved
        ordered = sorted(saved["matches"], key=lambda item: (not item["directory"], item["path"].casefold()))
        return {"entries": ordered[:500], "done": not pending or limited, "limited": limited, "token": token,
                "pages_checked": saved["pages_checked"], "skipped": saved["skipped"]}

    def plan_row(self, plan):
        recent = self.Run.search([("plan_id", "=", plan.id)], order="requested desc, id desc", limit=5)
        runs = [{"status": run.state, "execution_type": run.execution_type, "created": timestamp(run.requested)} for run in recent]
        frequency = plan.config["schedule"]["frequency"]
        source_changed = plan.config.get("source_binding") != self.sources.binding
        reason = "source_changed" if source_changed else plan.hold
        if (source_changed and self.editable(plan)) or plan.paused or plan.hold:
            status = "paused"
        elif frequency in ("now", "once") and recent:
            status = recent[0].state
        else:
            status = "active"
        actions = []
        if source_changed:
            if self.editable(plan):
                actions.append("edit")
        elif not plan.hold:
            if self.editable(plan):
                actions.extend(("edit", "resume" if plan.paused else "pause"))
            if frequency not in ("now", "once") and not any(run.state in ACTIVE for run in recent):
                actions.append("run")
        return {"id": plan.public_id, "name": plan.name, "revision": plan.revision, "frequency": frequency,
                "data": plan.config, "config": plan.config, "bucket_label": plan.config["bucket"]["name"],
                "destination": plan.config["prefix"] or "/", "status": status, "pause_reason": reason or "",
                "next_run": timestamp(plan.next_date), "last_run": timestamp(plan.last_date),
                "recent_runs": runs, "latest_execution": runs[0] if runs else None, "actions": actions}

    def run_row(self, run):
        waiting = None
        if not run.started and run.state in ACTIVE:
            waiting = {"label": "Waiting for connection" if run.plan_id.hold else "Waiting for the worker",
                       "message": run.error or "The Odoo scheduled action will pick up this saved request.",
                       "next_attempt": timestamp(run.next_retry)}
        return {"id": run.public_id, "data": run.config, "plan_id": run.plan_public_id,
                "plan_name": run.name, "status": run.state, "bucket_label": run.config["bucket"]["name"],
                "prefix": run.prefix or run.config["prefix"] or "/", "has_job": bool(run.started),
                "waiting": waiting, "next_attempt": timestamp(run.next_retry), "error": run.error or "", "execution_type": run.execution_type,
                "created": timestamp(run.requested), "started": timestamp(run.started), "completed": timestamp(run.finished),
                "activity": timestamp(run.write_date), **run._summary()}

    def records(self, mode, query, page, size, params):
        status = params.get("status", "")
        if mode == "plans":
            domain = [("deleted", "=", False)]
            if params.get("saved"):
                domain.append(("public_id", "=", public_id(params["saved"])))
            rows = [self.plan_row(row) for row in self.Plan.search(domain)]
            if query:
                rows = [row for row in rows if query in " ".join(str(row[key]) for key in ("name", "id", "bucket_label", "destination")).casefold()]
            if status:
                rows = [row for row in rows if row["status"] == status]
            key = params.get("sort", "next_run")
            key = key if key in ("next_run", "name", "last_run", "status") else "next_run"
            rows.sort(key=lambda row: (row[key].casefold() if isinstance(row[key], str) else row[key], row["name"].casefold()),
                      reverse=params.get("direction") == "desc")
            return page_slice(rows, page, size)
        domain = [("archived", "=", False)]
        if status:
            domain.append(("state", "=", status))
        runs = self.Run.search(domain, order="requested desc, id desc")
        if query:
            runs = runs.filtered(lambda row: query in " ".join(map(str, (row.name, row.public_id,
                row.config["bucket"]["name"], row.prefix or row.config["prefix"]))).casefold())
        total = len(runs)
        page = min(page, max((total - 1) // size, 0))
        return {"rows": [self.run_row(run) for run in runs[page * size:(page + 1) * size]],
                "total": total, "page": page}
