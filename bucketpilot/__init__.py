from . import controllers, models
from .storage import Credential


def uninstall_hook(env):
    Credential(env.cr.dbname).replace("")
    env["ir.config_parameter"].sudo().search([("key", "=like", "bucketpilot.%")]).unlink()
