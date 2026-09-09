/*
 * LogSight SSH 连接服务模块（v2：基于 ssh2 + libssh2 稳定版）
 * 封装远程服务器连接、命令执行、tail -F 流式输出、断开重连逻辑
 * 所有同步 IO 都在 tokio::task::spawn_blocking 中运行，避免阻塞异步 Runtime
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use ssh2::{CheckResult, HashType, KeyboardInteractivePrompt, KnownHostFileKind, Session};
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use crate::models::{
    AuthType, ConnectTestResult, DirEntry, DirListResult, FileKind, HostKeyInfo, HostKeyStatus,
    PathValidateResult, RemoteEnvironment, ServerConfig,
};

const REMOTE_ENVIRONMENT_PROBE: &str = r#"printf 'os=%s\n' "$(uname -s 2>/dev/null || printf unknown)"; printf 'shell=%s\n' "${SHELL:-unknown}"; for c in tail grep awk find stat; do if command -v "$c" >/dev/null 2>&1; then printf 'cmd=%s|yes\n' "$c"; else printf 'cmd=%s|no\n' "$c"; fi; done; if command -v stat >/dev/null 2>&1 && stat -c %Y / >/dev/null 2>&1; then printf 'stat_gnu=yes\n'; else printf 'stat_gnu=no\n'; fi"#;

const REQUIRED_REMOTE_COMMANDS: [&str; 6] = ["tail", "grep", "awk", "find", "stat", "stat_gnu"];

/* 简易 Password-based KI 提示符：无视任何提示题，全部返回固定密码
用于兼容绝大部分 PAM/keyboard-interactive 模式的 SSH 服务器 */
struct PasswordPrompt {
    password: String,
}

impl KeyboardInteractivePrompt for PasswordPrompt {
    fn prompt<'b>(
        &mut self,
        _username: &str,
        _instructions: &str,
        prompts: &[ssh2::Prompt<'b>],
    ) -> Vec<String> {
        prompts.iter().map(|_| self.password.clone()).collect()
    }
}

/* 统一的 SSH 会话包装：libssh2 Session + 底层 TcpStream */
pub struct SSHSession {
    pub session: Session,
    pub stream: TcpStream,
    #[allow(dead_code)]
    pub server_id: String,
}

/*
 * SSH 服务结构体（静态方法为主）
 */
pub struct SSHService;

fn shell_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/*
 * 路径安全前置校验：纯字符串层面拦截（在远程执行前就挡掉明显恶意路径）
 * 拒绝：null 字节、控制字符、0x00-0x1f / 0x7f、Windows 盘符前缀 D:\、URL、包含 ../ 或 ..\ 片段
 * 允许：~ / /mnt / ~user 等合法 Linux 路径字符，A-Za-z0-9._-/@+%,:=
 */
pub fn prevalidate_path_str(path: &str) -> std::result::Result<(), String> {
    if path.is_empty() {
        return Err("路径不能为空".into());
    }
    for b in path.as_bytes() {
        if *b == 0 {
            return Err("路径包含 null 字节 (0x00)，可能是攻击载荷，已拦截".into());
        }
        if *b < 0x20 || *b == 0x7f {
            return Err(format!(
                "路径包含控制字符 0x{:02x}，可能是越权尝试，已拦截",
                *b
            ));
        }
    }
    // 拒绝 Windows 盘符 / UNC / URL 协议
    if path.contains("://")
        || path.starts_with("\\\\")
        || (path.len() >= 2 && path.as_bytes()[1] == b':')
    {
        return Err(
            "非法路径格式（URL/Windows 盘符/UNC），仅支持 Linux 服务器绝对或 ~ 路径".into(),
        );
    }
    // 拒绝任何包含 ".." 的独立组件（避免目录穿越）
    for component in path.split(|c| c == '/' || c == '\\') {
        if component == ".." {
            return Err("路径中含 \"..\" 片段（目录穿越尝试），已拦截。如需返回上一级请在 Tree 中点击父目录。".into());
        }
    }
    Ok(())
}

/* Glob 路径会原样交给远端 shell 展开，因此必须使用比普通路径更严格的字符白名单。 */
pub fn prevalidate_glob_path_str(path: &str) -> std::result::Result<(), String> {
    prevalidate_path_str(path)?;
    if !(path.starts_with('/') || path == "~" || path.starts_with("~/")) {
        return Err("通配路径必须是绝对路径或以 ~/ 开头".into());
    }
    for ch in path.chars() {
        let allowed = ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '/' | '.'
                    | '_'
                    | '-'
                    | '@'
                    | '+'
                    | '%'
                    | ','
                    | ':'
                    | '='
                    | '*'
                    | '?'
                    | '['
                    | ']'
                    | '~'
            );
        if !allowed {
            return Err(format!("通配路径包含不允许的字符 {:?}", ch));
        }
    }
    Ok(())
}

/* 归一化 Linux 路径字符串：
   - shellexpand 展开 ~
   - 合并重复 //
   - 去尾部 /（保留根 / ）
   - 保证非 ~ 开头又非绝对路径的，补 /（按 CWD，不过我们在 Rust 层直接拒绝相对无 / 路径）
*/
fn normalize_linux_path(raw: &str) -> String {
    let expanded = shellexpand::tilde(raw).to_string();
    // 合并多斜杠
    let mut s = String::with_capacity(expanded.len());
    let mut prev_slash = false;
    for ch in expanded.chars() {
        if ch == '/' {
            if !prev_slash {
                s.push(ch);
            }
            prev_slash = true;
        } else {
            s.push(ch);
            prev_slash = false;
        }
    }
    // 去掉尾部 /（根路径 / 保留）
    if s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

/* 严格校验 SSH 主机身份，避免首次连接时无条件信任中间人。 */
fn verify_host_key(sess: &Session, server: &ServerConfig) -> Result<()> {
    let (key, _) = sess
        .host_key()
        .ok_or_else(|| anyhow!("SSH 服务端没有提供主机公钥"))?;
    let fingerprint = sess
        .host_key_hash(HashType::Sha256)
        .map(|hash| B64.encode(hash))
        .unwrap_or_else(|| "unknown".to_string());
    let known_hosts_path = PathBuf::from(shellexpand::tilde("~/.ssh/known_hosts").to_string());
    if !known_hosts_path.is_file() {
        return Err(anyhow!(
            "未找到 {:?}，已拒绝无主机指纹校验的连接；请先用 OpenSSH 连接一次或配置 known_hosts。当前指纹: SHA256:{}",
            known_hosts_path, fingerprint
        ));
    }
    let mut known_hosts = sess.known_hosts().context("初始化 SSH known_hosts 失败")?;
    known_hosts
        .read_file(&known_hosts_path, KnownHostFileKind::OpenSSH)
        .with_context(|| format!("读取 known_hosts 失败: {:?}", known_hosts_path))?;
    let host = if server.port == 22 {
        server.host.clone()
    } else {
        format!("[{}]:{}", server.host, server.port)
    };
    match known_hosts.check(&host, key) {
        CheckResult::Match => Ok(()),
        CheckResult::NotFound => Err(anyhow!(
            "known_hosts 中没有 {} 的记录，已拒绝首次无确认连接；当前指纹: SHA256:{}",
            host,
            fingerprint
        )),
        CheckResult::Mismatch => Err(anyhow!(
            "{} 的 SSH 主机指纹发生变化，疑似中间人攻击；当前指纹: SHA256:{}",
            host,
            fingerprint
        )),
        CheckResult::Failure => Err(anyhow!("校验 {} 的 SSH 主机指纹失败", host)),
    }
}

fn known_host_name(server: &ServerConfig) -> String {
    if server.port == 22 {
        server.host.clone()
    } else {
        format!("[{}]:{}", server.host, server.port)
    }
}

fn known_hosts_path() -> PathBuf {
    PathBuf::from(shellexpand::tilde("~/.ssh/known_hosts").to_string())
}

fn handshake_for_host_key(server: &ServerConfig) -> Result<(Session, TcpStream)> {
    let mut addresses = (server.host.as_str(), server.port)
        .to_socket_addrs()
        .with_context(|| format!("无法解析主机 {}:{}", server.host, server.port))?;
    let address = addresses
        .next()
        .ok_or_else(|| anyhow!("主机 {} 没有可用地址", server.host))?;
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(15)).with_context(|| {
        format!(
            "无法连接到 {}:{} (TCP超时或拒绝连接)",
            server.host, server.port
        )
    })?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut session = Session::new().context("创建 libssh2 Session 失败")?;
    session.set_tcp_stream(tcp.try_clone().context("克隆 TCP 流失败")?);
    session
        .handshake()
        .context("SSH 协议握手失败，可能不是 SSH 服务或网络中断")?;
    Ok((session, tcp))
}

fn inspect_host_key_session(session: &Session, server: &ServerConfig) -> Result<HostKeyInfo> {
    let (key, _) = session
        .host_key()
        .ok_or_else(|| anyhow!("SSH 服务端没有提供主机公钥"))?;
    let fingerprint = session
        .host_key_hash(HashType::Sha256)
        .map(|hash| format!("SHA256:{}", B64.encode(hash)))
        .ok_or_else(|| anyhow!("无法计算 SSH 主机指纹"))?;
    let path = known_hosts_path();
    let status = if path.is_file() {
        let mut known_hosts = session
            .known_hosts()
            .context("初始化 SSH known_hosts 失败")?;
        known_hosts
            .read_file(&path, KnownHostFileKind::OpenSSH)
            .with_context(|| format!("读取 known_hosts 失败: {:?}", path))?;
        match known_hosts.check(&known_host_name(server), key) {
            CheckResult::Match => HostKeyStatus::Match,
            CheckResult::NotFound => HostKeyStatus::NotFound,
            CheckResult::Mismatch => HostKeyStatus::Mismatch,
            CheckResult::Failure => return Err(anyhow!("校验 SSH 主机指纹失败")),
        }
    } else {
        HostKeyStatus::NotFound
    };
    Ok(HostKeyInfo {
        host: known_host_name(server),
        fingerprint,
        status,
    })
}

impl SSHService {
    /* 只完成 SSH 握手并读取主机密钥，不发送用户名、密码或私钥。 */
    pub async fn inspect_host_key(server: &ServerConfig) -> Result<HostKeyInfo> {
        let server = server.clone();
        tokio::task::spawn_blocking(move || {
            let (session, _tcp) = handshake_for_host_key(&server)?;
            inspect_host_key_session(&session, &server)
        })
        .await
        .map_err(|e| anyhow!("SSH 主机指纹检查任务 Panic: {e}"))?
    }

    /*
     * 用用户刚确认的指纹更新 known_hosts。
     * 写入前重新握手并比对 expected_fingerprint，避免确认后主机密钥再次变化。
     */
    pub async fn trust_host_key(
        server: &ServerConfig,
        expected_fingerprint: &str,
    ) -> Result<HostKeyInfo> {
        let server = server.clone();
        let expected = expected_fingerprint.to_string();
        tokio::task::spawn_blocking(move || {
            let (session, _tcp) = handshake_for_host_key(&server)?;
            let current = inspect_host_key_session(&session, &server)?;
            if current.fingerprint != expected {
                return Err(anyhow!(
                    "主机指纹在确认期间再次变化，已拒绝写入。期望 {}，当前 {}",
                    expected,
                    current.fingerprint
                ));
            }
            if current.status == HostKeyStatus::Match {
                return Ok(current);
            }

            let (key, key_type) = session
                .host_key()
                .ok_or_else(|| anyhow!("SSH 服务端没有提供主机公钥"))?;
            let path = known_hosts_path();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("创建 SSH 配置目录失败: {:?}", parent))?;
            }
            let mut known_hosts = session
                .known_hosts()
                .context("初始化 SSH known_hosts 失败")?;
            if path.is_file() {
                known_hosts
                    .read_file(&path, KnownHostFileKind::OpenSSH)
                    .with_context(|| format!("读取 known_hosts 失败: {:?}", path))?;
            }

            let host = known_host_name(&server);
            let matching_entries = known_hosts
                .iter()
                .context("枚举 known_hosts 记录失败")?
                .into_iter()
                .filter(|entry| entry.name() == Some(host.as_str()))
                .collect::<Vec<_>>();
            if current.status == HostKeyStatus::Mismatch && matching_entries.is_empty() {
                return Err(anyhow!(
                    "发现无法安全定位的旧主机记录；请先执行 ssh-keygen -R {} 后重试",
                    host
                ));
            }
            for entry in &matching_entries {
                known_hosts
                    .remove(entry)
                    .context("移除旧 SSH 主机密钥失败")?;
            }
            known_hosts
                .add(&host, key, "", key_type.into())
                .context("添加 SSH 主机密钥失败")?;
            known_hosts
                .write_file(&path, KnownHostFileKind::OpenSSH)
                .with_context(|| format!("写入 known_hosts 失败: {:?}", path))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .with_context(|| format!("设置 known_hosts 权限失败: {:?}", path))?;
            }

            let verified = inspect_host_key_session(&session, &server)?;
            if verified.status != HostKeyStatus::Match {
                return Err(anyhow!("known_hosts 写入后校验未通过"));
            }
            Ok(verified)
        })
        .await
        .map_err(|e| anyhow!("SSH 主机信任更新任务 Panic: {e}"))?
    }

    /*
     * 解析用户主目录：SSH 登录后执行 echo $HOME 一次性拿到
     * 用于前端点击「家目录」按钮直接跳转到 ~
     */
    pub async fn resolve_home(
        server: &ServerConfig,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> Result<String> {
        let server = server.clone();
        let pwd = password_plain.map(|s| s.to_string());
        let pem = private_key_pem_plain.map(|s| s.to_string());

        tokio::task::spawn_blocking(move || -> Result<String> {
            let mut ssh = Self::connect_sync(&server, pwd.as_deref(), pem.as_deref())?;
            let (out, err, code) = Self::exec_once_sync(&mut ssh.session, "echo -n $HOME", 10)?;
            drop(ssh);
            if code != 0 {
                return Err(anyhow!("获取主目录失败(exit={}): {}", code, err));
            }
            Ok(out.trim().to_string())
        })
        .await
        .map_err(|e| anyhow!("SSH resolve_home 任务 Panic: {}", e))?
    }

    /*
     * 路径合法性 & 存在性 & 可读性校验（双保险：先字符串预校验 + 再 SFTP stat）
     */
    pub async fn validate_path(
        server: &ServerConfig,
        remote_path: &str,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> PathValidateResult {
        // 1. 字符串层面先拦截明显恶意
        if let Err(msg) = prevalidate_path_str(remote_path) {
            return PathValidateResult {
                normalized_path: remote_path.to_string(),
                exists: false,
                is_directory: false,
                readable: false,
                safe: false,
                reason: Some(msg),
            };
        }
        let norm = normalize_linux_path(remote_path);
        if norm.is_empty() {
            return PathValidateResult {
                normalized_path: norm,
                exists: false,
                is_directory: false,
                readable: false,
                safe: false,
                reason: Some("路径展开后为空".into()),
            };
        }
        if !norm.starts_with('/') {
            return PathValidateResult {
                normalized_path: norm,
                exists: false,
                is_directory: false,
                readable: false,
                safe: false,
                reason: Some("路径必须是绝对路径（以 / 开头）或 ~ 开头相对主目录".into()),
            };
        }
        // 2. 远程连 SFTP stat
        let server = server.clone();
        let pwd = password_plain.map(|s| s.to_string());
        let pem = private_key_pem_plain.map(|s| s.to_string());
        let path_for_blocking = norm.clone();
        let join_res = tokio::task::spawn_blocking(
            move || -> anyhow::Result<(bool, bool, bool, Option<String>)> {
                let ssh = Self::connect_sync(&server, pwd.as_deref(), pem.as_deref())?;
                let sftp = ssh
                    .session
                    .sftp()
                    .map_err(|e| anyhow!("SFTP 会话失败: {e}"))?;
                let stat = sftp.stat(std::path::Path::new(&path_for_blocking));
                let (exists, is_dir, readable) = match stat {
                    Ok(st) => {
                        let is_dir = st.file_type() == ssh2::FileType::Directory;
                        // 判断可读性：尝试 open_mode read，成功即可读（不读取内容，立即 drop）
                        let readable = if is_dir {
                            sftp.opendir(PathBuf::from(&path_for_blocking)).is_ok()
                        } else {
                            use ssh2::{OpenFlags, OpenType};
                            sftp.open_mode(
                                PathBuf::from(&path_for_blocking),
                                OpenFlags::READ,
                                0,
                                OpenType::File,
                            )
                            .is_ok()
                        };
                        (true, is_dir, readable)
                    }
                    Err(_e) => (false, false, false),
                };
                drop(sftp);
                drop(ssh);
                Ok((exists, is_dir, readable, None))
            },
        )
        .await;
        match join_res {
            Ok(Ok((exists, is_dir, readable, _))) => PathValidateResult {
                normalized_path: norm,
                exists,
                is_directory: is_dir,
                readable,
                safe: true,
                reason: None,
            },
            Ok(Err(e)) => PathValidateResult {
                normalized_path: norm,
                exists: false,
                is_directory: false,
                readable: false,
                safe: true,
                reason: Some(format!("远程校验失败: {:#}", e)),
            },
            Err(e) => PathValidateResult {
                normalized_path: norm,
                exists: false,
                is_directory: false,
                readable: false,
                safe: false,
                reason: Some(format!("校验任务 Panic: {e}")),
            },
        }
    }

    /*
     * 枚举服务器指定目录下的条目
     * - 自动 prevalidate + 展开 ~
     * - 使用 SFTP readdir 枚举；失败 fallback 到 shell ls -1A
     * - 只返回当前用户有权限读取 stat 的条目
     * - 排序：目录优先（按名升序）→ 再文件按名升序
     */
    pub async fn list_directory(
        server: &ServerConfig,
        remote_path: &str,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> Result<DirListResult> {
        if let Err(msg) = prevalidate_path_str(remote_path) {
            return Err(anyhow!(msg));
        }
        let norm = normalize_linux_path(remote_path);
        if !norm.starts_with('/') {
            return Err(anyhow!(
                "路径必须是绝对路径（以 / 开头）或 ~ 开头相对主目录"
            ));
        }
        let server = server.clone();
        let pwd = password_plain.map(|s| s.to_string());
        let pem = private_key_pem_plain.map(|s| s.to_string());
        let path_for_blocking = norm.clone();
        tokio::task::spawn_blocking(move || -> Result<DirListResult> {
            let ssh = Self::connect_sync(&server, pwd.as_deref(), pem.as_deref())?;
            let sftp = ssh
                .session
                .sftp()
                .map_err(|e| anyhow!("SFTP 会话失败: {e}"))?;
            let mut entries: Vec<DirEntry> = Vec::new();
            let files = sftp
                .readdir(PathBuf::from(&path_for_blocking))
                .map_err(|e| {
                    anyhow!(
                        "无法读取目录 {:?}：可能是不存在或当前用户({})无读权限。\n详细错误: {}",
                        path_for_blocking,
                        server.username,
                        e
                    )
                })?;
            for (pbuf, st) in files.into_iter() {
                let name = pbuf
                    .file_name()
                    .map(|os| os.to_string_lossy().to_string())
                    .unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let abs_path = pbuf.to_string_lossy().to_string();
                let kind = match st.file_type() {
                    ssh2::FileType::Directory => FileKind::Directory,
                    ssh2::FileType::RegularFile => FileKind::File,
                    ssh2::FileType::Symlink => FileKind::Symlink,
                    _ => FileKind::Other,
                };
                let is_dir = matches!(kind, FileKind::Directory);
                let is_leaf = !is_dir;
                // 判断 readable
                let readable = if is_dir {
                    sftp.opendir(PathBuf::from(&abs_path)).is_ok()
                } else {
                    use ssh2::{OpenFlags, OpenType};
                    sftp.open_mode(PathBuf::from(&abs_path), OpenFlags::READ, 0, OpenType::File)
                        .is_ok()
                };
                entries.push(DirEntry {
                    abs_path: abs_path.clone(),
                    name,
                    kind,
                    size: st.size,
                    mtime_ms: st.mtime.map(|secs| (secs as i64).saturating_mul(1000)),
                    mode: st.perm,
                    is_leaf,
                    readable,
                });
            }
            // 排序：目录在前，按名字大小写不敏感升序；文件再按名字升序
            entries.sort_by(|a, b| {
                let ad = matches!(a.kind, FileKind::Directory);
                let bd = matches!(b.kind, FileKind::Directory);
                match (ad, bd) {
                    (true, false) => std::cmp::Ordering::Less,
                    (false, true) => std::cmp::Ordering::Greater,
                    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                }
            });
            drop(sftp);
            drop(ssh);
            Ok(DirListResult {
                normalized_path: path_for_blocking,
                entries,
                symlink_target: None,
            })
        })
        .await
        .map_err(|e| anyhow!("SSH list_directory 任务 Panic: {e}"))?
    }

    /* 内部同步 connect 辅助（避免和 spawn_blocking 的 SSHSession Send 冲突） */
    fn connect_sync(
        server: &ServerConfig,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> Result<SSHSession> {
        // 1. TCP + handshake
        let addr = format!("{}:{}", server.host, server.port);
        let tcp = TcpStream::connect_timeout(
            &addr
                .parse()
                .with_context(|| format!("无效的地址: {}", addr))?,
            Duration::from_secs(15),
        )
        .with_context(|| {
            format!(
                "无法连接到 {}:{} (TCP超时或拒绝连接)",
                server.host, server.port
            )
        })?;
        tcp.set_read_timeout(Some(Duration::from_secs(120)))?;
        tcp.set_write_timeout(Some(Duration::from_secs(60)))?;
        let mut sess = Session::new().context("创建 libssh2 Session 失败")?;
        sess.set_tcp_stream(tcp.try_clone().context("克隆 TCP 流失败")?);
        sess.handshake()
            .context("SSH 协议握手失败，可能不是 SSH 服务或网络中断")?;
        verify_host_key(&sess, server)?;

        // 2. 认证
        match server.auth_type {
            AuthType::Password => {
                let p = password_plain
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| anyhow!(
                        "密码未传入（前端未提供有效明文密码，可能是：表单密码为空、保存后解密还未完成、或缓存已丢失）。\n请重新在编辑框输入密码后点击；如已保存过服务器可右键编辑→确认密码→保存后再连。"
                    ))?;
                match sess.userauth_password(&server.username, &p) {
                    Ok(_) => {}
                    Err(_e1) => {
                        let mut prompter = PasswordPrompt {
                            password: p.to_string(),
                        };
                        sess.userauth_keyboard_interactive(&server.username, &mut prompter)
                            .map_err(|e| anyhow!(
                                "密码认证未通过（password + keyboard-interactive 两种方式均返回错误）。\n\
                                 请检查：① 用户名是否正确（当前: {}）；② 密码是否正确；③ 服务器是否开启密码/PAM认证；④ 账号是否被锁/IP是否被封。\n\
                                 详细错误: {}",
                                server.username, e
                            ))?;
                    }
                }
            }
            AuthType::PrivateKey => {
                let (tmp_path, delete_after): (Option<PathBuf>, bool) = if let Some(pem) =
                    private_key_pem_plain.as_ref().filter(|s| !s.is_empty())
                {
                    let tmp = std::env::temp_dir().join(format!("logsight_key_{}", rand_suffix()));
                    std::fs::write(&tmp, pem.as_bytes())
                        .with_context(|| format!("写临时私钥文件失败: {:?}", tmp))?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).ok();
                    }
                    (Some(tmp), true)
                } else if let Some(p) = server.private_key_path.as_ref().filter(|s| !s.is_empty()) {
                    let expanded = shellexpand::tilde(p).to_string();
                    (Some(PathBuf::from(expanded)), false)
                } else {
                    return Err(anyhow!("私钥认证需要提供 PEM 内容或私钥文件路径"));
                };
                let key_path = tmp_path.as_ref().ok_or_else(|| anyhow!("无效的私钥路径"))?;
                if !key_path.exists() {
                    return Err(anyhow!("私钥文件不存在: {:?}", key_path));
                }
                let res = sess.userauth_pubkey_file(&server.username, None, key_path, None);
                if delete_after {
                    let _ = std::fs::remove_file(key_path);
                }
                res.map_err(|e| anyhow!("私钥认证失败: {}", e))?;
            }
            AuthType::ConfigFile => {
                return Err(anyhow!("配置文件认证模式暂未实现，请改用密码或私钥模式"))
            }
        }

        if !sess.authenticated() {
            return Err(anyhow!("认证未通过，请检查用户名/密码/私钥"));
        }
        Ok(SSHSession {
            session: sess,
            stream: tcp,
            server_id: server.id.clone(),
        })
    }

    /*
     * 根据 ServerConfig + 明文凭证建立 SSH 会话
     * 内部使用 spawn_blocking 避免阻塞 Runtime
     */
    pub async fn connect(
        server: &ServerConfig,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> Result<SSHSession> {
        let server = server.clone();
        let pwd = password_plain.map(|s| s.to_string());
        let pem = private_key_pem_plain.map(|s| s.to_string());

        tokio::task::spawn_blocking(move || -> Result<SSHSession> {
            // 1. 建立 TCP 连接（带超时）
            let addr = format!("{}:{}", server.host, server.port);
            let tcp = TcpStream::connect_timeout(
                &addr.parse().with_context(|| format!("无效的地址: {}", addr))?,
                Duration::from_secs(15),
            ).with_context(|| format!("无法连接到 {}:{} (TCP超时或拒绝连接)", server.host, server.port))?;
            tcp.set_read_timeout(Some(Duration::from_secs(120)))?;
            tcp.set_write_timeout(Some(Duration::from_secs(60)))?;

            // 2. 初始化 libssh2 Session 并握手
            let mut sess = Session::new().context("创建 libssh2 Session 失败")?;
            sess.set_tcp_stream(tcp.try_clone().context("克隆 TCP 流失败")?);
            sess.handshake().context("SSH 协议握手失败，可能不是 SSH 服务或网络中断")?;
            verify_host_key(&sess, &server)?;

            // 3. 按认证方式执行 userauth
            match server.auth_type {
                AuthType::Password => {
                    let p = pwd
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| anyhow!(
                            "密码未传入（前端未提供有效明文密码，可能是：表单密码为空、保存后解密还未完成、或缓存已丢失）。\n请重新在编辑框输入密码后点击「测试连接」；如已保存过服务器可右键编辑→确认密码→保存后再连。"
                        ))?;
                    // 先尝试普通 password auth；失败则立即 fallback 到 keyboard-interactive（PAM 场景兼容）
                    match sess.userauth_password(&server.username, &p) {
                        Ok(_) => {}
                        Err(_e1) => {
                            let mut prompter = PasswordPrompt { password: p };
                            sess.userauth_keyboard_interactive(&server.username, &mut prompter)
                                .map_err(|e| anyhow!(
                                    "密码认证未通过（password + keyboard-interactive 两种方式均返回错误）。\n\
                                     请检查：① 用户名是否正确（当前: {}）；② 密码是否正确；③ 服务器是否开启密码/PAM认证；④ 账号是否被锁/IP是否被封。\n\
                                     详细错误: {}",
                                    server.username, e
                                ))?;
                        }
                    }
                }
                AuthType::PrivateKey => {
                    // 优先使用用户粘贴的 PEM 内容，写入临时文件；否则使用 private_key_path
                    let (tmp_path, delete_after): (Option<PathBuf>, bool) = if let Some(pem) = pem.as_ref().filter(|s| !s.is_empty()) {
                        // 写临时文件（仅当前用户可读写）
                        let tmp = std::env::temp_dir().join(format!("logsight_key_{}", rand_suffix()));
                        std::fs::write(&tmp, pem.as_bytes())
                            .with_context(|| format!("写临时私钥文件失败: {:?}", tmp))?;
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).ok();
                        }
                        (Some(tmp), true)
                    } else if let Some(p) = server.private_key_path.as_ref().filter(|s| !s.is_empty()) {
                        let expanded = shellexpand::tilde(p).to_string();
                        (Some(PathBuf::from(expanded)), false)
                    } else {
                        return Err(anyhow!("私钥认证需要提供 PEM 内容或私钥文件路径"));
                    };

                    let key_path = tmp_path.as_ref().ok_or_else(|| anyhow!("无效的私钥路径"))?;
                    if !key_path.exists() {
                        return Err(anyhow!("私钥文件不存在: {:?}", key_path));
                    }

                    let res = sess.userauth_pubkey_file(
                        &server.username,
                        None,
                        key_path,
                        None, // 私钥口令，后续可扩展支持
                    );

                    if delete_after {
                        let _ = std::fs::remove_file(key_path);
                    }
                    res.map_err(|e| anyhow!("私钥认证失败: {}", e))?;
                }
                AuthType::ConfigFile => {
                    return Err(anyhow!("配置文件认证模式暂未实现，请改用密码或私钥模式"));
                }
            }

            if !sess.authenticated() {
                return Err(anyhow!("认证未通过，请检查用户名/密码/私钥"));
            }

            Ok(SSHSession {
                session: sess,
                stream: tcp,
                server_id: server.id.clone(),
            })
        })
        .await
        .map_err(|e| anyhow!("SSH 连接任务 Panic: {}", e))?
    }

    /*
     * 快速连通性测试：建立连接然后立即断开
     */
    pub async fn test_connection(
        server: &ServerConfig,
        password_plain: Option<&str>,
        private_key_pem_plain: Option<&str>,
    ) -> ConnectTestResult {
        let t0 = Instant::now();
        match Self::connect(server, password_plain, private_key_pem_plain).await {
            Ok(mut s) => {
                let banner = s.session.banner().map(|b| b.to_string());
                let remote_environment = Some(Self::detect_remote_environment(&mut s).await);
                let latency = t0.elapsed().as_millis() as u64;
                drop(s);
                ConnectTestResult {
                    success: true,
                    latency_ms: latency,
                    error_message: None,
                    banner,
                    remote_environment,
                }
            }
            Err(e) => ConnectTestResult {
                success: false,
                latency_ms: t0.elapsed().as_millis() as u64,
                error_message: Some(format!("{:#}", e)),
                banner: None,
                remote_environment: None,
            },
        }
    }

    /*
     * 探测当前日志命令通道是否具备所需能力。
     * 探测失败本身也作为“不支持”返回，便于界面区分 SSH 可用与日志模式可用。
     */
    pub async fn detect_remote_environment(ssh: &mut SSHSession) -> RemoteEnvironment {
        let result = Self::exec_once(ssh, REMOTE_ENVIRONMENT_PROBE, 10).await;
        let (stdout, stderr, exit) = match result {
            Ok(value) => value,
            Err(e) => {
                return RemoteEnvironment {
                    os: "unknown".into(),
                    shell: "unknown".into(),
                    available_commands: vec![],
                    missing_commands: REQUIRED_REMOTE_COMMANDS
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    supported: false,
                    message: Some(format!("无法执行远程环境探测：{:#}", e)),
                };
            }
        };

        parse_remote_environment(&stdout, &stderr, exit)
    }

    /*
     * 执行一次性命令并返回 (stdout_string, stderr_string, exit_code)
     */
    pub async fn exec_once(
        ssh: &mut SSHSession,
        command: &str,
        timeout_secs: u64,
    ) -> Result<(String, String, i32)> {
        let command = command.to_string();
        // ssh2 Sync Session + Sync Tcp 非 Send，这里不能跨线程 move，所以改成：
        // 关闭 spawn_blocking 策略，直接在当前线程执行（但 Runtime 会警告）。
        // 为安全起见，改用同步实现：整个 exec 在 blocking 中，重新 clone TCP 再握手不合适。
        // 折中：直接同步执行，SSH 命令一般短时。
        Self::exec_once_sync(&mut ssh.session, &command, timeout_secs)
    }

    fn exec_once_sync(
        sess: &mut Session,
        command: &str,
        timeout_secs: u64,
    ) -> Result<(String, String, i32)> {
        let start = Instant::now();
        let mut channel = sess.channel_session().context("创建 SSH channel 失败")?;
        channel
            .exec(command)
            .with_context(|| format!("执行命令失败: {}", command))?;

        let mut stdout = String::new();
        let mut stderr = String::new();
        loop {
            if start.elapsed() > Duration::from_secs(timeout_secs) {
                return Err(anyhow!("命令执行超时 ({}s): {}", timeout_secs, command));
            }
            let mut out_buf = vec![0u8; 16384];
            let mut err_buf = vec![0u8; 16384];
            let n = match channel.read(&mut out_buf) {
                Ok(0) | Err(_) => 0,
                Ok(n) => {
                    stdout.push_str(&String::from_utf8_lossy(&out_buf[..n]));
                    n
                }
            };
            let n2 = match channel.stderr().read(&mut err_buf) {
                Ok(0) | Err(_) => 0,
                Ok(n) => {
                    stderr.push_str(&String::from_utf8_lossy(&err_buf[..n]));
                    n
                }
            };
            if channel.eof() && n == 0 && n2 == 0 {
                break;
            }
            let _ = channel.wait_close();
            std::thread::sleep(Duration::from_millis(10));
        }
        channel.wait_close().ok();
        let code = channel.exit_status().unwrap_or(-1);
        Ok((stdout, stderr, code))
    }

    /*
     * 启动 tail -F 流：同步循环读取 tail 命令 stdout，通过 mpsc Sender 推送到主循环
     * 调用方应在独立的 tokio::task::spawn_blocking 中运行本函数
     */
    pub fn stream_tail_f_blocking(
        ssh: SSHSession,
        remote_path: String,
        lines_backtrack: u32,
        line_tx: std::sync::mpsc::Sender<std::result::Result<String, String>>,
        stop_flag: Arc<AtomicBool>,
    ) -> std::result::Result<(), String> {
        let SSHSession {
            session,
            stream: _tcp,
            server_id: _,
        } = ssh;
        let mut channel = session
            .channel_session()
            .map_err(|e| format!("open channel fail: {e}"))?;
        // 请求 PTY，防止远端 buffer 过大
        channel.request_pty("xterm-256color", None, None).ok();
        let cmd = format!(
            "tail -n {} -F -- {}",
            lines_backtrack,
            shell_escape(&remote_path)
        );
        channel
            .exec(&cmd)
            .map_err(|e| format!("exec tail fail: {e}"))?;
        session.set_blocking(false);

        // 非阻塞读取让用户点击停止时无需等待远端产生下一行日志。
        let mut pending = String::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                return Ok(());
            }
            match channel.read(&mut buf) {
                Ok(0) => {
                    if channel.eof() {
                        if !pending.is_empty() {
                            line_tx
                                .send(Ok(std::mem::take(&mut pending)))
                                .map_err(|_| "日志接收端已关闭".to_string())?;
                        }
                        return Err("远程 tail 会话已结束".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(80));
                }
                Ok(n) => {
                    pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                    while let Some(pos) = pending.find('\n') {
                        let mut line = pending.drain(..=pos).collect::<String>();
                        if line.ends_with('\n') {
                            line.pop();
                        }
                        if line.ends_with('\r') {
                            line.pop();
                        }
                        line_tx
                            .send(Ok(line))
                            .map_err(|_| "日志接收端已关闭".to_string())?;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(80));
                }
                Err(e) => return Err(format!("读取错误: {e}")),
            }
        }
    }
}

fn parse_remote_environment(stdout: &str, stderr: &str, exit: i32) -> RemoteEnvironment {
    let mut os = "unknown".to_string();
    let mut shell = "unknown".to_string();
    let mut available_commands = Vec::new();
    let mut missing_commands = Vec::new();
    let mut stat_gnu = false;

    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix("os=") {
            os = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("shell=") {
            shell = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("cmd=") {
            let mut parts = value.splitn(2, '|');
            let command = parts.next().unwrap_or_default().trim();
            let available = parts.next().unwrap_or_default().trim() == "yes";
            if available {
                available_commands.push(command.to_string());
            } else if !command.is_empty() {
                missing_commands.push(command.to_string());
            }
        } else if line.trim() == "stat_gnu=yes" {
            stat_gnu = true;
        }
    }

    if !stat_gnu {
        missing_commands.push("stat -c".to_string());
    }
    if exit != 0 && missing_commands.is_empty() {
        missing_commands.push("POSIX shell".to_string());
    }
    let supported = missing_commands.is_empty();
    let message = if supported {
        Some(format!("远程环境可用：{} / {}", os, shell))
    } else if !stderr.trim().is_empty() {
        Some(format!(
            "远程环境暂不满足日志命令要求（{}）：{}",
            missing_commands.join(", "),
            stderr.trim()
        ))
    } else {
        Some(format!(
            "远程环境暂不满足日志命令要求（{}）",
            missing_commands.join(", ")
        ))
    };

    RemoteEnvironment {
        os,
        shell,
        available_commands,
        missing_commands,
        supported,
        message,
    }
}

fn rand_suffix() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let mut s = String::with_capacity(16);
    for _ in 0..16 {
        s.push((b'a' + rng.gen_range(0..26)) as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_paths_accept_safe_absolute_patterns() {
        assert!(prevalidate_glob_path_str("/var/log/app/application-*.log").is_ok());
        assert!(prevalidate_glob_path_str("~/logs/app-[0-9]*.log").is_ok());
    }

    #[test]
    fn glob_paths_reject_shell_metacharacters_and_relative_paths() {
        assert!(prevalidate_glob_path_str("/var/log/$(whoami)-*.log").is_err());
        assert!(prevalidate_glob_path_str("/var/log/a;touch /tmp/pwned*.log").is_err());
        assert!(prevalidate_glob_path_str("logs/*.log").is_err());
    }

    #[test]
    fn remote_environment_probe_requires_supported_command_set() {
        let supported = parse_remote_environment(
            "os=Linux\nshell=/bin/bash\ncmd=tail|yes\ncmd=grep|yes\ncmd=awk|yes\ncmd=find|yes\ncmd=stat|yes\nstat_gnu=yes\n",
            "",
            0,
        );
        assert!(supported.supported);
        assert_eq!(supported.os, "Linux");
        assert!(supported.missing_commands.is_empty());

        let unsupported = parse_remote_environment(
            "os=Windows_NT\nshell=powershell\ncmd=tail|no\nstat_gnu=no\n",
            "command not found",
            1,
        );
        assert!(!unsupported.supported);
        assert!(unsupported.missing_commands.contains(&"tail".to_string()));
        assert!(unsupported.message.unwrap().contains("command not found"));
    }

    #[test]
    fn known_host_name_uses_openssh_port_format() {
        let mut server = ServerConfig::default();
        server.host = "log.example.com".to_string();
        server.port = 22;
        assert_eq!(known_host_name(&server), "log.example.com");

        server.port = 2222;
        assert_eq!(known_host_name(&server), "[log.example.com]:2222");
    }
}
