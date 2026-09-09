# LogSight

LogSight 是一个开放的桌面端远程日志查看工具：通过 SSH 连接服务器，在本地实时查看、搜索和分析日志文件。

它适合开发、测试、运维和支持人员处理“日志在远程服务器上，但又不想为了排查问题反复登录终端”的场景。

## 为什么使用 LogSight

- **日志留在你的环境里**：应用直接通过 SSH 读取目标服务器，不依赖第三方日志上传服务，也不要求把日志复制到公共云端。
- **比终端更适合排查**：支持多服务器、多标签页、历史加载、实时 `tail -F`、关键字/正则/级别/时间范围筛选。
- **快速定位异常**：结构化解析时间、线程、级别、logger、trace ID 和消息正文；Java 异常堆栈会自动归并并可折叠。
- **减少噪音**：可按 logger、线程和日志来源过滤，并自动识别高频刷屏 logger。
- **连接能力清晰可控**：当前支持密码和私钥认证，可浏览远程目录并校验路径权限；SSH config、SSH agent 和 MFA/OTP 已预留能力，仍在规划中。
- **适合滚动日志**：支持 glob 路径、按时间查询，并可读取常见 Logback XML 配置来发现滚动日志源。
- **跨平台基础**：基于 Tauri、React、TypeScript 和 Rust，优先提供轻量的原生桌面体验。

## 功能概览

| 能力 | 说明 |
| --- | --- |
| 远程连接 | SSH 密码、私钥；严格校验 `~/.ssh/known_hosts` |
| 实时查看 | Tail 模式、断线状态、连接测试 |
| 历史查询 | 分页加载远程文件，支持大文件场景 |
| 结构化解析 | Logback 常见 pattern、普通时间戳、续行/堆栈 |
| 高级过滤 | 关键字、排除关键字、正则、级别、线程、logger、trace ID、时间范围 |
| 日志源探测 | 解析 Logback 配置或使用通用内置预设 |
| 本地管理 | 服务器书签、路径历史、主题、列宽和隐藏列设置 |
| 导出 | 将当前查看结果导出为 `.log` 文件 |

## 快速开始

### 环境要求

- macOS 12+
- Node.js 20+
- Rust stable 与 Cargo
- Tauri 2 所需的系统构建工具

### 安装依赖并启动

```bash
npm install
npm run tauri:dev
```

只检查前端构建：

```bash
npm run build
```

构建桌面安装包：

```bash
npm run tauri:build
```

推送形如 `v0.2.0` 的版本标签后，GitHub Actions 会在 Windows Runner 上自动构建并上传 `.msi` 和 `-setup.exe` 安装包到对应 Release。也可以在 GitHub Actions 页面手动运行 `Windows Release`，指定已有版本标签补发 Windows 安装包。

### 使用步骤

1. 启动 LogSight，新增一台服务器并填写主机、端口、用户名和认证方式。
2. 连接服务器后输入远程日志文件的绝对路径，例如 `/var/log/app/application.log`。
3. 使用“历史查询”读取已有内容，或使用 Tail 模式持续查看新日志。
4. 通过顶部过滤器按关键字、级别、线程、logger、trace ID 或时间范围缩小结果。
5. 对按小时滚动的日志，可以输入 glob，例如 `/var/log/app/application-*.log`，再按时间范围查询。

## 支持的日志格式

LogSight 不绑定某个业务系统。它优先识别常见 Logback 格式，例如：

```text
2026-09-02 12:34:56.789 [http-nio-8080-exec-1] ERROR [trace-123] com.example.application.OrderService - request failed
```

同时会对普通时间戳日志提供降级解析，并把没有时间戳的行作为上一条日志的续行处理。不同业务的 logger 名称、目录和滚动文件规则可以通过实际路径或 Logback 配置适配。

## 安全说明

- 源代码不包含服务器地址、密码、私钥或真实日志样本。
- SSH 凭据不会写入 Git 仓库；应用使用系统钥匙串保存主密钥，再用 AES-256-GCM 和 Argon2id 保护本地配置。
- 首次连接会校验服务器是否匹配本机 `~/.ssh/known_hosts`；缺少或不匹配的主机指纹会拒绝连接。
- 日志内容只在本地界面和 SSH 会话中处理；项目没有内置遥测或日志上传接口。
- 路径会在执行远程命令前做校验，并使用 shell quoting 降低命令注入风险；glob 查询只允许受控字符集。
- 连接后脚本默认关闭，只有明确打开“允许自动执行脚本”才会运行保存的命令。
- 项目尚未经过独立安全审计。生产环境请使用最小权限 SSH 账号、只读日志权限和短期凭据，并先在隔离环境验证。

## 项目结构

```text
src/                 React/TypeScript 界面与本地状态
src-tauri/src/       Rust IPC、SSH、日志流、解析和本地存储
src-tauri/icons/     桌面应用图标资源
```

## 贡献

欢迎提交 Issue 和 Pull Request。建议新增功能时同时补充对应的 TypeScript 或 Rust 单元测试，并说明实际验证过的操作系统、SSH 服务端和日志格式。

## 许可证

本项目使用 MIT License，详见 [LICENSE](LICENSE)。
