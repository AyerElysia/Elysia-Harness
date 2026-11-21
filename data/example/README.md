# Elysium data example

This is a sanitized skeleton of the server's `Elysium/data` directory. It exists so a clone can see the expected layout without carrying private diaries, memories, media, or databases.

- **Tracked:** this `data/example/` directory only.
- **Ignored:** `data/elysia/`, the personal copy of the real server data.
- **Never tracked:** SQLite databases, WAL/SHM files, media, backups, logs, generated emoji, and anything under the personal copy.

## Top-level layout

| Path | Purpose |
|---|---|
| `chroma_db/` | Vector memory database |
| `diaries/` | Diary entries by month |
| `elysia_generated_emoji/` | Generated emoji assets |
| `emoji/` | Emoji library |
| `emoji_sender/` | Emoji vectors, memes, and manual memes |
| `json_storage/` | Small JSON-backed plugin state |
| `life_engine_workspace/` | Life-engine narrative, thoughts, dreams, skills, and runtime |
| `life_storage/` | Long-term life state, SQLite, authority records, backups |
| `livestream/` | Livestream audio and operational state |
| `media_cache/` | Cached videos, images, emoji, and pending media |
| `new_api_relay/` | Relay logs and backups |
| `repair_backups/` | Checkpoint and repair snapshots |
| `runtime/` | Runtime scratch |
| `service_logs/` | Service logs |
| `training_data_lake/` | Raw, processed, archived, and exported training data |
| `tts_ref_studio/` | TTS reference audio and config backups |
| `webui/` | Web UI state |

## Database files

These live at the root of the real data directory and are deliberately **not** represented by real files here:

- `Elysium.db` + `Elysium.db-wal` + `Elysium.db-shm`
- `logs.db` + `logs.db-wal` + `logs.db-shm`

A live copy can be inconsistent while the server is writing. Treat `data/elysia/` as a working snapshot, not a guaranteed consistent backup.

## Personal copy

`data/elysia/` is ignored by git. In this checkout it holds:

- `Elysia-SoulBanker-main/` — the extracted snapshot
- `Elysia-SoulBanker-main.zip` — the original archive

This is a private, offline subject-document snapshot (`SOUL.md`, `USER.md`, `MEMORY.md`, `TOOL.md`, plus `subject-documents.sqlite3.zip`), not the full live 22 GB data tree. The snapshot SQLite must not replace the running Elysium database.

Do not copy private content into `data/example/`. If a new directory becomes part of the contract, add only its empty skeleton and a short description here.
