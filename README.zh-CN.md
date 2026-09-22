# skill-scene

[English](README.md) · **简体中文**

把过多的 skill 按场景归集，让启动注入从上百份 description 缩到十来份。

## 解决什么问题

Claude Code 在会话启动时，会把 `~/.claude/skills/` 下每个 skill 的 `name` 与 `description` 注入系统提示，与当前项目是否用得上无关。装到上百个 skill 时，这份「菜单」本身就要吃掉近万 token，而且几十个职责相近的条目会持续互相稀释路由的准确度。

## 怎么解决

利用 Claude Code 的 per-skill 清单档位。`settings.json` 里的 `skillOverrides` 按 skill 名逐个设档，四档的官方语义是：

| 档位 | 启动清单 | 模型调用 | `/name` 手工调用 |
|------|---------|---------|-----------------|
| `on`（默认） | 名字 + description | 可以 | 可以 |
| `name-only` | **只有名字** | **可以** | 可以 |
| `user-invocable-only` | 不出现 | 不可以 | 可以 |
| `off` | 不出现 | 不可以 | 不可以 |

本机制用 `name-only`：description 不再注入，skill 仍留在清单里、仍能被 Skill 工具正常调用。于是把 skills 目录重排成两层：

```
~/.claude/skills/
├── skill-scene/              # 本 skill，常驻
├── scene-software-delivery/
│   └── SKILL.md              # 场景入口：参与自动路由，正文列出本场景的 skill
├── dw-workflow/              # 文件一个字不改，只在 settings 里设 name-only
└── lark-doc/                 # 同上
```

模型看到的是十来个带 description 的场景入口，外加一串没有 description 的 skill 名字。它先判断当前任务属于哪个场景，进入后从场景正文拿到该领域的 skill 清单与各自的完整 description，再按需调用其中一两个。用户的 `/` 手工调用全程不受影响。

**归集不修改任何 skill 文件。** 配置写在 `settings.json`，所以 kit 升级覆盖 SKILL.md 不会冲掉归集，软链到 `~/.agents/skills/` 的 skill 也不会波及共用该目录的其他工具。

场景目录里只有一个 `SKILL.md`，清单直接写 skill 名与它的完整 description，不复制正文也不做软链——skill 本体始终只有一份，上游升级后不会出现两份漂移。

## 前提

Node 22.18 以上（原生运行 TypeScript，无需编译或安装依赖）。22.6 到 22.17 之间运行脚本时加 `--experimental-strip-types`。

`skillOverrides` 需要 Claude Code 2.1 以上。

## 安装

把 `skill-scene/` 目录放到 `~/.claude/skills/` 下即可。

## 用法

```bash
cd ~/.claude/skills/skill-scene/scripts

node scene-tool.ts scan                          # 盘点：多少个仍在注入、占多少 token
node scene-tool.ts apply --plan scenes.json --dry-run
node scene-tool.ts apply --plan scenes.json      # 执行归集
node scene-tool.ts verify                        # 校验一致性
node scene-tool.ts restore                       # 还原
```

归类方案 `scenes.json` 由使用它的 Agent 按 `references/scene-authoring.md` 的方法产出，交用户确认后执行。

## 还原

`restore` 依据 `~/.claude/.skill-scene-state.json` 回滚，只删本工具写进 `skillOverrides` 的那些条目——用户自己设过档位的 skill 原值保留。状态文件不在时脚本拒绝执行，不做推断。

状态文件刻意放在 skills 根目录的父目录，与 `settings.json` 同级，删掉本 skill 也不会丢失还原依据。

## 适用范围

只处理 Claude Code 的 `~/.claude/skills/`。

两类 skill 不受 `skillOverrides` 管：插件提供的 skill（对它们任何档位都按 `on` 处理），以及 frontmatter 自带 `disable-model-invocation: true` 的 skill（该字段会锁死 `on`/`name-only` 两档，并禁掉模型调用）。后者本来就不参与自动路由，归集时只把它列进场景清单，文件与配置都不动。

Cursor 与 Grok Build 共用 `~/.agents/skills/`，Codex 读 `$HOME/.agents/skills` 且用 `agents/openai.yaml` 里的 `allow_implicit_invocation` 控制隐式调用，机制各不相同。本机制只写 Claude Code 自己的 `settings.json`，不碰 skill 文件，所以对这些工具没有影响。
