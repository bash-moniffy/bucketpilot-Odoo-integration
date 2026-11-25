import base64
import fnmatch
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import time
import zlib
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4
from urllib.parse import parse_qs, quote, urlsplit

import requests
from odoo.tools import config


class BackupError(Exception):
    def __init__(self, message, code="invalid", delay=0):
        super().__init__(message)
        self.code = code
        self.delay = delay


def stream_digest(stream, algorithm):
    digest = hashlib.new(algorithm)
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    stream.seek(0)
    return digest.hexdigest()


class Credential:
    def __init__(self, database):
        base = Path(os.environ.get("BUCKETPILOT_SECRET_DIRECTORY") or Path(config["data_dir"]) / "bucketpilot-secrets")
        self.directory = base / hashlib.sha256(database.encode()).hexdigest()
        self.path = self.directory / "api-key"

    def read(self):
        try:
            with os.fdopen(os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW), "r", encoding="ascii") as stream:
                entry = os.fstat(stream.fileno())
                if entry.st_uid != os.geteuid() or entry.st_mode & 0o077 or not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1:
                    raise BackupError("BucketPilot credential file permissions are invalid.")
                return stream.read(4097).strip()
        except FileNotFoundError:
            return ""
        except (OSError, UnicodeError):
            raise BackupError("BucketPilot credential storage is unavailable.") from None

    def replace(self, key):
        try:
            self._replace(key)
        except OSError:
            raise BackupError("BucketPilot credential storage is unavailable.") from None

    def _replace(self, key):
        if not key:
            self.path.unlink(missing_ok=True)
            return
        self.directory.mkdir(parents=True, mode=0o700, exist_ok=True)
        if self.directory.is_symlink() or self.directory.stat().st_mode & 0o077 or self.directory.stat().st_uid != os.geteuid():
            raise BackupError("BucketPilot requires an owner-only credential directory.")
        fd, staging = tempfile.mkstemp(dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as stream:
                stream.write(key)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(staging, self.path)
        finally:
            Path(staging).unlink(missing_ok=True)


def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest() if value else ""


def safe_label(value, key=""):
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, (str, int, float)):
        label = str(value)
        return "—" if key and key in label else label[:512]
    return None


def destination(value):
    if not isinstance(value, str):
        raise BackupError("Choose a valid destination path.")
    value = value.strip(" \t\r\n/")
    if len(value.encode()) > 140 or re.search(r"[\x00-\x1f\x7f\\?#]", value):
        raise BackupError("Use a destination path of up to 140 bytes without control characters, backslashes, ? or #.")
    parts = re.split("/+", value) if value else []
    if any(part in (".", "..") or not part.strip() for part in parts):
        raise BackupError("Destination paths cannot contain empty, . or .. segments.")
    return "/".join(parts)


class BucketPilotAPI:
    base = "https://bucketpilot.io/api/v1/"
    bucket_fields = ("id", "name", "provider", "region", "awsBucketName", "objectCount",
                     "totalSizeBytes", "indexStatus", "indexedObjectCount", "lastIndexedAt", "createdAt")

    def __init__(self, key):
        if not key or not re.fullmatch(r"[!-~]{1,4096}", key):
            raise BackupError("Connect a valid BucketPilot API key first.", "connection_changed")
        self.key = key

    def request(self, endpoint, *, params=None, body=None, empty=False):
        try:
            with requests.Session() as session:
                session.trust_env = False
                response = session.request("GET" if body is None else "POST", self.base + endpoint,
                                           params=params, json=body, headers={"Authorization": f"Bearer {self.key}",
                                           "Accept": "application/json"}, stream=True,
                                           timeout=(5, 15), allow_redirects=False)
                with response:
                    status = response.status_code
                    retry = response.headers.get("Retry-After", "")
                    if status == 429 or status >= 500:
                        raise BackupError("BucketPilot is temporarily unavailable or rate limited.", "temporary",
                                          min(int(retry), 86400) if retry.isdigit() and len(retry) < 10 else 0)
                    if status == 404:
                        raise BackupError("The requested storage entry was not found.", "missing")
                    if status in (401, 403):
                        raise BackupError("BucketPilot rejected access. Check the key, plan and bucket permissions.", "access")
                    if status not in (200, 201, 204):
                        raise BackupError(f"BucketPilot rejected the request (HTTP {status}).")
                    if empty:
                        return {}
                    chunks = bytearray()
                    for chunk in response.iter_content(65536):
                        chunks.extend(chunk)
                        if len(chunks) > 12_000_000:
                            raise BackupError("BucketPilot returned a response that exceeds the supported size.")
                    result = json.loads(chunks)
        except requests.RequestException:
            raise BackupError("BucketPilot could not be reached. Try again later.", "temporary") from None
        except (ValueError, RecursionError):
            raise BackupError("BucketPilot returned invalid data.") from None
        if not isinstance(result, dict):
            raise BackupError("BucketPilot returned invalid data.")
        return result

    def me(self):
        data = self.request("me")
        if not isinstance(data.get("workspace"), dict):
            raise BackupError("BucketPilot returned invalid workspace information.")
        return data

    def bucket_row(self, data):
        return {field: safe_label(data.get(field), self.key) for field in self.bucket_fields}

    def buckets(self):
        rows = self.request("buckets").get("buckets")
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise BackupError("BucketPilot returned an invalid bucket list.")
        if len(rows) > 5000:
            raise BackupError("This workspace has more than 5,000 buckets. Browse the complete list in BucketPilot.", "limited")
        return [self.bucket_row(row) for row in rows]

    def endpoint(self, bucket, suffix=""):
        if bucket in ("", ".", ".."):
            raise BackupError("Choose a valid bucket.")
        return "buckets/" + quote(str(bucket), safe="") + suffix

    def bucket(self, bucket_id):
        result = self.request(self.endpoint(bucket_id))
        row = result.get("bucket", result)
        if not isinstance(row, dict) or str(row.get("id")) != bucket_id:
            raise BackupError("Bucket details are unavailable.", "missing")
        return self.bucket_row(row)

    def identity(self, bucket):
        workspace = self.me()["workspace"]
        fields = ("id", "type")
        bucket_fields = ("id", "provider", "region", "awsBucketName", "createdAt", "name")
        values = [[workspace.get(field) for field in fields], [bucket.get(field) for field in bucket_fields]]
        return fingerprint(json.dumps(values, sort_keys=True))

    def objects(self, bucket, prefix, page):
        result = self.request(self.endpoint(bucket, "/objects"), params=dict(
            prefix=prefix, page=page, pageSize=50, sortBy="key", sortDir="asc"))
        if not isinstance(result.get("objects"), list) or not isinstance(result.get("totalCount"), int):
            raise BackupError("The indexed folder listing is unavailable. Enter a destination path manually.")
        return result

    def folder_evidence(self, bucket, prefix):
        if not prefix:
            return "top_level"
        try:
            self.request(self.endpoint(bucket, "/objects/metadata"), params={"key": prefix + "/"})
            return "live_marker"
        except BackupError as error:
            if error.code != "missing":
                raise
        return "indexed" if self.objects(bucket, prefix + "/", 1)["totalCount"] else "not_found_in_listing"

    def create_folder(self, bucket, parent, name):
        self.request(self.endpoint(bucket, "/folders"), body={"prefix": parent, "name": name}, empty=True)

    def occupied(self, bucket, prefix):
        result = self.request(self.endpoint(bucket, "/objects/versions"),
                              params={"prefix": prefix, "maxKeys": 2})
        rows, truncated = result.get("versions"), result.get("isTruncated")
        if not isinstance(rows, list) or not isinstance(truncated, bool) or any(
            not isinstance(row, dict) or not isinstance(row.get("key"), str) or
            not row["key"].startswith(prefix) for row in rows
        ):
            raise BackupError("Live destination verification is unavailable.")
        return bool(rows or truncated)

    def presign(self, bucket, key):
        return self.request(self.endpoint(bucket, "/objects/upload"),
                            body={"key": key, "contentType": "application/octet-stream"}).get("uploadUrl")

    def confirm(self, bucket, key):
        self.request(self.endpoint(bucket, "/objects/confirm"), body={"key": key}, empty=True)

    def _signed_query(self, url, provider):
        try:
            parts = urlsplit(url if isinstance(url, str) else "")
            host = parts.hostname or ""
            suffixes = {"aws": (".amazonaws.com", ".amazonaws.com.cn"),
                        "r2": (".r2.cloudflarestorage.com",), "gcs": (".storage.googleapis.com",)}
            trusted = host.endswith(suffixes.get(provider, ())) or (provider == "gcs" and host == "storage.googleapis.com")
            if not trusted or parts.scheme != "https" or parts.username is not None or parts.password is not None or parts.fragment or parts.port not in (None, 443):
                raise BackupError("BucketPilot returned an unsupported storage endpoint.")
            return parse_qs(parts.query, keep_blank_values=True, max_num_fields=100)
        except ValueError:
            raise BackupError("BucketPilot returned an invalid storage endpoint.") from None

    def metadata(self, bucket, key):
        return self.request(self.endpoint(bucket, "/objects/metadata"), params={"key": key})

    def download(self, bucket, key, provider, stream, size, version=None, progress=None):
        body = {"key": key, "expiresIn": 600}
        if version:
            body["versionId"] = version
        url = self.request(self.endpoint(bucket, "/objects/download"), body=body).get("downloadUrl")
        self._signed_query(url, provider)
        try:
            with requests.Session() as session:
                session.trust_env = False
                with session.get(url, stream=True, timeout=(5, 45), allow_redirects=False,
                                 headers={"Accept-Encoding": "identity"}) as response:
                    if response.status_code == 404:
                        raise BackupError("The file was not found in the bucket.", "missing")
                    if response.status_code in (401, 403):
                        raise BackupError("Storage denied access to this file.", "access")
                    if response.status_code in (408, 429) or response.status_code >= 500:
                        raise BackupError("Storage is temporarily unavailable.", "temporary")
                    if response.status_code != 200:
                        raise BackupError(f"Storage rejected the download (HTTP {response.status_code}).")
                    for chunk in response.iter_content(1024 * 1024):
                        if stream.tell() + len(chunk) > size:
                            raise BackupError("The download exceeds the size recorded in the backup.", "checksum")
                        stream.write(chunk)
                        if progress:
                            progress(stream.tell())
        except requests.RequestException:
            raise BackupError("Download interrupted. It can be retried.", "temporary") from None
        if stream.tell() != size:
            raise BackupError("The download size differs from the backup.", "checksum")
        stream.seek(0)

    def put(self, bucket, key, provider, stream, size):
        url = self.presign(bucket, key)
        query = self._signed_query(url, provider)
        checksum = query.get("x-amz-checksum-crc32")
        if checksum:
            crc = 0
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                crc = zlib.crc32(chunk, crc)
            stream.seek(0)
            if checksum != [base64.b64encode(crc.to_bytes(4, "big")).decode()]:
                raise BackupError("The signed CRC32 does not match this file. No PUT was sent.", "checksum")
        headers = {"Content-Type": "application/octet-stream", "Content-Length": str(size)}
        if provider == "gcs":
            if "x-goog-if-generation-match" not in query.get("X-Goog-SignedHeaders", [""])[0].lower().split(";"):
                raise BackupError("The storage signer must sign a GCS generation-zero precondition.")
            headers["x-goog-if-generation-match"] = "0"
        else:
            headers["If-None-Match"] = "*"
        try:
            with requests.Session() as session:
                session.trust_env = False
                with session.put(url, data=stream if size else b"", headers=headers, stream=True,
                                 timeout=(5, 45), allow_redirects=False) as response:
                    status = response.status_code
        except requests.RequestException:
            raise BackupError("Storage connection interrupted. A new signed URL will be requested on retry.", "temporary") from None
        if status in (409, 412):
            raise BackupError("Destination conflict or uncertain prior upload. The existing object was preserved.", "conflict")
        if status not in (200, 201, 204):
            raise BackupError(f"Storage rejected the PUT (HTTP {status}).",
                              "temporary" if status in (401, 403, 408, 429) or status >= 500 else "rejected")


BLOCKED = set(""".private .runtime .ddev .tools .git .svn .hg .ssh .aws .gnupg .venv
    __pycache__ node_modules php sync tmp temp logs cache backups artifacts runtime
    database databases data snapshots mysql mariadb postgres postgresql pgdata filestore sessions""".split())
PATTERNS = """settings* *credential* *secret* *api*key* *service-account*.json .htpasswd .pgpass
    *.env* *.key *.pem *.p12 *.sql* *.sqlite* *.db *.db-* *.ibd *.log* *.tmp *.bak error_log *~
    auth.json id_rsa* id_ed25519* id_ecdsa* .env* .netrc .npmrc .pypirc .my.cnf *.pfx *.jks
    *.keystore *.zip *.tar *.tar.* *.tgz *.gz *.7z *.rar *.dump *.swp odoo.conf *.odoorc""".split()
MAX_FILE = 512 * 1024 * 1024


def path_parts(path, custom=False):
    if not isinstance(path, str) or len(path.encode()) > 700 or re.search(r"[\x00-\x1f\x7f\\]", path):
        raise BackupError("Invalid backup source path.")
    parts = path.split("/") if path else []
    if any(not part or part in (".", "..") or part.startswith(".bucketpilot-restore-") for part in parts):
        raise BackupError("Invalid backup source path.")
    if custom and any(part in BLOCKED or any(fnmatch.fnmatchcase(part, pattern) for pattern in PATTERNS)
                      for part in map(str.lower, parts)):
        raise BackupError("The source is excluded by the backup policy.")
    return parts


def natural(value):
    return [int(piece) if piece.isdigit() and piece.isascii() else piece
            for piece in re.split(r"([0-9]+)", value.casefold())]


def selected(rules, path):
    matching = [rule for rule in rules if not rule["path"] or path == rule["path"] or path.startswith(rule["path"] + "/")]
    return max(matching, key=lambda rule: len(rule["path"]))["include"] if matching else False


class Sources:
    def __init__(self, database):
        if not database or Path(database).name != database or database in (".", ".."):
            raise BackupError("The database name cannot identify a filestore directory.")
        override = os.environ.get("BUCKETPILOT_PROJECT_ROOT")
        self.custom = bool(override)
        data = Path(config["data_dir"]).resolve()
        self.root = Path(override) if self.custom else data / "filestore"
        self.database_scope = (
            database if not self.custom and os.environ.get("BUCKETPILOT_FILESTORE_ADMIN_DB") != database else None
        )
        secret = Path(os.environ.get("BUCKETPILOT_SECRET_DIRECTORY") or data / "bucketpilot-secrets").resolve()
        self.protected = [secret, Path(config.rcfile).resolve()]
        if self.custom:
            self.protected.append(data)
        if self.custom:
            binding = os.fsencode(str(self.root)) + b"\x01"
        else:
            binding = os.fsencode(str(self.root)) + b"\x00" + os.fsencode(database)
            binding += b"\x00" if self.database_scope else b"\x01"
        self.binding = hashlib.sha256(binding).hexdigest()

    def verify(self, backup):
        if backup.get("source_binding") != self.binding:
            raise BackupError("The backup source changed. Select files again and save the plan, or create a new backup.",
                              "source_changed")

    def _parts(self, path):
        parts = path_parts(path, custom=self.custom)
        if self.database_scope and parts and parts[0] != self.database_scope:
            raise BackupError("This database is not authorized to back up that filestore path.")
        target = self.root.joinpath(*parts)
        if any(block == target or block in target.parents for block in self.protected):
            raise BackupError("The source is inside protected storage.")
        return parts

    @contextmanager
    def opened(self, path, directory=None):
        parts = self._parts(path)
        fd = None
        try:
            if (not self.root.is_absolute() or self.root.resolve() != self.root or
                    (self.custom and self.root in (Path("/"), Path.home()))):
                raise BackupError("The configured backup source is unavailable or unsafe.")
            fd = os.open(self.root, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY)
            root_device = os.fstat(fd).st_dev
            for index, part in enumerate(parts):
                require_dir = index < len(parts) - 1 or directory is True
                child = os.open(part, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW |
                                (os.O_DIRECTORY if require_dir else 0), dir_fd=fd)
                os.close(fd)
                fd = child
                if os.fstat(fd).st_dev != root_device:
                    raise BackupError("Mounted data directories are excluded.")
            item = os.fstat(fd)
            is_dir = stat.S_ISDIR(item.st_mode)
            if (not is_dir and (not stat.S_ISREG(item.st_mode) or item.st_nlink != 1)) or (directory is not None and directory != is_dir):
                raise BackupError("The source is not a permitted file or folder.")
            yield fd, item
        except OSError:
            raise BackupError("The source is unavailable or is a symbolic link.") from None
        finally:
            if fd is not None:
                os.close(fd)

    def listing(self, path):
        entries = []
        deadline = time.monotonic() + 5
        with self.opened(path, True) as (fd, _), os.scandir(fd) as children:
            for index, child in enumerate(children):
                if index >= 50000 or time.monotonic() > deadline:
                    raise BackupError("This folder exceeds the browsing limit.")
                if not path and self.database_scope and child.name != self.database_scope:
                    continue
                relative = f"{path}/{child.name}" if path else child.name
                try:
                    with self.opened(relative) as (_, item):
                        directory = stat.S_ISDIR(item.st_mode)
                        entries.append(dict(path=relative, name=child.name, directory=directory,
                                            size=None if directory else item.st_size))
                except (BackupError, UnicodeError):
                    continue
        return sorted(entries,
                      key=lambda row: (not row["directory"], natural(row["name"])))

    @contextmanager
    def _restore_parent(self, path, created=None):
        if self.custom:
            raise BackupError("Restore is available only for Odoo filestore backups.")
        parts = self._parts(path)
        if not parts:
            raise BackupError("Choose a recorded filestore file.")
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
        fd = os.open(self.root.parent, flags)
        try:
            device = None
            for index, part in enumerate([self.root.name, *parts[:-1]]):
                try:
                    child = os.open(part, flags, dir_fd=fd)
                except FileNotFoundError:
                    if created is None:
                        raise
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=fd)
                        created.append("/".join(parts[:index]) or "Filestore root")
                    except FileExistsError:
                        pass
                    child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
                current_device = os.fstat(fd).st_dev
                if device is not None and current_device != device:
                    raise BackupError("Restore cannot write across mounted source directories.")
                device = current_device
            yield fd, parts[-1]
        finally:
            os.close(fd)

    def _existing_file(self, fd, name):
        try:
            item = os.stat(name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(item.st_mode):
            raise BackupError("The restore target is a directory or an unsafe link.")
        return True

    def restore_exists(self, path):
        try:
            with self._restore_parent(path) as (fd, name):
                return self._existing_file(fd, name)
        except FileNotFoundError:
            return False
        except OSError:
            raise BackupError("The local restore path is unsafe or cannot be accessed.") from None

    def restore_file(self, path, stream, created):
        try:
            with self._restore_parent(path, created) as (fd, name):
                if self._existing_file(fd, name):
                    return False
                staging = ".bucketpilot-restore-" + uuid4().hex
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                with os.fdopen(os.open(staging, flags, 0o600, dir_fd=fd), "wb") as destination:
                    try:
                        shutil.copyfileobj(stream, destination, 1024 * 1024)
                        destination.flush()
                        os.fsync(destination.fileno())
                        try:
                            os.link(staging, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
                        except FileExistsError:
                            return False
                        return True
                    finally:
                        os.unlink(staging, dir_fd=fd)
        except OSError:
            raise BackupError("The file could not be written to the local filestore.") from None

    @contextmanager
    def snapshot(self, path):
        with self.opened(path, False) as (fd, before):
            if before.st_size > MAX_FILE:
                raise BackupError("File exceeds the 512 MiB single-PUT limit.")
            with tempfile.TemporaryFile(dir=config["data_dir"]) as stream, os.fdopen(os.dup(fd), "rb") as source:
                remaining = before.st_size + 1
                while remaining:
                    chunk = source.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        break
                    stream.write(chunk)
                    remaining -= len(chunk)
                after = os.fstat(fd)
                if stream.tell() != before.st_size or (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
                    raise BackupError("The source changed during snapshot creation.", "temporary")
                stream.seek(0)
                yield stream, before.st_size
