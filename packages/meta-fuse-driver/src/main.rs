mod api_client;

use api_client::ApiClient;
use base64::Engine;
use fuser::{
    FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData, ReplyDirectory, ReplyEntry,
    Request,
};
use libc::ENOENT;
use log::{debug, error, info};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::File;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(1);
const ROOT_INO: u64 = 1;
const CACHE_TTL: Duration = Duration::from_secs(30);
const ERROR_FILE_INO: u64 = 2;
const API_ERROR_THRESHOLD: usize = 3;

/// Cached directory entry
#[derive(Clone)]
struct CachedDirEntry {
    entries: Vec<String>,
    timestamp: SystemTime,
}

/// Cached file attributes
#[derive(Clone)]
struct CachedAttrs {
    attrs: api_client::FileAttributes,
    timestamp: SystemTime,
}

/// API health tracker
struct ApiHealth {
    consecutive_errors: usize,
    last_error_message: String,
    last_error_time: Option<SystemTime>,
}

impl ApiHealth {
    fn new() -> Self {
        ApiHealth {
            consecutive_errors: 0,
            last_error_message: String::new(),
            last_error_time: None,
        }
    }

    fn record_success(&mut self) {
        self.consecutive_errors = 0;
    }

    fn record_error(&mut self, message: String) {
        self.consecutive_errors += 1;
        self.last_error_message = message;
        self.last_error_time = Some(SystemTime::now());
        if self.consecutive_errors >= API_ERROR_THRESHOLD {
            error!("API has failed {} consecutive times. ERROR.txt will be displayed.", self.consecutive_errors);
        }
    }

    fn is_unhealthy(&self) -> bool {
        self.consecutive_errors >= API_ERROR_THRESHOLD
    }

    fn get_error_content(&self) -> String {
        let timestamp = self.last_error_time
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        format!(
            "Meta-Fuse FUSE Driver - API Connection Error\n\
            =============================================\n\n\
            The FUSE driver is mounted, but the meta-fuse API is not responding.\n\n\
            Error Details:\n\
            - Consecutive failures: {}\n\
            - Last error: {}\n\
            - Timestamp: {}\n\n\
            Possible causes:\n\
            1. meta-fuse-core service is not running\n\
            2. API (port 3000) is not accessible\n\
            3. Network connectivity issues\n\n\
            To resolve:\n\
            1. Check if meta-fuse is running: docker ps | grep meta-fuse\n\
            2. Check API health: curl http://localhost:3000/api/fuse/health\n\
            3. Restart the container: docker restart meta-fuse\n\n\
            This ERROR.txt file will disappear once the API is responding again.\n",
            self.consecutive_errors,
            self.last_error_message,
            timestamp
        )
    }
}

/// Maps virtual paths to inode numbers
struct InodeMapper {
    path_to_ino: HashMap<String, u64>,
    ino_to_path: HashMap<u64, String>,
    next_ino: u64,
}

impl InodeMapper {
    fn new() -> Self {
        let mut mapper = InodeMapper {
            path_to_ino: HashMap::new(),
            ino_to_path: HashMap::new(),
            next_ino: ROOT_INO + 1,
        };
        mapper.path_to_ino.insert("/".to_string(), ROOT_INO);
        mapper.ino_to_path.insert(ROOT_INO, "/".to_string());
        mapper
    }

    fn get_or_create_ino(&mut self, path: &str) -> u64 {
        if let Some(&ino) = self.path_to_ino.get(path) {
            return ino;
        }

        let ino = self.next_ino;
        self.next_ino += 1;
        self.path_to_ino.insert(path.to_string(), ino);
        self.ino_to_path.insert(ino, path.to_string());
        ino
    }

    fn get_path(&self, ino: u64) -> Option<&String> {
        self.ino_to_path.get(&ino)
    }
}

struct ApiFS {
    api: ApiClient,
    inode_mapper: Arc<Mutex<InodeMapper>>,
    dir_cache: Arc<Mutex<HashMap<String, CachedDirEntry>>>,
    attr_cache: Arc<Mutex<HashMap<String, CachedAttrs>>>,
    api_health: Arc<Mutex<ApiHealth>>,
    default_uid: u32,
    default_gid: u32,
    file_perm: u16,
    dir_perm: u16,
}

impl ApiFS {
    fn new(api_url: String, uid: u32, gid: u32, file_perm: u16, dir_perm: u16) -> Result<Self, Box<dyn std::error::Error>> {
        let api = ApiClient::new(api_url)?;

        if !api.health_check()? {
            return Err("API health check failed".into());
        }

        Ok(ApiFS {
            api,
            inode_mapper: Arc::new(Mutex::new(InodeMapper::new())),
            dir_cache: Arc::new(Mutex::new(HashMap::new())),
            attr_cache: Arc::new(Mutex::new(HashMap::new())),
            api_health: Arc::new(Mutex::new(ApiHealth::new())),
            default_uid: uid,
            default_gid: gid,
            file_perm,
            dir_perm,
        })
    }

    fn is_cache_valid(timestamp: SystemTime) -> bool {
        SystemTime::now()
            .duration_since(timestamp)
            .map(|d| d < CACHE_TTL)
            .unwrap_or(false)
    }

    fn get_cached_readdir(&self, path: &str) -> Option<Vec<String>> {
        let cache = self.dir_cache.lock().unwrap();
        if let Some(cached) = cache.get(path) {
            if Self::is_cache_valid(cached.timestamp) {
                debug!("Cache hit for readdir: {}", path);
                return Some(cached.entries.clone());
            }
        }
        None
    }

    fn cache_readdir(&self, path: &str, entries: Vec<String>) {
        let mut cache = self.dir_cache.lock().unwrap();
        cache.insert(
            path.to_string(),
            CachedDirEntry {
                entries,
                timestamp: SystemTime::now(),
            },
        );
    }

    fn get_cached_attrs(&self, path: &str) -> Option<api_client::FileAttributes> {
        let cache = self.attr_cache.lock().unwrap();
        if let Some(cached) = cache.get(path) {
            if Self::is_cache_valid(cached.timestamp) {
                debug!("Cache hit for getattr: {}", path);
                return Some(cached.attrs.clone());
            }
        }
        None
    }

    fn cache_attrs(&self, path: &str, attrs: api_client::FileAttributes) {
        let mut cache = self.attr_cache.lock().unwrap();
        cache.insert(
            path.to_string(),
            CachedAttrs {
                attrs,
                timestamp: SystemTime::now(),
            },
        );
    }

    fn get_error_file_attrs(&self) -> FileAttr {
        let content = self.api_health.lock().unwrap().get_error_content();
        let size = content.len() as u64;

        FileAttr {
            ino: ERROR_FILE_INO,
            size,
            blocks: (size + 511) / 512,
            atime: UNIX_EPOCH + Duration::from_secs(0),
            mtime: UNIX_EPOCH + Duration::from_secs(0),
            ctime: UNIX_EPOCH + Duration::from_secs(0),
            crtime: UNIX_EPOCH,
            kind: FileType::RegularFile,
            perm: 0o444,
            nlink: 1,
            uid: self.default_uid,
            gid: self.default_gid,
            rdev: 0,
            blksize: 512,
            flags: 0,
        }
    }

    fn convert_attrs(&self, path: &str, api_attrs: api_client::FileAttributes) -> FileAttr {
        let ino = {
            let mut mapper = self.inode_mapper.lock().unwrap();
            mapper.get_or_create_ino(path)
        };

        let kind = if api_attrs.mode & 0o040000 != 0 {
            FileType::Directory
        } else {
            FileType::RegularFile
        };

        let perm = if kind == FileType::Directory {
            self.dir_perm
        } else {
            self.file_perm
        };

        FileAttr {
            ino,
            size: api_attrs.size,
            blocks: (api_attrs.size + 511) / 512,
            atime: UNIX_EPOCH + Duration::from_secs_f64(api_attrs.atime),
            mtime: UNIX_EPOCH + Duration::from_secs_f64(api_attrs.mtime),
            ctime: UNIX_EPOCH + Duration::from_secs_f64(api_attrs.ctime),
            crtime: UNIX_EPOCH,
            kind,
            perm,
            nlink: api_attrs.nlink,
            uid: self.default_uid,
            gid: self.default_gid,
            rdev: 0,
            blksize: 512,
            flags: 0,
        }
    }

    fn read_file_content(
        &self,
        read_result: &api_client::ReadResult,
        offset: usize,
        size: usize,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        if let Some(ref content_b64) = read_result.content {
            let content = base64::prelude::BASE64_STANDARD.decode(content_b64)?;
            let end = std::cmp::min(offset + size, content.len());
            if offset >= content.len() {
                return Ok(vec![]);
            }
            return Ok(content[offset..end].to_vec());
        }

        if let Some(ref source_path) = read_result.source_path {
            let mut file = File::open(source_path)?;

            if offset > 0 {
                use std::io::Seek;
                file.seek(std::io::SeekFrom::Start(offset as u64))?;
            }

            let mut buffer = vec![0u8; size];
            let bytes_read = file.read(&mut buffer)?;
            buffer.truncate(bytes_read);

            return Ok(buffer);
        }

        Err("No content or source path available".into())
    }
}

impl Filesystem for ApiFS {
    fn lookup(&mut self, _req: &Request, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let name_str = match name.to_str() {
            Some(s) => s,
            None => {
                error!("Invalid UTF-8 in filename");
                reply.error(ENOENT);
                return;
            }
        };

        if parent == ROOT_INO && name_str == "ERROR.txt" {
            let is_unhealthy = self.api_health.lock().unwrap().is_unhealthy();
            if is_unhealthy {
                let attr = self.get_error_file_attrs();
                reply.entry(&TTL, &attr, 0);
                return;
            }
        }

        let parent_path = {
            let mapper = self.inode_mapper.lock().unwrap();
            match mapper.get_path(parent) {
                Some(p) => p.clone(),
                None => {
                    error!("Parent inode {} not found", parent);
                    reply.error(ENOENT);
                    return;
                }
            }
        };

        let child_path = if parent_path == "/" {
            format!("/{}", name_str)
        } else {
            format!("{}/{}", parent_path, name_str)
        };

        debug!("lookup: parent={} name={} -> {}", parent, name_str, child_path);

        if let Some(cached_attrs) = self.get_cached_attrs(&child_path) {
            let attr = self.convert_attrs(&child_path, cached_attrs);
            reply.entry(&TTL, &attr, 0);
            return;
        }

        match self.api.getattr(&child_path) {
            Ok(api_attrs) => {
                self.api_health.lock().unwrap().record_success();
                self.cache_attrs(&child_path, api_attrs.clone());
                let attr = self.convert_attrs(&child_path, api_attrs);
                reply.entry(&TTL, &attr, 0);
            }
            Err(e) => {
                self.api_health.lock().unwrap().record_error(format!("lookup failed for {}: {}", child_path, e));
                debug!("lookup failed for {}: {}", child_path, e);
                reply.error(ENOENT);
            }
        }
    }

    fn getattr(&mut self, _req: &Request, ino: u64, reply: ReplyAttr) {
        if ino == ERROR_FILE_INO {
            let is_unhealthy = self.api_health.lock().unwrap().is_unhealthy();
            if is_unhealthy {
                let attr = self.get_error_file_attrs();
                reply.attr(&TTL, &attr);
                return;
            } else {
                reply.error(ENOENT);
                return;
            }
        }

        let path = {
            let mapper = self.inode_mapper.lock().unwrap();
            match mapper.get_path(ino) {
                Some(p) => p.clone(),
                None => {
                    error!("Inode {} not found", ino);
                    reply.error(ENOENT);
                    return;
                }
            }
        };

        debug!("getattr: ino={} path={}", ino, path);

        if let Some(cached_attrs) = self.get_cached_attrs(&path) {
            let attr = self.convert_attrs(&path, cached_attrs);
            reply.attr(&TTL, &attr);
            return;
        }

        match self.api.getattr(&path) {
            Ok(api_attrs) => {
                self.api_health.lock().unwrap().record_success();
                self.cache_attrs(&path, api_attrs.clone());
                let attr = self.convert_attrs(&path, api_attrs);
                reply.attr(&TTL, &attr);
            }
            Err(e) => {
                self.api_health.lock().unwrap().record_error(format!("getattr failed for {}: {}", path, e));
                error!("getattr failed for {}: {}", path, e);
                reply.error(ENOENT);
            }
        }
    }

    fn read(
        &mut self,
        _req: &Request,
        ino: u64,
        _fh: u64,
        offset: i64,
        size: u32,
        _flags: i32,
        _lock: Option<u64>,
        reply: ReplyData,
    ) {
        if ino == ERROR_FILE_INO {
            let content = self.api_health.lock().unwrap().get_error_content();
            let content_bytes = content.as_bytes();
            let offset = offset as usize;
            let size = size as usize;

            if offset >= content_bytes.len() {
                reply.data(&[]);
                return;
            }

            let end = std::cmp::min(offset + size, content_bytes.len());
            reply.data(&content_bytes[offset..end]);
            return;
        }

        let path = {
            let mapper = self.inode_mapper.lock().unwrap();
            match mapper.get_path(ino) {
                Some(p) => p.clone(),
                None => {
                    error!("Inode {} not found", ino);
                    reply.error(ENOENT);
                    return;
                }
            }
        };

        debug!("read: ino={} path={} offset={} size={}", ino, path, offset, size);

        match self.api.read(&path) {
            Ok(read_result) => {
                self.api_health.lock().unwrap().record_success();
                match self.read_file_content(&read_result, offset as usize, size as usize) {
                    Ok(data) => reply.data(&data),
                    Err(e) => {
                        error!("Failed to read file content for {}: {}", path, e);
                        reply.error(libc::EIO);
                    }
                }
            }
            Err(e) => {
                self.api_health.lock().unwrap().record_error(format!("read API call failed for {}: {}", path, e));
                error!("read API call failed for {}: {}", path, e);
                reply.error(ENOENT);
            }
        }
    }

    fn readdir(
        &mut self,
        _req: &Request,
        ino: u64,
        _fh: u64,
        offset: i64,
        mut reply: ReplyDirectory,
    ) {
        let path = {
            let mapper = self.inode_mapper.lock().unwrap();
            match mapper.get_path(ino) {
                Some(p) => p.clone(),
                None => {
                    error!("Inode {} not found", ino);
                    reply.error(ENOENT);
                    return;
                }
            }
        };

        debug!("readdir: ino={} path={} offset={}", ino, path, offset);

        let entries = if let Some(cached_entries) = self.get_cached_readdir(&path) {
            cached_entries
        } else {
            match self.api.readdir(&path) {
                Ok(entries) => {
                    self.api_health.lock().unwrap().record_success();
                    self.cache_readdir(&path, entries.clone());
                    entries
                }
                Err(e) => {
                    self.api_health.lock().unwrap().record_error(format!("readdir failed for {}: {}", path, e));
                    error!("readdir failed for {}: {}", path, e);
                    reply.error(ENOENT);
                    return;
                }
            }
        };

        let mut full_entries = vec![
            (ino, FileType::Directory, ".".to_string()),
            (ino, FileType::Directory, "..".to_string()),
        ];

        if ino == ROOT_INO {
            let is_unhealthy = self.api_health.lock().unwrap().is_unhealthy();
            if is_unhealthy {
                full_entries.push((ERROR_FILE_INO, FileType::RegularFile, "ERROR.txt".to_string()));
            }
        }

        for entry_name in entries {
            let entry_path = if path == "/" {
                format!("/{}", entry_name)
            } else {
                format!("{}/{}", path, entry_name)
            };

            let entry_ino = {
                let mut mapper = self.inode_mapper.lock().unwrap();
                mapper.get_or_create_ino(&entry_path)
            };

            let file_type = if let Some(cached_attrs) = self.get_cached_attrs(&entry_path) {
                if cached_attrs.mode & 0o040000 != 0 {
                    FileType::Directory
                } else {
                    FileType::RegularFile
                }
            } else {
                match self.api.getattr(&entry_path) {
                    Ok(attrs) => {
                        self.cache_attrs(&entry_path, attrs.clone());
                        if attrs.mode & 0o040000 != 0 {
                            FileType::Directory
                        } else {
                            FileType::RegularFile
                        }
                    }
                    Err(_) => FileType::RegularFile,
                }
            };

            full_entries.push((entry_ino, file_type, entry_name));
        }

        for (i, entry) in full_entries.into_iter().enumerate().skip(offset as usize) {
            if reply.add(entry.0, (i + 1) as i64, entry.1, entry.2) {
                break;
            }
        }
        reply.ok();
    }
}

fn main() {
    env_logger::init();

    let args: Vec<String> = std::env::args().collect();

    if args.len() < 2 || args.len() > 5 {
        eprintln!("Usage: {} <mountpoint> [api-url] [uid] [gid]", args[0]);
        eprintln!("\nExample: {} /mnt/virtual http://localhost:3000 1000 1000", args[0]);
        eprintln!("         {} /mnt/virtual (defaults: http://localhost:3000, uid=1000, gid=1000)", args[0]);
        eprintln!("\nEnvironment variables:");
        eprintln!("  PUID            - User ID for file ownership (default: 1000)");
        eprintln!("  PGID            - Group ID for file ownership (default: 1000)");
        eprintln!("  FUSE_FILE_PERM  - File permissions in octal (default: 755)");
        eprintln!("  FUSE_DIR_PERM   - Directory permissions in octal (default: 755)");
        eprintln!("  FUSE_API_URL    - API URL (default: http://localhost:3000)");
        std::process::exit(1);
    }

    let mountpoint = &args[1];
    let api_url = if args.len() >= 3 {
        args[2].clone()
    } else {
        std::env::var("FUSE_API_URL").unwrap_or_else(|_| "http://localhost:3000".to_string())
    };

    let uid: u32 = if args.len() >= 4 {
        args[3].parse().unwrap_or_else(|_| {
            eprintln!("Error: Invalid UID value");
            std::process::exit(1);
        })
    } else {
        std::env::var("PUID")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1000)
    };

    let gid: u32 = if args.len() >= 5 {
        args[4].parse().unwrap_or_else(|_| {
            eprintln!("Error: Invalid GID value");
            std::process::exit(1);
        })
    } else {
        std::env::var("PGID")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1000)
    };

    let file_perm: u16 = std::env::var("FUSE_FILE_PERM")
        .ok()
        .and_then(|v| u16::from_str_radix(&v, 8).ok())
        .unwrap_or(0o755);

    let dir_perm: u16 = std::env::var("FUSE_DIR_PERM")
        .ok()
        .and_then(|v| u16::from_str_radix(&v, 8).ok())
        .unwrap_or(0o755);

    info!("Connecting to API at: {}", api_url);
    info!("File ownership: uid={}, gid={}", uid, gid);
    info!("File permissions: {:o} (files), {:o} (directories)", file_perm, dir_perm);

    let fs = match ApiFS::new(api_url.clone(), uid, gid, file_perm, dir_perm) {
        Ok(fs) => {
            info!("Successfully connected to meta-fuse API");
            fs
        }
        Err(e) => {
            error!("Failed to connect to API at {}: {}", api_url, e);
            eprintln!("Error: Failed to connect to API at {}: {}", api_url, e);
            eprintln!("\nMake sure meta-fuse-core is running.");
            std::process::exit(1);
        }
    };

    info!("Mounting filesystem at: {}", mountpoint);

    let options = vec![
        MountOption::RO,
        MountOption::FSName("meta-fuse".to_string()),
        MountOption::AutoUnmount,
        MountOption::AllowOther,
    ];

    match fuser::mount2(fs, mountpoint, &options) {
        Ok(()) => {
            info!("Filesystem unmounted successfully");
        }
        Err(e) => {
            error!("Mount failed: {}", e);
            eprintln!("Error: Failed to mount filesystem: {}", e);
            eprintln!("\nPossible causes:");
            eprintln!("1. Mount point does not exist or is not accessible");
            eprintln!("2. FUSE module is not loaded (try: modprobe fuse)");
            eprintln!("3. /etc/fuse.conf missing 'user_allow_other' option");
            eprintln!("   To fix: echo 'user_allow_other' | sudo tee -a /etc/fuse.conf");
            std::process::exit(1);
        }
    }
}
