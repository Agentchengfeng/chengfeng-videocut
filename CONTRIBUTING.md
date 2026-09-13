# 源码开发

本页面向开发者。安装产品请读 [INSTALL](INSTALL.md)，命令用法见 [CLI README](apps/cli/README.md)。

## 准备与运行

使用 Bun；当前源码的工作区与依赖版本见 [package.json](package.json) 和 [bun.lock](bun.lock)。在仓库根目录执行：

```sh
bun install --frozen-lockfile
bun run dev
```

运行媒体处理或发行打包前，还需按相应工具检查结果准备 FFmpeg 等依赖。以上是源码开发入口，不是对用户发行安装的替代；不要将已有用户项目或凭据加入仓库。

## 修改后的检查

```sh
bun run typecheck
bun test packages apps/cli/src
bun run --cwd apps/studio test
# 检查 Studio 不会把只读上游快照的测试当成产品测试
node --test test/studio-test-discovery.test.mjs
bun run build
```

安装器与桌面壳的检查入口分别为 `bun run test:runtime-updater` 和 `bun run desktop:test`。按修改范围补充实际路径测试；未执行的测试不能写成通过。

## 打包与发行

```sh
bun run package:build
bun run package:check
bun run release:check
```

打包检查不替代干净环境安装、启动、恢复、冲突与卸载验收；发布时还需核对来源、摘要、平台、许可与实际业务路径。原 v0.4.9 检查清单见 [历史发布契约](docs/history/runtime-v0.4.9.md)，新版本需要对应版本的验证，不沿用旧结论。

## 目录与保留内容

见 [架构与目录职责](docs/architecture.md)。Runtime 数据、缓存、私有设计记录及凭据不进入公开仓库；保留许可证、第三方来源说明与测试需要的上游母版。实验脚本不作为默认用户流程。

提交改动时说明修改范围、验证方式和未验证项。仅修改文档时检查路径、链接及公开状态；运行行为变化需要相应自动化与真实路径验收。
