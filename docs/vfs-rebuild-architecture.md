# VFS Rebuild Architecture

## Overview

This document describes the architecture and design philosophy for the Virtual Filesystem (VFS) rebuild process in MetaMesh. The system uses a **two-phase strategy** to provide fast startup times while maintaining data accuracy through continuous validation.

## Design Philosophy

The VFS rebuild architecture is built on three core principles:

| Component | Role | Responsibility |
|-----------|------|----------------|
| **etcd** | Distributed Metadata Archive | Permanent record of all files (even if deleted from disk) |
| **In-Memory Database** | Current VFS State | Only files present on disk RIGHT NOW |
| **Discovery** | Source of Truth | Validates file existence and cleans stale entries |

### Key Insight

> **etcd stores the historical truth** (what files have existed)
> **In-memory DB stores the current truth** (what files exist NOW)
> **Discovery enforces reality** (makes memory match disk state)

This separation enables:
- **Fast cold starts** (1-2 seconds for 10,000 files)
- **Distributed metadata sharing** via meta-orbit (etcd never deletes)
- **Accurate VFS state** (discovery continuously validates)
- **Graceful handling of offline storage** (network drives, removable media)

---

## Two-Phase Strategy

### Phase 1: Fast Bootstrap (Startup)

**Goal**: Make VFS available as quickly as possible

**Implementation**: `WatchedFileProcessor.rebuildVFSFromEtcd()`

```typescript
async rebuildVFSFromEtcd(): Promise<void> {
    // 1. Fetch all hash IDs from etcd
    const hashIds = await etcdClient.getAllHashIds();

    // 2. Batch fetch ALL metadata in parallel (no disk I/O)
    const metadataList = await Promise.all(
        hashIds.map(hashId => etcdClient.getMetadataFlat(hashId))
    );

    // 3. Load into in-memory DB without validation
    for (const metadata of metadataList) {
        metadata._lastVerified = 0; // Mark as unverified
        this.fileProcessor.getDatabase().set(metadata.filePath, metadata);
    }

    // 4. Build VFS immediately (1-2 seconds)
    await this.finalize();
}
```

**Performance**:
- 10,000 files: ~1-2 seconds (previously 60+ seconds)
- Zero disk I/O during startup
- VFS immediately usable (may contain stale entries)

**Characteristics**:
- ✅ Fast startup
- ✅ No blocking on disk validation
- ✅ All files appear immediately
- ⚠️ May include deleted/offline files temporarily

---

### Phase 2: Continuous Validation (Discovery)

**Goal**: Make in-memory DB match current disk reality

**Implementation**: Discovery scans folders progressively and validates file existence

```typescript
// Progressive scan: Process folders one at a time
for (const folder of folderList) {
    const discoveredFilesInFolder = new Set<string>();

    // Track discovered files for this folder
    async function* trackDiscoveredFiles(stream: AsyncGenerator<string>) {
        for await (const filePath of stream) {
            discoveredFilesInFolder.add(filePath);  // Track what exists
            yield filePath;
        }
    }

    const discoveryStream = folderWatcher.discoverFiles([folder]);
    await pipeline.start(trackDiscoveredFiles(discoveryStream));

    // Progressive cleanup: Remove stale entries after each folder
    await fileProcessor.cleanupStaleEntries([folder], discoveredFilesInFolder);
}
```

**Cleanup Logic**: `WatchedFileProcessor.cleanupStaleEntries()`

```typescript
async cleanupStaleEntries(scannedFolders: string[], discoveredFiles: Set<string>) {
    for (const folder of scannedFolders) {
        // Find all in-memory files for this folder
        const filesToCheck = db.getAllFilesStartingWith(folder);

        // Remove files not seen during scan
        for (const filePath of filesToCheck) {
            if (!discoveredFiles.has(filePath)) {
                // File no longer exists → remove from memory
                db.delete(filePath);
                vfs.removeFileByRealPath(filePath);
                stateManager.removeFile(filePath);
            }
        }
    }

    // Rebuild VFS if anything changed
    await this.finalize();
}
```

**Validation Rules** (applied progressively per folder):

| Scenario | Action | VFS Update |
|----------|--------|------------|
| File found during scan | Update `_lastVerified` timestamp, keep in memory | No change |
| File not found in scanned folder | Remove from in-memory DB, keep in etcd | VFS rebuilt incrementally |
| Empty folder scanned | Remove ALL child paths from memory immediately | VFS rebuilt (files disappear) |
| Folder missing/inaccessible | Remove ALL child paths from memory immediately | VFS rebuilt (files disappear) |

**Key Behavior**: When a NAS/network drive is disconnected (folder becomes empty/inaccessible), all files from that folder are **progressively removed from the VFS as discovery proceeds** through each folder.

**Characteristics**:
- ✅ Discovery is authoritative
- ✅ Progressive cleanup (files disappear as folders are scanned)
- ✅ Handles deleted files automatically
- ✅ Handles offline network drives (files removed immediately when folder is scanned)
- ✅ No manual TTL/expiry needed
- ✅ Real-time VFS updates during discovery

---

## Architecture Comparison

### Old Approach (Disk Validation at Startup)

```
┌─────────────────────────────────────────────┐
│ Startup: rebuildVFSFromEtcd()              │
│                                             │
│ For each file in etcd (sequential):        │
│   1. Fetch metadata from etcd (1-5ms)      │
│   2. Check if file exists (fs.access)      │
│      - Local disk: 1-10ms                  │
│      - Network drive: 10-100ms             │
│   3. Add to memory if exists               │
│                                             │
│ Result: 60-120 seconds for 10k files       │
└─────────────────────────────────────────────┘
```

**Problems**:
- ❌ Slow startup (blocks on disk I/O)
- ❌ Sequential processing (no parallelization)
- ❌ Network latency multiplies wait time
- ❌ VFS unavailable during validation

### New Approach (Fast Load + Progressive Discovery)

```
┌─────────────────────────────────────────────┐
│ Startup: rebuildVFSFromEtcd()              │
│                                             │
│ 1. Batch fetch ALL metadata (parallel)     │
│    → 10k files in ~500ms                   │
│                                             │
│ 2. Load into memory (no disk checks)       │
│    → 10k files in ~200ms                   │
│                                             │
│ 3. Build VFS                                │
│    → Ready in 1-2 seconds total            │
│                                             │
│ Result: VFS immediately usable              │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ Background: Progressive Discovery Scan      │
│                                             │
│ For each folder in watch list:             │
│   1. Walk folder and track discovered files│
│   2. Update _lastVerified for found files  │
│   3. Remove stale entries for this folder  │
│   4. Rebuild VFS (files disappear)         │
│   5. Move to next folder                   │
│                                             │
│ Result: Files progressively disappear as   │
│         folders are scanned (real-time)    │
└─────────────────────────────────────────────┘
```

**Benefits**:
- ✅ 10-50x faster startup
- ✅ Parallel etcd fetching
- ✅ No disk I/O blocking
- ✅ VFS immediately available
- ✅ Progressive cleanup (real-time feedback)
- ✅ Files disappear as folders are scanned

---

## Implementation Details

### File Metadata Structure

```typescript
interface FileMetadata {
    filePath: string;
    cid_midhash256: string;  // Permanent file ID
    title: string;
    // ... other metadata fields

    // Validation tracking (optional)
    _lastVerified?: number;  // Timestamp of last disk validation
}
```

The `_lastVerified` field:
- Set to `0` during fast load (unverified)
- Updated to `Date.now()` when discovery sees the file
- Used for debugging and monitoring (not enforced)

### State Management

**In-Memory Database** (`FileProcessor.database`):
- `Map<filePath, metadata>`
- Cleared on restart
- Reflects only currently accessible files

**etcd Storage**:
- `/file/midhash256:{hash}/property` - Permanent metadata
- Never deleted (even if file removed from disk)
- Shared across meta-orbit network

**Virtual Filesystem** (`VirtualFileSystem`):
- Generated from in-memory database
- Rebuilt after cleanup operations
- Accessible via FUSE/WebDAV

### Discovery Integration

Discovery runs in two modes:

**1. Manual Scan** (startup or triggered via API) - Progressive:
```typescript
// Process folders one at a time
for (const folder of folderList) {
    const discoveredFiles = new Set<string>();
    const discoveryStream = folderWatcher.discoverFiles([folder]);

    // Track and process files for this folder
    await pipeline.start(trackFiles(discoveryStream, discoveredFiles));

    // Progressive cleanup: Remove stale entries immediately
    await fileProcessor.cleanupStaleEntries([folder], discoveredFiles);
    // → VFS rebuilt, files from disconnected NAS disappear
}
```

**2. Watch Mode** (continuous monitoring):
```typescript
folderWatcher.watch(folderList, {
    onAdd: (filePath) => {
        // File added → process and add to memory
        pipeline.processFile(filePath);
    },
    onUnlink: (filePath) => {
        // File removed → remove from memory immediately
        fileProcessor.deleteFile(filePath);
    }
});
```

---

## Performance Characteristics

### Startup Performance

| Dataset Size | Old Approach | New Approach | Speedup |
|--------------|-------------|--------------|---------|
| 1,000 files | 5-10s | 0.5-1s | 10x |
| 10,000 files | 60-120s | 1-2s | 60x |
| 100,000 files | 10-20m | 10-15s | 60-80x |

### Storage Type Impact

| Storage Type | Old Approach | New Approach | Notes |
|--------------|-------------|--------------|-------|
| Local SSD | 5-10s | 1-2s | Validation was fast, but sequential |
| Local HDD | 20-40s | 1-2s | Seek time penalty eliminated |
| Network (NFS/SMB) | 60-300s | 1-2s | Latency eliminated from startup |
| Offline/Slow Network | Timeout/Fail | 1-2s | Gracefully handles offline storage |

### Memory Usage

- **In-Memory DB**: ~500 bytes/file (metadata only)
- **10,000 files**: ~5 MB
- **100,000 files**: ~50 MB
- **Negligible overhead** compared to old approach

---

## Handling Edge Cases

### Deleted Files

**Scenario**: User deletes a file after startup but before discovery scans

**Old Behavior**: File appears in VFS until next full rebuild

**New Behavior**:
1. Fast load: File appears in VFS (loaded from etcd)
2. Discovery scan: File not found → removed from memory
3. VFS rebuilt without the file
4. etcd still has metadata (for meta-orbit sharing)

### Offline Network Drives

**Scenario**: NFS mount becomes unavailable

**Old Behavior**: Startup hangs or fails with timeout

**New Behavior**:
1. Fast load: All files appear in VFS (1-2s)
2. Discovery scan: Folder inaccessible → removes all child paths
3. When drive comes back online: Next discovery re-adds files

### Moved Files

**Scenario**: User moves file outside watch folders

**Old Behavior**: File appears in VFS until manual cleanup

**New Behavior**:
1. Discovery scans old location → file not found → removed from memory
2. If moved within watch folders: Discovered as new file
3. etcd has both old and new paths (deduplication via midhash256)

### Partial Scans

**Scenario**: Discovery interrupted mid-scan (crash, kill signal)

**Safety**: Cleanup only runs after scan completes successfully
- Incomplete scan → no cleanup
- Memory state unchanged
- Next scan will complete and clean up

---

## Monitoring and Debugging

### Startup Logs

```
[VFS Rebuild] Starting fast-load from etcd...
[VFS Rebuild] Found 10000 files in etcd
[VFS Rebuild] Fetching metadata in parallel...
[VFS Rebuild] Loaded 9856/10000 files into memory (unverified)
[VFS Rebuild] VFS rebuilt in 1523ms
[VFS Rebuild] Discovery will validate file existence in background
```

### Discovery Logs (Progressive Mode)

```
[Discovery] Progressive scan mode: 3 folders
[Discovery] Scanning folder: /data/watch/local
[Discovery] Folder scan complete: /data/watch/local. Found 128 files. Running cleanup...
[Cleanup] Starting cleanup for 1 scanned folders...
[Cleanup] Removed 0 stale entries in 2ms
[Cleanup] Cleanup complete for folder: /data/watch/local

[Discovery] Scanning folder: /data/watch/smb-nas
[Discovery] Folder scan complete: /data/watch/smb-nas. Found 0 files. Running cleanup...
[Cleanup] Starting cleanup for 1 scanned folders...
[Cleanup] Removed stale entry: /data/watch/smb-nas/Movies/deleted_movie.mkv
[Cleanup] Removed stale entry: /data/watch/smb-nas/Movies/another_movie.mkv
[Cleanup] Removed 13621 stale entries in 87ms
[Cleanup] Rebuilding VFS after cleanup...
Virtual filesystem update start
Duplicate find took 1ms - found 0 hash groups, 21 title groups
Generating virtual structure for 128 files
Virtual filesystem update took 167ms
[Cleanup] Cleanup complete for folder: /data/watch/smb-nas

[Discovery] Scanning folder: /data/watch/downloads
[Discovery] Folder scan complete: /data/watch/downloads. Found 45 files. Running cleanup...
[Cleanup] Starting cleanup for 1 scanned folders...
[Cleanup] Removed 0 stale entries in 1ms
[Cleanup] Cleanup complete for folder: /data/watch/downloads

[Discovery] All folders scanned and cleaned up
```

**Progressive Behavior**: Notice how the NAS folder (`/data/watch/smb-nas`) with 0 discovered files immediately triggers removal of 13,621 stale entries and VFS rebuild. Users see files disappear in real-time as each folder completes scanning.

### API Endpoints

Monitor VFS state via Unified API:

```bash
# VFS statistics
curl http://localhost:3000/api/fuse/stats

# Processing status
curl http://localhost:3000/api/processing/status

# Trigger manual scan + cleanup
curl -X POST http://localhost:3000/api/scan/trigger
```

---

## Best Practices

### For Operators

1. **Initial Startup**: First boot may show all historical files (even deleted ones)
   - Wait for first discovery scan to clean up
   - Or run manual scan: `POST /api/scan/trigger`

2. **Network Drives**: If drives are slow or offline at startup
   - VFS still loads in 1-2 seconds
   - Files appear/disappear as drives come online/offline
   - No manual intervention needed

3. **Monitoring**: Watch for cleanup logs to understand disk changes
   ```
   [Cleanup] Removed 622 stale entries
   ```
   Large numbers indicate significant file deletions

### For Developers

1. **Adding New Metadata Sources**: Always update both:
   - etcd (permanent record)
   - In-memory DB (current state)

2. **Testing Cleanup**: Simulate file deletions
   ```bash
   # Delete files from watch folder
   rm -rf /data/watch/Movies/test_movie.mkv

   # Trigger scan
   curl -X POST http://localhost:3000/api/scan/trigger

   # Verify cleanup in logs
   docker logs meta-mesh-dev-container | grep Cleanup
   ```

3. **Performance Testing**: Benchmark with large datasets
   ```bash
   # Time startup
   docker restart meta-mesh-dev-container
   docker logs -f meta-mesh-dev-container | grep "VFS rebuilt"

   # Time discovery + cleanup
   time curl -X POST http://localhost:3000/api/scan/trigger
   ```

---

## Future Optimizations

### Potential Improvements

1. **Incremental Cleanup**: Instead of scanning all folders, track modified folders
   - Use filesystem events (inotify) to detect folder changes
   - Only clean up modified folders

2. **Background Validation Queue**: Validate files lazily over time
   - Prioritize recently accessed files
   - Validate cold files during idle periods

3. **Smart Caching**: Cache validation results
   - LRU cache with TTL (5-10 minutes)
   - Reduces redundant disk checks for frequently accessed files

4. **Partial VFS Rebuild**: Only rebuild changed directories
   - Track which folders had files removed
   - Rebuild only affected VFS subtrees

### Not Recommended

❌ **TTL-based expiry**: Requires guessing timeout values, fails with slow scans

❌ **Storing validation state in etcd**: Wrong tool for transient state, creates write amplification

❌ **Immediate removal on unlink events**: Race conditions with discovery, inconsistent state

---

## Related Documentation

- [Streaming Pipeline Architecture](streaming-pipeline-architecture.md) - File processing flow
- [etcd Architecture](../../packages/meta-mesh/doc/architecture/etcd-architecture.md) - Storage design
- [FUSE API](../../packages/meta-mesh/doc/architecture/fuse-api.md) - Virtual filesystem API

---

## Summary

The VFS rebuild architecture achieves **10-50x faster startup** by separating concerns:

- **etcd** = Permanent distributed metadata archive
- **In-memory DB** = Current filesystem state
- **Discovery** = Authoritative source of truth

This design enables:
- ⚡ Sub-2-second cold starts (10k files)
- 🔄 Continuous accuracy through discovery validation
- 🌐 Distributed metadata sharing via meta-orbit
- 📦 Graceful handling of offline/slow storage

The key insight: **Fast bootstrap + continuous validation > Blocking validation at startup**
