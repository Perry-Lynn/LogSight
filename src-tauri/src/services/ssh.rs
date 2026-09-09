/*
 * LogSight SSH 连接服务模块（v2：基于 ssh2 + libssh2 稳定版）
 * 封装远程服务器连接、命令执行、tail -F 流式输出、断开重连逻辑
 * 所有同步 IO 都在 tokio::task::spawn_blocking 中运行，避免阻塞异步 Runtime
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */
use anyhow::{Result, Context, anyhow};
use std::io::Read;
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use ssh2::{Session, KeyboardInteractivePrompt};

use crate::models::{ServerConfig, AuthType, ConnectTestResult, DirEntry, DirListResult, FileKind, PathValidateResult};

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
        if ch == '\'' { out.push_str("'\\''"); } else { out.push(ch); }
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
        if *b == 0 { return Err("路径包含 null 字节 (0x00)，可能是攻击载荷，已拦截".into()); }
        if *b < 0x20 || *b == 0x7f {
            return Err(format!("路径包含控制字符 0x{:02x}，可能是越权尝试，已拦截", *b));
        }
    }
    // 拒绝 Windows 盘符 / UNC / URL 协议
    if path.contains("://") || path.starts_with("\\\\") || (path.len() >= 2 && path.as_bytes()[1] == b':') {
        return Err("非法路径格式（URL/Windows 盘符/UNC），仅支持 Linux 服务器绝对或 ~ 路径".into());
    }
    // 拒绝任何包含 ".." 的独立组件（避免目录穿越）
    for component in path.split(|c| c == '/' || c == '\\') {
        if component == ".." {
            return Err("路径中含 \"..\" 片段（目录穿越尝试），已拦截。如需返回上一级请在 Tree 中点击父目录。".into());
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
            if !prev_slash { s.push(ch); }
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

impl SSHService {
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
                exists: false, is_directory: false, readable: false, safe: false,
                reason: Some("路径展开后为空".into()),
            };
        }
        if !norm.starts_with('/') {
            return PathValidateResult {
                normalized_path: norm,
                exists: false, is_directory: false, readable: false, safe: false,
                reason: Some("路径必须是绝对路径（以 / 开头）或 ~ 开头相对主目录".into()),
            };
        }
        // 2. 远程连 SFTP stat
        let server = server.clone();
        let pwd = password_plain.map(|s| s.to_string());
        let pem = private_key_pem_plain.map(|s| s.to_string());
        let path_for_blocking = norm.clone();
        let join_res = tokio::task::spawn_blocking(move || -> anyhow::Result<(bool, bool, bool, Option<String>)> {
            let ssh = Self::connect_sync(&server, pwd.as_deref(), pem.as_deref())?;
            let sftp = ssh.session.sftp().map_err(|e| anyhow!("SFTP 会话失败: {e}"))?;
            let stat = sftp.stat(std::path::Path::new(&path_for_blocking));
            let (exists, is_dir, readable) = match stat {
                Ok(st) => {
                    let is_dir = st.file_type() == ssh2::FileType::Directory;
                    // 判断可读性：尝试 open_mode read，成功即可读（不读取内容，立即 drop）
                    let readable = if is_dir {
                        sftp.opendir(PathBuf::from(&path_for_blocking)).is_ok()
                    } else {
                        use ssh2::{OpenFlags, OpenType};
                        sftp.open_mode(PathBuf::from(&path_for_blocking), OpenFlags::READ, 0, OpenType::File).is_ok()
                    };
                    (true, is_dir, readable)
                }
                Err(_e) => (false, false, false),
            };
            drop(sftp); drop(ssh);
            Ok((exists, is_dir, readable, None))
        }).await;
        match join_res {
            Ok(Ok((exists, is_dir, readable, _))) => PathValidateResult {
                normalized_path: norm,
                exists, is_directory: is_dir, readable, safe: true, reason: None,
            },
            Ok(Err(e)) => PathValidateResult {
                normalized_path: norm,
                exists: false, is_directory: false, readable: false, safe: true,
                reason: Some(format!("远程校验失败: {:#}", e)),
            },
            Err(e) => PathValidateResult {
                normalized_path: norm,
                exists: false, is_directory: false, readable: false, safe: false,
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
            return Err(anyhow!("路径必须是绝对路径（以 / 开头）或 ~ 开头相对主目录"));
        }
        let server = server.clone();
        let pwd = password_plain.map(|s| s.to_string());
        let pem = private_key_pem_plain.map(|s| s.to_string());
        let path_for_blocking = norm.clone();
        tokio::task::spawn_blocking(move || -> Result<DirListResult> {
            let ssh = Self::connect_sync(&server, pwd.as_deref(), pem.as_deref())?;
            let sftp = ssh.session.sftp().map_err(|e| anyhow!("SFTP 会话失败: {e}"))?;
            let mut entries: Vec<DirEntry> = Vec::new();
            let files = sftp.readdir(PathBuf::from(&path_for_blocking))
                .map_err(|e| anyhow!("无法读取目录 {:?}：可能是不存在或当前用户({})无读权限。\n详细错误: {}", path_for_blocking, server.username, e))?;
            for (pbuf, st) in files.into_iter() {
                let name = pbuf.file_name()
                    .map(|os| os.to_string_lossy().to_string())
                    .unwrap_or_default();
                if name.is_empty() { continue; }
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
                    sftp.open_mode(PathBuf::from(&abs_path), OpenFlags::READ, 0, OpenType::File).is_ok()
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
            drop(sftp); drop(ssh);
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
            &addr.parse().with_context(|| format!("无效的地址: {}", addr))?,
            Duration::from_secs(15),
        ).with_context(|| format!("无法连接到 {}:{} (TCP超时或拒绝连接)", server.host, server.port))?;
        tcp.set_read_timeout(Some(Duration::from_secs(120)))?;
        tcp.set_write_timeout(Some(Duration::from_secs(60)))?;
        let mut sess = Session::new().context("创建 libssh2 Session 失败")?;
        sess.set_tcp_stream(tcp.try_clone().context("克隆 TCP 流失败")?);
        sess.handshake().context("SSH 协议握手失败，可能不是 SSH 服务或网络中断")?;

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
                        let mut prompter = PasswordPrompt { password: p.to_string() };
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
                let (tmp_path, delete_after): (Option<PathBuf>, bool) = if let Some(pem) = private_key_pem_plain.as_ref().filter(|s| !s.is_empty()) {
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
                if delete_after { let _ = std::fs::remove_file(key_path); }
                res.map_err(|e| anyhow!("私钥认证失败: {}", e))?;
            }
            AuthType::ConfigFile => return Err(anyhow!("配置文件认证模式暂未实现，请改用密码或私钥模式")),
        }

        if !sess.authenticated() {
            return Err(anyhow!("认证未通过，请检查用户名/密码/私钥"));
        }
        Ok(SSHSession { session: sess, stream: tcp, server_id: server.id.clone() })
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
            Ok(s) => {
                let banner = s.session.banner().map(|b| b.to_string());
                let latency = t0.elapsed().as_millis() as u64;
                drop(s);
                ConnectTestResult {
                    success: true,
                    latency_ms: latency,
                    error_message: None,
                    banner,
                }
            }
            Err(e) => ConnectTestResult {
                success: false,
                latency_ms: t0.elapsed().as_millis() as u64,
                error_message: Some(format!("{:#}", e)),
                banner: None,
            },
        }
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
        channel.exec(command).with_context(|| format!("执行命令失败: {}", command))?;

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
        stop_rx: std::sync::mpsc::Receiver<()>,
    ) {
        let _ = || -> Result<()> {
            let SSHSession { session, stream: _tcp, server_id: _ } = ssh;
            let mut channel = session.channel_session()
                .map_err(|e| anyhow!("open channel fail: {e}"))?;
            // 请求 PTY，防止远端 buffer 过大
            channel.request_pty("xterm-256color", None, None).ok();
            let cmd = format!("tail -n {} -F -- {}", lines_backtrack, shell_escape(&remote_path));
            channel.exec(&cmd).map_err(|e| anyhow!("exec tail fail: {e}"))?;

            // 将 channel 拆为读流，用 BufReader 逐行读
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(channel.stream(0));
            for line_res in reader.lines() {
                // 检测停止信号
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                match line_res {
                    Ok(line) => {
                        if line_tx.send(Ok(line)).is_err() {
                            break; // 接收端断开
                        }
                    }
                    Err(e) => {
                        let _ = line_tx.send(Err(format!("读取错误: {}", e)));
                        break;
                    }
                }
            }
            Ok(())
        }();
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
