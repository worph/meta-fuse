# API Reference

## Overview

meta-fuse exposes a REST API for FUSE operations, VFS management, and service discovery. The API server is built with Fastify and listens on port 3000 by default.

**Base URL**: `http://localhost:3000`

---

## Health & Status

### GET /health

Health check endpoint.

**Response**:
```json
{
    "status": "ok",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "service": "meta-fuse"
}
```

### GET /api/health

Alias for `/health`.

### GET /api/fuse/health

Alias for `/health`.

### GET /api/fuse/stats

Get VFS statistics and state information.

**Response**:
```json
{
    "fileCount": 5123,
    "directoryCount": 847,
    "totalSize": 15847392847362,
    "lastRefresh": "2024-01-15T10:30:00.000Z",
    "categories": {
        "Movies": 1523,
        "TV": 2847,
        "Anime": 753
    },
    "kvConnection": "connected",
    "fuseMount": "mounted"
}
```

---

## FUSE Operations

### POST /api/fuse/readdir

List contents of a virtual directory.

**Request Body**:
```json
{
    "path": "/Movies/Action"
}
```

**Response** (200 OK):
```json
{
    "entries": [
        "Die Hard (1988)",
        "Mad Max Fury Road (2015)",
        "The Dark Knight (2008)"
    ]
}
```

**Response** (404 Not Found):
```json
{
    "error": "Directory not found"
}
```

### POST /api/fuse/getattr

Get file or directory attributes.

**Request Body**:
```json
{
    "path": "/Movies/Action/Die Hard (1988)/Die Hard.mkv"
}
```

**Response** (200 OK) - File:
```json
{
    "size": 4831838208,
    "mode": "file",
    "permissions": 644,
    "uid": 1000,
    "gid": 1000,
    "atime": "2024-01-15T10:30:00Z",
    "mtime": "2024-01-15T10:30:00Z",
    "ctime": "2024-01-15T10:30:00Z",
    "sourcePath": "/files/watch/downloads/Die.Hard.1988.1080p.mkv"
}
```

**Response** (200 OK) - Directory:
```json
{
    "mode": "directory",
    "permissions": 755,
    "uid": 1000,
    "gid": 1000
}
```

**Response** (404 Not Found):
```json
{
    "error": "Path not found"
}
```

### POST /api/fuse/exists

Check if a path exists in the VFS.

**Request Body**:
```json
{
    "path": "/Movies/Action/Die Hard (1988)"
}
```

**Response**:
```json
{
    "exists": true
}
```

### POST /api/fuse/read

Get information for reading a file. Returns source path and optionally WebDAV URL.

**Request Body**:
```json
{
    "path": "/Movies/Action/Die Hard (1988)/Die Hard.mkv"
}
```

**Response** (200 OK) - Regular file:
```json
{
    "sourcePath": "/files/watch/downloads/Die.Hard.1988.1080p.mkv",
    "size": 4831838208
}
```

**Response** (200 OK) - File with WebDAV access:
```json
{
    "sourcePath": "/files/watch/downloads/Die.Hard.1988.1080p.mkv",
    "size": 4831838208,
    "webdavUrl": "http://meta-core/webdav/watch/downloads/Die.Hard.1988.1080p.mkv"
}
```

**Response** (200 OK) - Virtual file with content:
```json
{
    "sourcePath": null,
    "size": 256,
    "content": "VGhpcyBpcyBhIHZpcnR1YWwgZmlsZQ==",
    "contentEncoding": "base64"
}
```

**Response** (404 Not Found):
```json
{
    "error": "File not found"
}
```

### POST /api/fuse/metadata

Get full metadata for a virtual path.

**Request Body**:
```json
{
    "path": "/Movies/Action/Die Hard (1988)/Die Hard.mkv"
}
```

**Response** (200 OK):
```json
{
    "hashId": "bafkreiabc123...",
    "filePath": "watch/downloads/Die.Hard.1988.1080p.mkv",
    "title": "Die Hard",
    "year": "1988",
    "fileType": "video",
    "size": "4831838208",
    "extension": "mkv",
    "video/codec": "h265",
    "video/resolution": "1920x1080",
    "audio/codec": "aac",
    "audio/channels": "6"
}
```

**Response** (404 Not Found):
```json
{
    "error": "Metadata not found"
}
```

### GET /api/fuse/files

List all virtual files in the VFS.

**Response**:
```json
{
    "files": [
        "/Movies/Action/Die Hard (1988)/Die Hard.mkv",
        "/Movies/Action/Mad Max Fury Road (2015)/Mad Max Fury Road.mkv",
        "/TV/Breaking Bad/Season 01/S01E01 - Pilot.mkv"
    ]
}
```

### GET /api/fuse/directories

List all virtual directories in the VFS.

**Response**:
```json
{
    "directories": [
        "/Movies",
        "/Movies/Action",
        "/Movies/Action/Die Hard (1988)",
        "/TV",
        "/TV/Breaking Bad",
        "/TV/Breaking Bad/Season 01"
    ]
}
```

### POST /api/fuse/refresh

Trigger a VFS refresh. Re-reads metadata and rebuilds virtual paths.

**Response**:
```json
{
    "status": "ok"
}
```

---

## Renaming Rules

### GET /api/fuse/rules

Get the current renaming rules configuration.

**Response**:
```json
{
    "config": {
        "rules": [
            {
                "name": "Movies",
                "enabled": true,
                "priority": 100,
                "template": "/Movies/{genre}/{title} ({year})/{fileName}",
                "conditions": {
                    "operator": "and",
                    "conditions": [
                        { "field": "fileType", "operator": "equals", "value": "video" },
                        { "field": "mediaType", "operator": "equals", "value": "movie" }
                    ]
                }
            },
            {
                "name": "TV Shows",
                "enabled": true,
                "priority": 90,
                "template": "/TV/{title}/Season {season:pad2}/{title} - S{season:pad2}E{episode:pad2}.{extension}",
                "conditions": {
                    "operator": "and",
                    "conditions": [
                        { "field": "fileType", "operator": "equals", "value": "video" },
                        { "field": "mediaType", "operator": "equals", "value": "tv" }
                    ]
                }
            }
        ],
        "defaultRule": {
            "name": "Default",
            "template": "/Other/{fileName}",
            "conditions": { "operator": "and", "conditions": [] }
        },
        "lastModified": "2024-01-15T10:30:00Z"
    },
    "lastModified": "2024-01-15T10:30:00Z"
}
```

### PUT /api/fuse/rules

Update the renaming rules configuration. Automatically triggers VFS refresh.

**Request Body**:
```json
{
    "config": {
        "rules": [
            {
                "name": "Movies",
                "enabled": true,
                "priority": 100,
                "template": "/Movies/{title} ({year})/{fileName}",
                "conditions": {
                    "operator": "and",
                    "conditions": [
                        { "field": "fileType", "operator": "equals", "value": "video" }
                    ]
                }
            }
        ]
    }
}
```

**Response** (200 OK):
```json
{
    "success": true,
    "refreshed": true
}
```

**Response** (400 Bad Request) - Validation errors:
```json
{
    "success": false,
    "errors": [
        "Rule \"Movies\": Unknown variable 'unknownVar' in template",
        "Rule \"TV Shows\": Invalid condition operator 'matches'"
    ]
}
```

### POST /api/fuse/rules/preview

Preview how files would be renamed with the given rules.

**Request Body**:
```json
{
    "rules": [
        {
            "name": "Movies",
            "template": "/New Movies/{title} ({year})/{fileName}",
            "conditions": {
                "operator": "and",
                "conditions": [
                    { "field": "fileType", "operator": "equals", "value": "video" }
                ]
            }
        }
    ],
    "limit": 10
}
```

**Response**:
```json
{
    "previews": [
        {
            "hashId": "bafkreiabc123...",
            "currentPath": "/Movies/Action/Die Hard (1988)/Die Hard.mkv",
            "newPath": "/New Movies/Die Hard (1988)/Die Hard.mkv",
            "ruleName": "Movies"
        },
        {
            "hashId": "bafkreixyz789...",
            "currentPath": "/TV/Breaking Bad/Season 01/S01E01.mkv",
            "newPath": null,
            "ruleName": null,
            "reason": "No matching rule"
        }
    ],
    "total": 5123,
    "sampled": 10
}
```

### POST /api/fuse/rules/validate

Validate a single renaming rule.

**Request Body**:
```json
{
    "rule": {
        "name": "Test Rule",
        "template": "/Test/{title|originalTitle} ({year})/{fileName}",
        "conditions": {
            "operator": "and",
            "conditions": [
                { "field": "fileType", "operator": "equals", "value": "video" }
            ]
        }
    },
    "sampleMetadata": {
        "title": "Inception",
        "originalTitle": "Inception",
        "year": "2010",
        "fileName": "Inception.mkv"
    }
}
```

**Response** (valid rule):
```json
{
    "valid": true,
    "errors": [],
    "warnings": [],
    "sampleOutput": "/Test/Inception (2010)/Inception.mkv"
}
```

**Response** (invalid rule):
```json
{
    "valid": false,
    "errors": [
        "Unknown variable 'unknownField' in template"
    ],
    "warnings": [
        "Variable 'director' is rarely available in metadata"
    ],
    "sampleOutput": null
}
```

### GET /api/fuse/rules/variables

Get list of available template variables.

**Response**:
```json
{
    "variables": [
        {
            "name": "title",
            "description": "Media title",
            "example": "Inception"
        },
        {
            "name": "originalTitle",
            "description": "Original language title",
            "example": "Inception"
        },
        {
            "name": "year",
            "description": "Release year",
            "example": "2010"
        },
        {
            "name": "season",
            "description": "Season number (TV shows)",
            "example": "1",
            "modifiers": ["pad2", "pad3"]
        },
        {
            "name": "episode",
            "description": "Episode number (TV shows)",
            "example": "5",
            "modifiers": ["pad2", "pad3"]
        },
        {
            "name": "fileName",
            "description": "Original filename",
            "example": "Movie.2024.1080p.mkv"
        },
        {
            "name": "extension",
            "description": "File extension",
            "example": "mkv"
        },
        {
            "name": "fileType",
            "description": "Type of file",
            "example": "video"
        },
        {
            "name": "genre",
            "description": "Primary genre",
            "example": "Action"
        }
    ]
}
```

---

## Service Discovery

### GET /api/services

List all discovered MetaMesh services.

**Response**:
```json
{
    "services": [
        {
            "name": "meta-sort",
            "url": "http://meta-sort-dev",
            "api": "http://meta-sort-dev/api",
            "status": "healthy",
            "role": "writer"
        },
        {
            "name": "meta-fuse",
            "url": "http://meta-fuse-dev",
            "api": "http://meta-fuse-dev/api",
            "status": "healthy",
            "role": "reader"
        },
        {
            "name": "meta-stremio",
            "url": "http://meta-stremio-dev",
            "api": "http://meta-stremio-dev/api",
            "status": "healthy",
            "role": "reader"
        }
    ],
    "current": "meta-fuse",
    "leader": {
        "hostname": "meta-core-dev",
        "baseUrl": "http://localhost:8083",
        "apiUrl": "http://meta-core:9000",
        "redisUrl": "redis://meta-core:6379",
        "webdavUrl": "http://localhost:8083/webdav"
    }
}
```

---

## Error Responses

All endpoints may return these error responses:

### 400 Bad Request

Missing or invalid parameters.

```json
{
    "error": "Missing or invalid \"path\" parameter"
}
```

### 404 Not Found

Resource not found.

```json
{
    "error": "File not found"
}
```

### 500 Internal Server Error

Server-side error.

```json
{
    "error": "Failed to process request"
}
```

---

## Template Syntax

### Basic Variables

```
{variableName}        → Replaced with metadata value
{title}               → "Inception"
{year}                → "2010"
```

### Variable with Fallback

```
{title|originalTitle} → Uses title, falls back to originalTitle
{genre|"Unknown"}     → Uses genre, falls back to literal "Unknown"
```

### Variable Modifiers

```
{season:pad2}         → "01" (zero-padded to 2 digits)
{episode:pad3}        → "001" (zero-padded to 3 digits)
{title:lower}         → "inception" (lowercase)
{title:upper}         → "INCEPTION" (uppercase)
```

### Condition Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `equals` | Exact match | `{ "field": "fileType", "operator": "equals", "value": "video" }` |
| `notEquals` | Not equal | `{ "field": "fileType", "operator": "notEquals", "value": "subtitle" }` |
| `contains` | Contains substring | `{ "field": "title", "operator": "contains", "value": "Star" }` |
| `startsWith` | Starts with | `{ "field": "fileName", "operator": "startsWith", "value": "[" }` |
| `endsWith` | Ends with | `{ "field": "extension", "operator": "endsWith", "value": "mkv" }` |
| `exists` | Field exists | `{ "field": "season", "operator": "exists" }` |
| `notExists` | Field missing | `{ "field": "season", "operator": "notExists" }` |
| `greaterThan` | Numeric > | `{ "field": "year", "operator": "greaterThan", "value": "2000" }` |
| `lessThan` | Numeric < | `{ "field": "season", "operator": "lessThan", "value": "10" }` |

### Condition Groups

```json
{
    "operator": "and",
    "conditions": [
        { "field": "fileType", "operator": "equals", "value": "video" },
        {
            "operator": "or",
            "conditions": [
                { "field": "mediaType", "operator": "equals", "value": "movie" },
                { "field": "mediaType", "operator": "equals", "value": "tv" }
            ]
        }
    ]
}
```

---

## Related Documentation

- [README](../README.md) - Service overview
- [VFS Rebuild Architecture](vfs-rebuild-architecture.md) - State management
- [Streaming Architecture](streaming-architecture.md) - Event processing
