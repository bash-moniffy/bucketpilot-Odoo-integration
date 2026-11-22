{
    "name": "BucketPilot",
    "summary": "Connect BucketPilot and schedule project file backups",
    "description": (
        "Schedule project file backups to a BucketPilot workspace from Odoo. "
        "Connecting sends the API key to BucketPilot over HTTPS. "
        "A saved backup authorizes selected file contents and relative paths to be sent "
        "to the configured storage destination."
    ),
    "images": ["static/description/overview.png"],
    "version": "18.0.1.0.0",
    "category": "Administration",
    "license": "Other OSI approved licence",
    "depends": ["web", "mail"],
    "external_dependencies": {"python": ["jinja2", "requests"], "bin": ["git"]},
    "data": ["security/groups.xml", "data/cron.xml", "views/menu.xml"],
    "assets": {"web.assets_backend": [
        "bucketpilot/static/src/bucketpilot_action.js",
        "bucketpilot/static/src/bucketpilot_action.scss",
    ]},
    "uninstall_hook": "uninstall_hook",
    "application": True,
    "installable": True,
}
