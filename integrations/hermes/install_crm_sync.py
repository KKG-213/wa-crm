#!/usr/bin/env python3
"""Version-checked local source extension. Run while the owned gateway is stopped."""
import argparse
import ast
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

EXPECTED_SOURCE_SHA = "c76f6e91e603b27ec3c7c37d293fc9ac1d9583dd969c8904b35f98e1c802008f"
REVISION = "bd0affe5"
ENDPOINT = "https://wam.kwsolutioins.online/api/hermes/outbound"
MARKER = "# KW CRM outbound sync (bd0affe5)"


def digest(source):
    return hashlib.sha256((source.rstrip() + "\n").encode()).hexdigest()


def replace_once(source, old, new):
    if source.count(old) != 1: raise ValueError("Adapter source anchor did not match exactly once")
    return source.replace(old, new, 1)


def patched_source(source, expected=EXPECTED_SOURCE_SHA):
    if digest(source) != expected: raise ValueError("Adapter differs from the tested bd0affe5 source; nothing changed")
    source = replace_once(source, "logger = logging.getLogger(__name__)",
        f"{MARKER}\nfrom gateway.platforms.whatsapp_crm_sync import WhatsAppCrmSync\n\nlogger = logging.getLogger(__name__)")
    source = replace_once(source, "        self._runner = self._http_client = None", """        self._runner = self._http_client = None
        self._crm_sync = None
        self._crm_sync_url = str(extra.get("crm_sync_url") or _get_wsecret("WHATSAPP_CLOUD_CRM_SYNC_URL", default="") or "").strip()
        self._crm_sync_directory = Path(get_hermes_dir("platforms/whatsapp_cloud/crm_outbox", "whatsapp_cloud/crm_outbox"))""")
    source = replace_once(source, "        self._wire_plugin_handlers(None)\n        return True", """        self._crm_sync = await WhatsAppCrmSync.create(
            self._crm_sync_url, self._app_secret, self._phone_number_id, self._crm_sync_directory)
        self._wire_plugin_handlers(None)
        return True""")
    source = replace_once(source, "    async def disconnect(self) -> None:\n", """    async def disconnect(self) -> None:
        if self._crm_sync is not None:
            with contextlib.suppress(Exception):
                await self._crm_sync.close()
            self._crm_sync = None
""")
    source = replace_once(source, """        try:
            return resp.json().get("messages") or [], None
        except Exception:
            return [], None""", """        try:
            messages = resp.json().get("messages") or []
        except Exception:
            return [], None
        if self._crm_sync is not None:
            try:
                await self._crm_sync.capture(payload, messages)
            except Exception:
                logger.error("[whatsapp_crm_sync] enqueue_failed")
        return messages, None""")
    ast.parse(source)
    return source


def atomic_write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".crm-sync-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def configured_env(source):
    lines = source.splitlines()
    matches = [i for i, line in enumerate(lines) if line.lstrip().startswith("WHATSAPP_CLOUD_CRM_SYNC_URL=") or line.lstrip().startswith("export WHATSAPP_CLOUD_CRM_SYNC_URL=")]
    if len(matches) > 1: raise ValueError("Duplicate CRM URL variables; resolve them first")
    value = f"WHATSAPP_CLOUD_CRM_SYNC_URL={ENDPOINT}"
    if matches:
        current = lines[matches[0]].split("=", 1)[1].strip().strip("'\"")
        if current not in ("", ENDPOINT): raise ValueError("A different CRM URL is already configured; nothing changed")
        lines[matches[0]] = value
    else:
        lines.append(value)
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes-dir", type=Path, default=Path.home() / ".hermes/hermes-agent")
    parser.add_argument("--profile-home", type=Path, default=Path.home() / ".hermes")
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args()
    if args.install and args.uninstall: parser.error("Choose one action")
    root = args.hermes_dir.resolve()
    target = root / "gateway/platforms/whatsapp_cloud.py"
    helper = root / "gateway/platforms/whatsapp_crm_sync.py"
    backup = target.with_name("whatsapp_cloud.py.crm-sync-backup")
    source = target.read_text()
    bundled_helper = Path(__file__).with_name("whatsapp_crm_sync.py").read_bytes()
    ast.parse(bundled_helper)
    revision = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if not revision.startswith(REVISION): raise ValueError("Installed Git revision is not bd0affe5; nothing changed")
    if args.uninstall:
        original = backup.read_text()
        if digest(original) != EXPECTED_SOURCE_SHA or digest(source) != digest(patched_source(original)):
            raise ValueError("Adapter changed after installation; refusing to overwrite it")
        if helper.exists() and helper.read_bytes() != bundled_helper: raise ValueError("Helper changed; refusing to overwrite it")
        atomic_write(target, original.encode(), target.stat().st_mode & 0o777)
        helper.unlink(missing_ok=True)
        print("Adapter restored. CRM URL and pending queue preserved. Restart the owned gateway.")
        return
    env = args.profile_home.expanduser().resolve() / ".env"
    if not env.is_file(): raise ValueError("Existing profile .env was not found; nothing changed")
    env_source = env.read_text()
    new_env = configured_env(env_source)
    if MARKER in source:
        if not backup.exists() or digest(source) != digest(patched_source(backup.read_text())):
            raise ValueError("Patched adapter or backup changed; nothing changed")
        if not helper.exists() or helper.read_bytes() != bundled_helper: raise ValueError("Installed helper differs; nothing changed")
        if args.install and new_env != env_source:
            atomic_write(env, new_env.encode(), 0o600)
        print("CRM sync is already installed. Restart the owned gateway if needed.")
        return
    result = patched_source(source)
    if backup.exists() or helper.exists(): raise ValueError("An existing backup/helper needs review; nothing changed")
    if not args.install:
        print("Compatible bd0affe5 adapter. No changes made. Use --install with the gateway stopped.")
        return
    # All source/config checks finish before mutation. Only the non-secret URL is added.
    atomic_write(backup, source.encode(), 0o600)
    try:
        atomic_write(helper, bundled_helper, 0o644)
        atomic_write(env, new_env.encode(), 0o600)
        atomic_write(target, result.encode(), target.stat().st_mode & 0o777)
    except Exception:
        atomic_write(env, env_source.encode(), 0o600)
        helper.unlink(missing_ok=True)
        atomic_write(target, source.encode(), target.stat().st_mode & 0o777)
        backup.unlink(missing_ok=True)
        raise
    print("Installed CRM sync for bd0affe5. Only CRM URL added; existing credentials preserved.")
    print("Next: hermes gateway restart")


if __name__ == "__main__":
    try: main()
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
