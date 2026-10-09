# -*- coding: utf-8 -*-
"""Legacy VIBE_HOME seeder for the Python -> TS in-place upgrade smoke test.

SMOKE-ONLY TOOL - NOT part of the product runtime. The product runtime is the
TS server (packages/server); this script plays the role of "the old Python
version" by booting the real FastAPI app IN-PROCESS (httpx-free: we only use
the lifespan, no HTTP listen) against an isolated VIBE_HOME, seeding
users/stores/settings, then shutting down gracefully.

Requirements (deliberately narrow):
  - Reference repo venv: D:/CKQ/workplace/_reference/vibe-seller-src/.venv
    (vibe-seller editable install + httpx/fastapi full set). Not installable
    from the TS repo.
  - Isolated env (set by scripts/smoke-package.mjs): tmp VIBE_HOME, tmp LOG_DIR,
    VIBE_SELLER_TELEMETRY=0 (zero real network - telemetry is gated off), known
    ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_EMAIL, LEGACY_MEMBER_PASSWORD for
    the extra member user.

data/install_id: a real Python install writes it on first telemetry.init(). We
run with telemetry disabled (zero-network red line), so the file is written
here explicitly with a fixed UUID - byte-identical to what a real install has
on disk, which is exactly the state the upgrade must preserve.

Seeded rows (all via the real SQLAlchemy models, so column shapes are the
genuine legacy shapes):
  - admin user (DEFAULT_USER_ID, bcrypt hash of $ADMIN_PASSWORD)
  - member user "legacy_member" (bcrypt hash of $LEGACY_MEMBER_PASSWORD) -
    TS seed() only ever rewrites the admin row, so logging in as this member
    is the honest bcrypt-compatibility proof across the upgrade
  - one store ("Legacy Smoke Store")
  - one custom app_settings row ("smoke_legacy_marker")
  - data/install_id (fixed UUID, see above)
"""

import asyncio
import os
import sys
import uuid
from pathlib import Path

# SMOKE CONTRACT with scripts/smoke-package.mjs (kept in sync manually).
STORE_NAME = "Legacy Smoke Store"
MEMBER_USERNAME = "legacy_member"
MARKER_KEY = "smoke_legacy_marker"
MARKER_VALUE = "seeded-by-python"


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"[seed_legacy] missing required env: {name}", file=sys.stderr)
        sys.exit(2)
    return value


def main() -> None:
    vibe_home = Path(_require_env("VIBE_HOME"))
    admin_username = _require_env("ADMIN_USERNAME")
    admin_password = _require_env("ADMIN_PASSWORD")
    admin_email = _require_env("ADMIN_EMAIL")
    member_password = _require_env("LEGACY_MEMBER_PASSWORD")

    # Zero-network + isolated-log guards must be set by the caller before the
    # app imports (app.config reads env at import time).
    if os.environ.get("VIBE_SELLER_TELEMETRY", "").strip() != "0":
        print("[seed_legacy] refusing to run without VIBE_SELLER_TELEMETRY=0", file=sys.stderr)
        sys.exit(2)
    if not os.environ.get("LOG_DIR"):
        print("[seed_legacy] refusing to run without LOG_DIR (keep logs out of the repo)", file=sys.stderr)
        sys.exit(2)

    # Import AFTER env is final: app.config snapshots env at import time.
    from app import telemetry
    from app.config import AI_BOT_USER_ID, DATA_DIR, DEFAULT_USER_ID
    from app.database import async_session, engine
    from app.main import app
    from app.models.app_settings import AppSettings
    from app.models.store import Store
    from app.models.user import User
    from app.password import hash_password

    async def run() -> None:
        # Real FastAPI startup sequence (init_db -> plugins -> scheduler ->
        # workspace/knowledge/skills local sync -> ...), all local I/O, no
        # HTTP listener (lifespan only - ASGI transport is not even mounted).
        async with app.router.lifespan_context(app):
            # init_db (inside the lifespan) already seeded the admin user from
            # $ADMIN_USERNAME/$ADMIN_PASSWORD/$ADMIN_EMAIL with a real Python
            # bcrypt hash - exactly what a genuine legacy install has. Do NOT
            # re-insert it (PK duplicate). The extra member user below is the
            # honest cross-upgrade credential: TS seed() only ever rewrites
            # the admin row, so logging in as this member after the TS boot
            # proves the legacy bcrypt hash itself still verifies.
            async with async_session() as session:
                existing_admin = await session.get(User, DEFAULT_USER_ID)
                if existing_admin is None:
                    print("[seed_legacy] FATAL: init_db did not seed admin", file=sys.stderr)
                    sys.exit(3)
                session.add(
                    User(
                        username=MEMBER_USERNAME,
                        email=f"{MEMBER_USERNAME}@vibe-seller.local",
                        password_hash=hash_password(member_password),
                        role="member",
                    )
                )
                session.add(Store(name=STORE_NAME))
                session.add(AppSettings(key=MARKER_KEY, value=MARKER_VALUE))
                await session.commit()

            # Row-count proof on the legacy side (before TS ever opens the DB).
            async with async_session() as session:
                users = (await session.execute(
                    User.__table__.select()
                )).fetchall()
                stores = (await session.execute(
                    Store.__table__.select()
                )).fetchall()
                marker = await session.get(AppSettings, MARKER_KEY)
                print(f"[seed_legacy] users={len(users)} stores={len(stores)} marker={marker.value}")

        # Release pooled sqlite connections so the TS server (and the smoke
        # script's own reads) never fight a held handle on Windows.
        await engine.dispose()

    asyncio.run(run())

    # install_id: what a real Python install has on disk (see module docstring).
    install_id_file = DATA_DIR / "install_id"
    install_id_file.write_text(str(uuid.UUID(os.environ.get("LEGACY_INSTALL_ID", str(uuid.uuid4())))))
    print(f"[seed_legacy] install_id={install_id_file.read_text()} -> {install_id_file}")
    assert telemetry._client is None  # telemetry stayed gated off (zero network)
    print("[seed_legacy] done")


if __name__ == "__main__":
    main()
