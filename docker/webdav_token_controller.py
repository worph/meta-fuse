"""
WsgiDAV custom DomainController for meta-fuse WebDAV access tokens.

Reads `${TOKEN_STORE_PATH}` (a JSON file written by meta-fuse's TokenStore.ts)
fresh on every basic-auth request — no caching, so token revocation from the
dashboard takes effect on the next request.

Username is ignored: the WebDAV password IS the token. We accept any
non-empty username so generic clients (Finder, Plex, davfs2) that demand both
fields keep working.
"""

import hashlib
import json
import os
from typing import Any

from wsgidav.dc.base_dc import BaseDomainController

# Match the prefix produced by TokenStore.ts.
TOKEN_PREFIX = "mfwd_"
TOKEN_STORE_DEFAULT = "/meta-fuse/config/webdav-tokens.json"


class WebdavTokenController(BaseDomainController):
    """
    Auth provider backed by meta-fuse's per-device token store.

    WsgiDAV calls `basic_auth_user(realm, user_name, password, environ)` for
    every request that requires auth. We hash the candidate password with
    sha256 and check it against the persisted records.
    """

    def __init__(self, wsgidav_app: Any, config: dict) -> None:
        super().__init__(wsgidav_app, config)
        self._store_path = os.environ.get("TOKEN_STORE_PATH", TOKEN_STORE_DEFAULT)

    # --- BaseDomainController contract --------------------------------------

    def get_domain_realm(self, path_info: str, environ: dict) -> str:
        # Single realm — all paths require the same token.
        return "metafuse-webdav"

    def require_authentication(self, realm: str, environ: dict) -> bool:
        return True

    def supports_http_digest_auth(self) -> bool:
        # Tokens are not stored in plaintext, so we cannot answer digest
        # challenges — clients must use basic auth (over TLS).
        return False

    def basic_auth_user(
        self, realm: str, user_name: str, password: str, environ: dict
    ) -> bool:
        if not password or not password.startswith(TOKEN_PREFIX):
            return False

        try:
            with open(self._store_path, "r", encoding="utf-8") as fh:
                store = json.load(fh)
        except FileNotFoundError:
            return False
        except (OSError, json.JSONDecodeError):
            # Treat unreadable store as "no valid tokens" — fail closed.
            return False

        candidate = hashlib.sha256(password.encode("utf-8")).hexdigest()
        for token in store.get("tokens", []):
            if token.get("hash") == candidate:
                return True
        return False
