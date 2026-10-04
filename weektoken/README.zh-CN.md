# WeekToken

[English](./README.md) · 简体中文

**额度会不会在重置前用完?** WeekToken 把 Claude Code 限额的**已用**和窗口**已过去的时间**放在一起看,告诉你用得比时间快还是慢。5 小时窗口、7 天窗口,以及 **Fable 这类按模型单独计算的周配额**都有。

![输入框上方的 WeekToken 横条](./screenshots/band-dark.png)

- **看配速,不只看百分比。** 单说已用 64% 看不出好坏;已用 64%、这周已经过去 71%,就是还宽裕。横条和面板两个数都给,颜色按配速变。
- **按模型的配额。** Fable 这类有自己周额度的模型,单独算配速,和 5 小时、7 天并列。
- **有预测,也有历史。** 「照这个速度,约星期六 20:12 用完」;用量轨迹把过去的窗口叠在这一周下面,一眼看出这周比以往快还是慢。
- **不用设置。** 没有任何设置项;中英文跟随 Claude Code 的语言;桌面端和终端都能用。

| `/weektoken` 配速 | 用量轨迹 |
| --- | --- |
| ![配速环、预测和读数](./screenshots/pane-pace.png) | ![叠着过去窗口的用量轨迹](./screenshots/pane-burnup.png) |

终端里,横条在输入框上方,`/weektoken` 面板停靠在对话旁边:

![终端里的 WeekToken:右侧是面板,输入框上方是横条](./screenshots/terminal-pane.png)

## 功能

**输入框上方一条**:「❮ 7 天 ❯ · **已用 64%** · 已过 71%」,加一根随横条长度伸缩的进度条,以及「详情」「隐藏」(桌面端的「隐藏」是横条右端的关闭按钮)。
- 进度条只用配额自己的色系,照 Apple 健身圆环的做法:用得比时间慢,条后面同色的淡斜线是还剩的余量;用得比时间快,超出时间的那一段变成同色深一档,并带斜线。只有配额用尽时,才出现一段实心暖色,色相朝配额颜色协调过。
- 默认显示最紧的配额。名字两侧的箭头直接切换到别的配额,选过之后跨会话记住。
- 横条变窄时不换行:桌面端从尾巴开始截断;终端里按实际宽度排,先去掉「已过」,再去掉进度条。
- 配额的窗口已过重置时刻、新窗口还没有读数时,写「已重置」,不再显示上一个窗口的用量。
- 点「隐藏」会先确认,并提示怎么找回来:输入 `/weektoken show`,或在面板底部点「⊕ 显示横条」。

**`/weektoken` 面板**:
- 配速环:外环是用量,内环是时间,中心是燃烧倍率 R(1.0 表示恰好在重置时用完)。两侧按钮切换 5 小时、7 天和按模型区分的配额(如 Fable)。
- 解说与预测:例如「用量落后 12 小时 28 分」「照这个速度，约 星期六 20:12 用完」;最近在加速或放缓时多一行提示。
- 三项读数:已用、已过、多久后重置。
- 用量轨迹:可看本窗口、近一月或全部,能翻看历史窗口;图里画了匀速线、按近期速度的外推、用完的时刻、没有数据的区段,图例也画在图里。范围里超过 60 个窗口时,均匀抽 60 个来画,图下注明。
- 底部:某个配额超过半小时没用时,显示「上次使用 Fable：3 小时前」;另有「⊖ 隐藏横条 / ⊕ 显示横条」「↻ 刷新」。刷新期间按钮显示「刷新中…」;只有 `/usage` 跑不出来时才弹提示。

**配色由配速决定,不由用量的绝对值决定**:超速阈值采用 Claude Code 自己的限额预警标定(`five_hour`: 0.9/0.72;`seven_day`: 0.25/0.15、0.5/0.35、0.75/0.6),随窗口推进而收紧。

## 数据从哪来

| 来源 | 内容 |
|---|---|
| 会话自带的限额数据 | 5 小时、7 天窗口,每次回复后更新 |
| `~/.claude.json` 里的 `cachedUsageUtilization` | Claude Code 自己的用量缓存,含按模型区分的配额(Fable 等) |
| 本机 `claude -p --no-session-persistence /usage`(只在点「↻ 刷新」时) | 按模型区分的配额的最新值;本地 10 分钟内没有 5 小时 / 7 天读数时(比如新会话还没回复过),也用它补上 |
| `~/.weektoken/samples.jsonl`(可选) | WeekToken macOS 版的历史采样,只读导入 |

采样存在本 mod 的跨会话存储里,最多 8000 条,满了丢最旧的。几个会话同时开着时采样会合并,同一份读数只留一条。没有 WeekToken macOS 版的历史可导入时,历史从安装 mod 起记录:接口只给当前值。

没用的配额数值不会变,所以旧数据照样能算配速。

## 命令

| 命令 | 作用 |
|---|---|
| `/weektoken` | 打开配速面板 |
| `/weektoken hide` | 隐藏横条(跨会话记住) |
| `/weektoken show` | 重新显示横条 |

## 配置

不需要配置。下面两个环境变量可以覆盖默认行为,写进 shell 配置文件(如 `~/.zshrc`)后开新会话生效:

| 环境变量 | 作用 |
|---|---|
| `WEEKTOKEN_LANG` | `zh` 或 `en`,强制界面语言。默认先看 Claude Code 的 language 设置,没设就跟系统语言 |
| `WEEKTOKEN_HISTORY` | WeekToken macOS 版历史文件的位置;设成空字符串就不导入 |
| `CLAUDE_MODS_DISABLE` | 设成 `all`,或逗号分隔的列表里含 `weektoken`,整个 mod 停用 |

## 隐私与权限

mod 和 Claude Code 本身权限相同、不在沙箱里。下面是 WeekToken 除了画自己的横条和面板之外做的全部事情。

### 发送什么、发到哪里

WeekToken 自己不联网,读到的任何东西都不会发出去。唯一离开你电脑的请求是 Claude Code 发的,不是 mod 发的:点「↻ 刷新」时,mod 运行 Claude Code 自带的 `/usage` 命令(见下表),由 Claude Code 用它已有的登录去 Anthropic 的用量接口(`/api/oauth/usage`)查询用量。不调模型、不耗额度;用 `claude --debug-file` 核对过。

### 运行哪些程序、为什么

所有命令都是固定文本,都不经过 shell。

| 命令 | 什么时候 | 为什么 |
| --- | --- | --- |
| `claude -p --no-session-persistence /usage` | 只在点「↻ 刷新」时 | Fable 这类按模型的配额,只有它能给出最新值。mod 先在 `PATH` 里找 `claude`,再找 `~/.local/bin`、`~/.claude/local`、`/opt/homebrew/bin`、`/usr/local/bin`。不留会话记录 |
| `defaults read -g AppleLanguages` | 会话开始时,以及改了 Claude Code 的语言设置时 | Claude Code 没设语言时,读 macOS 的系统语言(只在 macOS 上) |
| `tail -n 8000 ~/.weektoken/samples.jsonl` | 会话开始时和每 10 分钟,文件存在才运行 | 导入 WeekToken macOS 版的历史 |
| `perl -0777 -ne '<固定的正则>' ~/.claude.json` | 只在 `~/.claude.json` 超过 4 MiB、无法直接读取时 | 只抽出 `cachedUsageUtilization` 这一项 |

### 在你电脑上读什么

- `~/.claude.json`,Claude Code 自己的文件。只用其中的 `cachedUsageUtilization`:Claude Code 的用量缓存,含按模型的配额。这个文件里还有账号信息,mod 不用也不留。会话开始时读一次,之后每 5 分钟在文件变了时读,点刷新时也读。
- `~/.weektoken/samples.jsonl`,或 `WEEKTOKEN_HISTORY` 指定的文件,存在时才读。
- 环境变量:`HOME` 和 `PATH`(用来找上面的文件和 `claude`)、`LANG`、`LC_ALL`、`LC_MESSAGES`(界面语言)、`WEEKTOKEN_LANG`、`WEEKTOKEN_HISTORY`、`CLAUDE_MODS_DISABLE`。不读任何凭据。
- 从 Claude Code 读:会话的限额数据、每轮回复的时刻和所用模型、`language` 设置。

### 存什么

存在本 mod 自己的存储里、留在你的电脑上:采样(最多 8000 条)及其版本号、各模型最近一次被用的时刻、横条显示/隐藏和显示的配额、面板选中的配额、导入过的历史文件的修改时间、是否已显示过欢迎提示。界面语言每次会话重新探测,不存。

### 钩子

| 钩子 | 做什么 |
| --- | --- |
| `session.start` | 注册 `/weektoken`,载入已存的采样,读上面的数据来源,启动 1、5、10 分钟的定时器 |
| `session.measure` | 会话的 5 小时、7 天数据变了时记一次采样 |
| `turn.complete` | 记下每轮回复的时刻和模型,用来判断配额上次什么时候被用 |
| `command.run`,只管 `/weektoken` | 回答自己的命令:打开面板,或显示、隐藏横条 |
| `ui.render`,`AbovePrompt` | 画横条,再把别的插件或 Claude Code 在这里画的东西接在下面 |
| `ui.render`,只管 `weektoken` 面板 | 画 `/weektoken` 面板 |
| `ui.press` | 记下自己面板上的按下,所有按下原样往下传 |
| `ui.focus` | 事件原样往下传。在桌面端自己的面板上,如果一次点击只把焦点移到了按钮上(面板没焦点时的第一次点击),就执行那个按钮的动作 |
| `config.set`,只管 `language` | 设置原样往下传,之后重新探测界面语言 |

它不改任何设置或权限,也不动别的插件的事件。

## 要求

- Claude Code 2.1.287 或更新(mods 默认开启)。更早、在抢先体验 mods 的版本,先在 `~/.claude/settings.json` 里加上 `"env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }`
- Claude 订阅:按 API key 计费的会话没有限额数据

## 开发

```bash
claude plugin validate .
claude plugin test
```

## 作者

mj0111 · [@mj0011sec](https://x.com/mj0011sec)
