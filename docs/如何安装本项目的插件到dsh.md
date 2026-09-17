# 如何安装本项目的插件到 DSH

## 本地目录安装

在 **dsh-file 仓库根目录**执行（不要在父目录）：

```sh
cd /path/to/dsh-file
dsh plugin --profile web add .
```

- Web：`--profile web`，装完后**重启 `dsh web`**
- 桌面端：`--profile desktop`，装完后**完全退出并重启应用**（不是关窗口）

`web` / `desktop` 是两套独立 profile，插件互不共享，需分别安装。

## 从 npm / Release 安装

```sh
dsh plugin --profile web add @rose43/dsh-file
# 或
dsh plugin --profile web add ./rose43-dsh-file-0.2.1.tgz
```

桌面端把 `web` 换成 `desktop`。

## 注意

- **不要**手改 `~/.dsh/profiles/desktop/cordis.yml`（桌面端启动会清空）；正确入口是 `dsh plugin add`（写 `dsh.profile.bundles` + dependencies）。
- `cordis.patch.yml` 里的 `root` 只是无会话时的兜底目录；打开文件管理器后会按当前对话 `cwd` 自动 `setRoot`，一般不用改。
