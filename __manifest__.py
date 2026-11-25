{
    "name": "BucketPilot",
    "summary": "Connect BucketPilot and schedule Odoo filestore backups",
    "version": "18.0.2.1.1",
    "category": "Administration",
    "license": "GPL-2",
    "depends": ["web", "mail"],
    "external_dependencies": {"python": ["jinja2", "requests"]},
    "data": ["security/groups.xml", "data/cron.xml", "views/menu.xml"],
    "assets": {"web.assets_backend": [
        "bucketpilot/static/src/bucketpilot_action.js",
        "bucketpilot/static/src/bucketpilot_action.scss",
    ]},
    "uninstall_hook": "uninstall_hook",
    "application": True,
    "installable": True,
}
