# 项目的插件代码如何嵌入 DSH

## 入口声明

| 位置 | 作用 |
|------|------|
| `package.json` → `dsh.bundle.patch` | 指向 `cordis.patch.yml`，向 loader 插入本插件 |
| `package.json` → `dsh.client` + `exports["./client"]` | 声明有浏览器半；DSH 自动发现并加载 `dist/client.js` |
| `package.json` → `main` | Host 半入口 `dist/index.js` |

`cordis.patch.yml` 插入一行：`name: @rose43/dsh-file` → 加载 host 默认导出的 `FileManagerGateway`。

## Host 半（Node）

- `FileManagerGateway extends TypertRemoteService`，namespace：`fileManager`
- 用 `@Remote()` 暴露 `listDir` / `readText` / `writeText` / … / `setRoot` 等 RPC
- 方法参数必须**扁平**（参数名即 wire 字段名），与 client 描述符一致

## Client 半（浏览器）

- 构建为 ModuleLoader 格式：`window.__ModuleLoader__.load({ id, factory })`
- DSH 把 `dist/client.js` 挂到 `/plugins/@rose43/dsh-file/client.js`，并 seed 进 `__DSH_BOOT__`
- 启动后通过 `ctx.slots` / `ctx.remote` 挂 UI 与 RPC：
  - `sidebar.footer.action` — 底部「文件」按钮
  - `sidebar.workspaces`（priority `-1`）— 文件树抢占侧边栏
  - `conversation.view` — 中间列「文件」编辑器标签
  - `ctx.remote.$mount` → `remote.fileManager` 调 host

## 通信链路

```
浏览器 UI  →  Typert RPC (fileManager/*)  →  Host 半 fs 操作（限制在 pinned root 内）
```

`@deepseek-ai/*` 必须与 DSH 同实例（peer + symlink），否则 `@Remote` 标记丢失、RPC 404。
