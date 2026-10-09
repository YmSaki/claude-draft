# Security and privacy

Claude Draft is a Claude Code Mod. Mods can run with the user's permissions; inspect source and install only from trusted locations.

The Mod requires no network access, no shell/process calls, and no environment-variable reads. No draft content, session identifier, or local path should ever be committed to this repository. CI test fixtures must use synthetic data only.

Temporary document state is kept in Claude Code's local plugin store, separate from the project files. It is persisted on the user's disk, is not encrypted by this plugin, and may outlast the current session. Users can discard individual drafts explicitly. Old-session cleanup is best effort and runs on a subsequent session start.

Export is always initiated by the user. The implementation validates relative `.md` and `.txt` destinations and refuses an existing file before writing, but this preflight is not atomic and cannot prevent a race with another writer. Do not rely on it as an atomic no-overwrite guarantee.

The model-facing tools never export or discard. They modify only the drafts held by the Mod; each partial edit requires a unique exact match. Invalid saved state and conflicting version updates fail closed.

Report vulnerabilities through a private channel to the repository owner rather than posting exploit details or sensitive documents in public issues.
