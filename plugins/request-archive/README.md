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
```

Each record holds the `messages`, `system`, tool schemas, model, temperature, and `sessionId` as they were then. The abort signal is not written. Images stay as the attachment references the request carried; their bytes remain in attachment storage.

## Latest request index

After the immutable JSON is published, requests with a sessionId update a hashed per-session pointer in .session-index-v1. The metadata index is a derived view: an index failure is reported while the completed archive and model call continue. New archive files are owner-readable only.

The index-store export supports reading the pointer and explicitly repairing one from a known archived request. It never scans archive bodies. Writes are ordered within one RequestArchiveIndex instance; maintenance seeding must run while the archive index writer is idle, because independent processes do not share its write queue. Original JSON files remain unchanged.

The Web context-inspector consumes this index through session-authorized Remote methods. An archive remains the framework input before provider conversion and attachment resolution; it does not prove network delivery.
