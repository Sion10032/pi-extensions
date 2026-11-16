# pi-extensions

sion 的 pi 扩展 monorepo，使用 npm workspaces 管理多个包。

## 开发环境

推荐通过 Nix flake 提供的 devShell（Node.js 24 + git）工作：

```bash
nix develop
```

进入 devShell 后安装依赖：

```bash
npm ci
```

## 命令

在仓库根目录执行：

```bash
npm test          # 运行所有包的测试
npm run typecheck # 类型检查
```

## 包列表

| 包 | 说明 |
| --- | --- |
| [`packages/pi-sessions`](packages/pi-sessions) | 浏览、归档、恢复并继续 pi session（包括其子 agent session） |

## License

MIT
