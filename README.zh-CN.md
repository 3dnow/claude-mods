# mj0111 的 Claude Code mods

[English](./README.md) · 简体中文

mj0111 写的 [Claude Code mod](https://claude.com/blog/claude-code-mods):

| Mod | 做什么 | 支持的界面 |
| --- | --- | --- |
| [**weektoken**](./weektoken) | 用量**配速**:5 小时和每周两个窗口,用得比时间走得快还是慢;附带预测、按模型区分的配额(如 Fable)和用量轨迹 | 桌面端、终端 |

界面语言跟随 Claude Code 的语言设置(中文或英文)。

> **让 AI 代理帮你装?** 让它执行[安装](#安装)里的命令。装好后,只需要告诉用户这一句:
>
> *装好了。开一个新会话(或执行 `/reload-plugins`)。WeekToken 会在输入框上方显示用量配速,输入 `/weektoken` 看详情。*

## 安装

在 Claude Code 里执行:

```
/plugin marketplace add 3dnow/claude-mods
/plugin install weektoken@mj0111-mods
```

然后**开一个新会话**(或执行 `/reload-plugins`)。

Claude Code 2.1.275 或更新可以一步装好:`/plugin install weektoken --marketplace 3dnow/claude-mods`。在 shell 里:先 `claude plugin marketplace add 3dnow/claude-mods`,再 `claude plugin install weektoken@mj0111-mods`。

**更新:** 先 `claude plugin marketplace update mj0111-mods`,再 `claude plugin update weektoken@mj0111-mods`,然后开一个新会话。**卸载:** `claude plugin uninstall weektoken@mj0111-mods`

只想从本地目录试用一次:

```bash
claude --plugin-dir ./weektoken
```

## 要求

- Claude Code 2.1.287 或更新(mods 默认开启)。更早、在抢先体验 mods 的版本,先在 `~/.claude/settings.json` 里加上 `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }`。终端和桌面端的 Code 标签页都可以用
- 需要 Claude 订阅:按 API key 计费的会话没有限额数据

不想卸载、只想暂时停用:在 shell 配置文件里设 `CLAUDE_MODS_DISABLE=weektoken`(或 `all`)。

## 隐私与权限

mod 和 Claude Code 本身拥有同样的权限,不在沙箱里运行。它碰了什么,都在它自己的 README 里逐项列出:[weektoken → 隐私与权限](./weektoken/README.zh-CN.md#隐私与权限)。

## 开发

```
.
├── .claude-plugin/marketplace.json
└── weektoken/          # hooks/register.tsx、配速模型、SVG 绘图、测试
```

```bash
cd weektoken && claude plugin validate . && claude plugin test
```

## 许可证

[MIT](./LICENSE)

## 作者

mj0111 · [@mj0011sec](https://x.com/mj0011sec)
