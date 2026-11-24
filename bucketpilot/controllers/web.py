import json
import time
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlencode
from uuid import uuid4
from zoneinfo import ZoneInfo

from jinja2 import Environment, FileSystemLoader, select_autoescape
from werkzeug.exceptions import BadRequest, Forbidden, NotFound

from odoo import http
from odoo.http import request

from ..calendar import TIMEZONES
from ..builder import Builder, Conflict, STATUSES, TONES, page_slice, public_id, value_text
from ..models.backup import ACTIVE, human_bytes
from ..storage import BackupError


MODULE_ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = Environment(loader=FileSystemLoader(MODULE_ROOT / "templates"),
                        autoescape=select_autoescape(["html"]))
NAV = {
    "overview": ("/bucketpilot", "Overview", "Your workspace at a glance. Monitor your connection and explore connected storage."),
    "connection": ("/bucketpilot/connection", "Connection", "Manage the secure connection between this Odoo site and your BucketPilot workspace."),
    "buckets": ("/bucketpilot/buckets", "Buckets", "Find the storage bucket you need. Choose a destination when creating a backup."),
    "backups": ("/bucketpilot/backups", "Backups", "Select backup files, choose a destination and review before starting."),
    "schedules": ("/bucketpilot/schedules", "Backup Schedules", "Manage recurring plans, one-time schedules and their execution history."),
    "history": ("/bucketpilot/history", "Backup History", "Follow background jobs and inspect their saved progress and file records."),
}
CONNECTION_PAGES = {"overview", "connection", "buckets"}
STYLES = ["isolation", "dashboard", "table-ui", "display", "connection", "builder", "backup-details", "odoo"]
SCRIPTS = ["bootstrap", "confirmation", "notifications", "ajax-feedback", "connection-context", "table-ui",
           "builder", "backup-progress", "dashboard", "actions", "request-progress"]
NO_CACHE = [("Cache-Control", "private, no-store"), ("X-Content-Type-Options", "nosniff"),
            ("Referrer-Policy", "same-origin")]
EMPTY_ID = "00000000-0000-0000-0000-000000000000"


def asset_urls(directory, names, extension):
    urls = []
    for name in names:
        path = f"static/{directory}/{name}.{extension}"
        digest = sha256((MODULE_ROOT / path).read_bytes()).hexdigest()[:12]
        urls.append(f"/bucketpilot/{path}?v={digest}")
    return urls


STYLE_URLS = asset_urls("css", STYLES, "css")
SCRIPT_URLS = asset_urls("js", SCRIPTS, "js")


def number(value, default, max_value=100000):
    if value is None:
        return default
    if not isinstance(value, str) or not value.isascii() or not value.isdigit() or len(value) > 8:
        raise BackupError("Invalid page or offset.")
    return min(int(value), max_value)


def date_text(stamp, zone="UTC"):
    if not stamp:
        return "—"
    return datetime.fromtimestamp(stamp, timezone.utc).astimezone(ZoneInfo(zone)).strftime("%Y-%m-%d %H:%M")


class BucketPilot(http.Controller):
    def _access(self, admin=False):
        user = request.env.user
        is_admin = user.has_group("base.group_system")
        if not is_admin and (admin or not user.has_group("bucketpilot.group_backup_operator")):
            raise Forbidden()
        builder = Builder(request.env, user.id, user.tz)
        if not is_admin and not builder.sources.custom:
            raise Forbidden()
        return builder, is_admin

    def _safe_context(self, builder, admin):
        context = builder.connection()
        if not admin:
            context.pop("masked", None)
        return context

    def _open_in_odoo(self):
        incoming = request.httprequest
        if incoming.method == "GET" and incoming.headers.get("Sec-Fetch-Dest") == "document":
            path = incoming.full_path.removesuffix("?")
            url = "/odoo/bucketpilot"
            if path != "/bucketpilot":
                url += "?" + urlencode({"bp_page": path})
            return request.redirect(url, code=303)
        return None

    def _page(self, builder, admin, active, template, *, scope="", **values):
        csrf = request.csrf_token()
        options = {
            "bucketpilotBuilder": {"endpoint": "/bucketpilot/api" + (f"/{scope}" if scope else ""),
                                   "editing": scope, "edit": f"/bucketpilot/schedules/{EMPTY_ID}/edit",
                                   "csrf": csrf, "create": "/bucketpilot/backups",
                                   "schedules": "/bucketpilot/schedules", "history": "/bucketpilot/history",
                                   "detail": f"/bucketpilot/history/{EMPTY_ID}"},
            "bucketpilotDisplay": {"tones": TONES},
            "bucketpilotConnection": {"generation": builder.generation(), "site": builder.params.get_param("database.uuid")},
            **values.pop("settings", {}),
        }
        connection = self._safe_context(builder, admin)
        if active == "connection":
            values["connection_message"] = {
                "connected": "Connected. Workspace access was verified.",
                "configured": "A key is stored. Open Overview to verify workspace access.",
                "disconnected": "Disconnected. No API key is stored.",
            }.get(connection["status"], connection.get("message") or connection["label"])
        _, title, description = NAV[active]
        recent = builder.env.ref("bucketpilot.cron_bucketpilot").lastcall
        content = TEMPLATES.get_template("shell.html").render(
            active=active, template=template, title=values.pop("title", title),
            embedded=request.httprequest.headers.get("Sec-Fetch-Dest") in ("iframe", "frame"),
            description=values.pop("description", description), styles=STYLE_URLS, scripts=SCRIPT_URLS,
            logo_url="/bucketpilot/static/description/bucketpilot-logo.svg",
            connection=connection,
            navigation=[dict(url=url, label=label, active=active == key)
                        for key, (url, label, _) in NAV.items() if admin or key not in CONNECTION_PAGES],
            worker_recent=bool(recent and time.time() - recent.replace(tzinfo=timezone.utc).timestamp() < 150),
            settings=options, csrf=csrf, timezones=sorted(TIMEZONES), **values)
        return request.make_response(content, headers=[
            ("Content-Type", "text/html; charset=utf-8"), ("X-Frame-Options", "SAMEORIGIN"),
            ("Content-Security-Policy", "frame-ancestors 'self'"), *NO_CACHE,
        ])

    def _json(self, data, status=200):
        return request.make_json_response(data, headers=NO_CACHE, status=status)

    def _dashboard(self, builder, params):
        page = number(params.get("page"), 0)
        size = number(params.get("size"), 10, 50)
        size = size if size in (10, 25, 50) else 10
        search = value_text(params.get("q", ""), 100)
        snapshot = builder.snapshot(params.get("refresh") == "1")
        rows = snapshot["buckets"]
        matches = [row for row in rows if search.casefold() in " ".join(
            str(row.get(field) or "") for field in ("name", "provider", "region")).casefold()]
        pager = page_slice(matches, page, size)
        return dict(snapshot=snapshot, connection_label=STATUSES[snapshot["status"]], size=size, q=search,
                    total_buckets=len(rows), pages=max(1, (len(matches) + size - 1) // size),
                    stamp=date_text(snapshot.get("updated")), tones=TONES, **pager)

    @http.route(["/bucketpilot", "/bucketpilot/buckets"], auth="user", type="http", methods=["GET"])
    def dashboard(self, **params):
        builder, admin = self._access()
        if redirect := self._open_in_odoo():
            return redirect
        if not admin:
            return request.redirect("/bucketpilot/schedules", code=303)
        active = "buckets" if request.httprequest.path.endswith("/buckets") else "overview"
        try:
            values = self._dashboard(builder, params)
        except BackupError:
            raise BadRequest("Invalid bucket filters.") from None
        return self._page(builder, admin, active, "dashboard.html", buckets_only=active == "buckets", **values)

    @http.route("/bucketpilot/dashboard-data", auth="user", type="http", methods=["GET"])
    def dashboard_data(self, **params):
        builder, _ = self._access(admin=True)
        try:
            values = self._dashboard(builder, params)
        except BackupError as issue:
            return self._json({"error": str(issue)}, 400)
        content = TEMPLATES.get_template("dashboard-results.html").render(**values)
        context = TEMPLATES.get_template("dashboard-context.html").render(
            buckets_only=params.get("view") == "buckets", **values)
        return self._json({"markup": content, "context": context, "status": values["snapshot"]["status"],
                           "label": values["connection_label"],
                           "workspace": values["snapshot"].get("workspace") or "—", "page": values["page"]})

    @http.route("/bucketpilot/connection", auth="user", type="http", methods=["GET", "POST"], max_content_length=16000)
    def connection(self, **params):
        builder, admin = self._access(admin=True)
        if redirect := self._open_in_odoo():
            return redirect
        error = None
        if request.httprequest.method == "POST":
            try:
                with request.env.cr.savepoint():
                    if params.get("operation") == "disconnect" and params.get("confirmed") == "yes":
                        builder.connect("")
                        request.session["bucketpilot_notice"] = "BucketPilot disconnected."
                    elif params.get("operation") == "connect":
                        key = value_text(params.get("api_key"), 4096)
                        if not key:
                            raise BackupError("Enter a BucketPilot API key.")
                        builder.connect(key)
                        request.session["bucketpilot_notice"] = "BucketPilot connection verified."
                    else:
                        raise BackupError("Confirm the connection change.")
                return request.redirect("/bucketpilot/connection", code=303)
            except BackupError as issue:
                error = str(issue)
        ready, recipient = builder.Run._notification_status()
        return self._page(builder, admin, "connection", "connection.html", error=error, email_ready=ready,
                          recipient=recipient, notice=request.session.pop("bucketpilot_notice", None))

    @http.route(["/bucketpilot/backups", "/bucketpilot/schedules/<string:scope>/edit"],
                auth="user", type="http", methods=["GET"])
    def backups(self, scope="", **params):
        builder, admin = self._access()
        if redirect := self._open_in_odoo():
            return redirect
        edit_name = ""
        source_review = False
        if scope:
            try:
                scope = public_id(scope)
                draft = builder.draft(scope, reset=True).config
                edit_name = draft["name"]
                source_review = draft["_source_review"]
            except BackupError:
                raise NotFound() from None
        return self._page(builder, admin, "schedules" if scope else "backups", "builder.html",
                          scope=scope, editing=bool(scope), edit_name=edit_name,
                          source_custom=builder.sources.custom, source_database=builder.sources.database_scope,
                          source_review=source_review,
                          title="Edit backup plan" if scope else "Backups")

    @http.route(["/bucketpilot/schedules", "/bucketpilot/history"], auth="user", type="http", methods=["GET"])
    def records(self, **params):
        builder, admin = self._access()
        if redirect := self._open_in_odoo():
            return redirect
        plans = request.httprequest.path.endswith("/schedules")
        return self._page(builder, admin, "schedules" if plans else "history", "records.html",
                          mode="plans" if plans else "history")

    def _read(self, builder, scope, params):
        action = params.get("action", "state")
        page = number(params.get("page"), 0)
        size = number(params.get("size"), 10, 50)
        if size not in (10, 25, 50):
            raise BackupError("Choose 10, 25 or 50 rows per page.")
        query = value_text(params.get("q", ""), 100).casefold()
        if action == "connection":
            return {"generation": builder.generation()}
        if action == "state":
            return builder.present(builder.draft(scope))
        if action == "files":
            path = params.get("path", "")
            offset = number(params.get("offset"), 0, 50000)
            entries = builder.sources.listing(path)
            if focus := params.get("focus"):
                index = next((index for index, entry in enumerate(entries) if entry["path"] == focus), None)
                if index is not None:
                    offset = index // 100 * 100
            return {"entries": entries[offset:offset + 100], "path": path,
                    "previous": offset - 100 if offset >= 100 else None,
                    "next": offset + 100 if offset + 100 < len(entries) else None}
        if action == "search":
            return builder.search_sources(query, params.get("token"), request.session)
        if action == "buckets":
            snapshot = builder.snapshot()
            rows = [row for row in snapshot["buckets"] if row["id"] and query in " ".join(
                str(row[field] or "") for field in ("name", "provider", "region")).casefold()]
            return page_slice(rows, page, size)
        if action == "destination_check":
            config = builder.draft(scope).config
            if config["bucket"] and config["prefix_saved"]:
                return {"evidence": builder.api().folder_evidence(config["bucket"]["id"], config["prefix"])}
            return {"evidence": "unsaved"}
        if action == "folders":
            return builder.folders(scope, params.get("prefix", ""), page)
        if action in ("plans", "history"):
            return builder.records(action, query, page, size, params)
        if action == "plan":
            return builder.plan_row(builder.plan(params.get("id")))
        if action == "run":
            return builder.run_row(builder.run(params.get("id")))
        raise BackupError("Unknown builder action.")

    @http.route(["/bucketpilot/api", "/bucketpilot/api/<string:scope>"], auth="user", type="http",
                methods=["GET", "POST"], csrf=False, max_content_length=100000)
    def api(self, scope="", **params):
        builder, _ = self._access()
        try:
            with request.env.cr.savepoint():
                if scope:
                    scope = public_id(scope)
                    builder.plan(scope)
                if request.httprequest.method == "POST":
                    if not request.validate_csrf(request.httprequest.headers.get("X-CSRF-Token")):
                        return self._json({"error": "Reload the page and try again."}, 403)
                    data = request.httprequest.get_data()
                    if len(data) > 100000:
                        return self._json({"error": "Request is too large."}, 413)
                    try:
                        body = json.loads(data)
                    except (ValueError, RecursionError):
                        return self._json({"error": "Invalid builder command."}, 400)
                    result = builder.command(body, scope)
                else:
                    result = self._read(builder, scope, params)
        except Conflict as issue:
            return self._json({"error": str(issue)}, 409)
        except BackupError as issue:
            return self._json({"error": str(issue)}, 422)
        return self._json(result)

    def _progress(self, builder, run):
        record = builder.run_row(run)
        active = run.state in ACTIVE
        total, processed = record["total_files"], record["processed_files"]
        label = run.state.replace("_", " ").capitalize()
        headlines = {"pending": "This saved request is waiting for the Odoo scheduled action.",
                     "queued": "This backup is queued.", "scanning": "Discovering permitted source files.",
                     "running": f"{processed} of {total} files processed."}
        notice = "Finished without uploading any files." if run.state == "completed" and not record["successful"] else ""
        headline = headlines.get(run.state, f"{label} · {processed} of {total} files processed.")
        return dict(record, name=run.name, tone=TONES.get(run.state, "neutral"), status_label=label, active=active,
                    resumable=run.state in ("failed", "cancelled"), headline=headline, notice=notice,
                    summary=f"{record['successful']} confirmed · {record['failed']} failed · {record['skipped']} skipped",
                    total=total, percentage=processed * 100 / total if total and run.state != "scanning" else None)

    @http.route("/bucketpilot/history/<string:run_id>", auth="user", type="http", methods=["GET"])
    def detail(self, run_id, **params):
        builder, admin = self._access()
        if redirect := self._open_in_odoo():
            return redirect
        try:
            run = builder.run(run_id)
            page = number(params.get("page"), 0)
        except BackupError:
            raise NotFound() from None
        progress = self._progress(builder, run)
        rules = run.config["rules"]
        zone = run.config["schedule"]["timezone"]
        route = f"/bucketpilot/history/{run.public_id}"
        progress.update(bucket=run.config["bucket"]["name"], provider=run.config["bucket"]["provider"],
                        timezone=zone, source_count=len(rules),
                        sources=[(group, [rule for rule in rules if rule["include"] == include])
                                 for group, include in (("included", True), ("excluded", False))],
                        dates={key: date_text(progress[key], zone) for key in ("created", "started", "completed", "activity")},
                        processed_bytes=human_bytes(progress["processed_bytes"]))
        links = dict(history="/bucketpilot/history", cancel=route + "/cancel", resume=route + "/resume",
                     refresh=route + (f"?page={page}" if page else ""))
        settings = {"bucketpilotBackupProgress": route + "/progress", "bucketpilotBackupTimezone": zone}
        if progress["waiting"]:
            progress["next_retry_date"] = date_text(progress["next_attempt"])
            return self._page(builder, admin, "history", "backup-request.html", title="Backup request details",
                              links=links, backup=progress, route=route, settings=settings)
        domain = [("run_id", "=", run.id), ("kind", "=", "file")]
        total = builder.Item.search_count(domain)
        page = min(page, max(0, (total - 1) // 25))
        items = builder.Item.search(domain, limit=25, offset=25 * page, order="id")
        return self._page(builder, admin, "history", "backup-detail.html", title="Backup details",
                          links=links, backup=progress, items=items, page=page, total=total, route=route,
                          human_bytes=human_bytes, settings=settings)

    @http.route("/bucketpilot/history/<string:run_id>/progress", auth="user", type="http", methods=["GET"])
    def progress(self, run_id, **params):
        builder, _ = self._access()
        try:
            return self._json(self._progress(builder, builder.run(run_id)))
        except BackupError:
            return self._json({"error": "This backup is unavailable."}, 404)

    @http.route("/bucketpilot/history/<string:run_id>/<string:operation>", auth="user", type="http",
                methods=["GET", "POST"])
    def run_action(self, run_id, operation, **params):
        builder, admin = self._access()
        if redirect := self._open_in_odoo():
            return redirect
        if operation not in ("cancel", "resume"):
            raise NotFound()
        try:
            run = builder.run(run_id)
        except BackupError:
            raise NotFound() from None
        error = None
        if request.httprequest.method == "POST":
            try:
                with request.env.cr.savepoint():
                    builder.command({"operation": operation, "request_id": params.get("request_id"),
                                     "revision": 0, "input": {"id": run_id, "confirmed": params.get("confirmed") == "yes"}})
                return request.redirect(f"/bucketpilot/history/{run.public_id}", code=303)
            except BackupError as issue:
                error = str(issue)
        return self._page(builder, admin, "history", "confirm.html", title="Confirm backup action", error=error,
                          operation=operation, run=run, request_id=str(uuid4()))
