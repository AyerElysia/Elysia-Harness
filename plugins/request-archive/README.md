# @elysia/request-archive

English | [中文](README.zh.md)

Before each model call is sent, the request as it stands is written to one JSON file. However the session log is later compacted or replaced, these files stay as they were.

The request hooks into `llm/stream`. A write failure stops that call from reaching the adapter.

Files live in `/home/ayerelysia/Elysia/Data/requests`, one per call. The directory is configurable:

```yaml
- id: elysia-request-archive
  name: elysia-request-archive
  config:
    dir: /home/ayerelysia/Elysia/Data/requests
    maxFiles: 5000
    maxBytes: 536870912
    maxAgeDays: 30
    compact: true
```

Each record holds the `messages`, `system`, tool schemas, model, temperature, and `sessionId` as they were then. The abort signal is not written. Images stay as the attachment references the request carried; their bytes remain in attachment storage.

## Storage

Each call appends one new file and no earlier record is read or rewritten, so a write only serializes its own request. Records are single-line JSON by default; set `compact: false` when a human has to read them, which adds about 30% to each record. On POSIX systems the directory is created `0700` and a pre-existing `0755` directory is tightened on the first write of the process; Windows keeps its inherited ACLs. Record files are `0600`.

## Retention

`maxFiles`, `maxBytes`, and `maxAgeDays` bound the directory with defaults of 5000 files, 512 MiB, and 30 days; `0` disables one bound. The oldest records leave first. Eviction runs on a queued pass after the write, never inside it, so the model call never waits for a directory scan; mounting also runs one pass in the background, which enforces the bounds a previous run left behind without delaying the first call. A per-session pointer whose record was evicted is removed, so a reader reports an unavailable index instead of following the pointer to a missing file.

## Latest request index

After the immutable JSON is published, requests with a sessionId update a hashed per-session pointer in .session-index-v1. The metadata index is a derived view: an index failure is reported while the completed archive and model call continue. New archive files are owner-readable only.

The index-store export supports reading the pointer and explicitly repairing one from a known archived request. It never scans archive bodies. Writes are ordered within one RequestArchiveIndex instance; maintenance seeding must run while the archive index writer is idle, because independent processes do not share its write queue. Original JSON files remain unchanged.

The Web context-inspector consumes this index through session-authorized Remote methods. An archive remains the framework input before provider conversion and attachment resolution; it does not prove network delivery.
