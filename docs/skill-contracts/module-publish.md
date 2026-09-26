# 模块包交付：统一 Runtime CLI

只向用户明确指定、经身份核验的本地工作台交付已授权模块；不是任意文件上传。先读[统一 CLI 接入](runtime-cli.md)，确认当前 Runtime 可执行入口确实包含 `module publish/get`；旧安装可能还没有这两条命令。

候选目录必须是绝对实体目录、无软链父目录。固定 `module-manifest.json`：

```json
{"schemaVersion":1,"moduleId":"01-card","version":"v1","entry":"index.html","files":[{"path":"index.html","sha256":"<原始字节小写64位SHA256>","bytes":123}]}
```

moduleId/version：小写字母数字开头，后续小写字母数字、连字符或下划线，总长≤64。
entry 是包内 HTML。files 不含 manifest 自身；路径用安全 ASCII 相对路径，不含编码、绝对路径、点段或软链。
最多32文件，单文件≤512KiB，总≤2MiB；允许 html/js/mjs/css/svg/json/png/jpg/jpeg/webp/woff2。
清单完整列入 import、fetch、HTML/CSS 引用的本地资源；SVG xmlns 是命名空间，不是外链资源。
禁止外部资源和 HTML base。不要把动态代码静态扫描理解成安全证明：只发布用户已认可的可信模块，
保留 iframe allow-scripts 隔离与服务器 CSP，不能为加载成功增添 allow-same-origin。

## 首选：调用同一个 Runtime CLI

以下是传给已核验 Runtime 可执行入口的参数数组；占位值须替换，地址不能猜，路径保持为一个参数。`--file` 指候选目录中的 manifest，所列资源相对该 manifest 目录解析，不是任意上传 JSON。

```json
["module","publish","<project-id>","--file","<绝对候选目录>/module-manifest.json","--api-base","<用户指定的HTTP-loopback-origin>","--dry-run","--json"]
["module","publish","<project-id>","--file","<绝对候选目录>/module-manifest.json","--api-base","<同一origin>","--confirmed","--json"]
["module","get","<project-id>","<module-id>","<version>","--api-base","<同一origin>","--json"]
```

1. 保留认可文件的原字节，生成实际 hashes/bytes；在项目外的候选目录制作，不直接覆盖项目内模块。预检只核验候选和服务，不下载依赖、不发布。
2. 用户已授权本次模块交付后，才运行带 `--confirmed` 的 publish；不能把 dry-run 当成用户确认。CLI 使用服务器注册的 projectId，不要求客户端再建项目或 `service ensure`。
3. 只有返回已核验的同 id/version 的 manifest、digest、entryPath 才算交付成功。需要恢复上下文或遇到提交/回读异常时，使用 get 查同一版本；非零退出、缺字段或 mismatch 均不能报成功。
4. 同版本同内容可幂等回读，异内容冲突并保留旧包。超时可能已经发布，先 get 核对原身份，不换版本盲重试；合法修订才生成新版本。
5. 发布不改变 visuals。后续按已验证的层绑定入口，用当前审核所绑定的 expectedRevision 和返回 entryPath 提交；不能直接改 visuals.json，也不能假设旧 visual CLI 已完整支持指定服务的 CAS。
6. 在真实 Studio 验证实际画面、资源加载、seek 前进/回零和尺寸。API/readback 通过不代替画面和导出验收。

缺少 CLI 子命令或服务能力时报告具体未就绪项，不重复下载整包、不回退另一端口/registry。单独使用旧兼容接口的前提见下一节。

## 兼容与资源边界

旧 MCP 仅在明确选定且实测兼容的旧发行中读取其自带说明，不是 CLI 缺命令时的自动回退。独立 Skill 不携带旧桥。默认绑定为 workbench visuals-put，使用原 expectedRevision 及完整 document，并显式 --confirmed。

模块资源走专用GET与CORS，项目JSON/API不因此放开；保留CSP与iframe隔离。动态代码扫描不是安全证明，API通过不表示视觉或导出已验。
