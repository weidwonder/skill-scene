# skill-scene

把过多的 skill 按场景归集，让启动注入从上百份 description 缩到十来份。

## 解决什么问题

Claude Code 在会话启动时，会把 `~/.claude/skills/` 下每个 skill 的 `name` 与 `description` 注入系统提示，与当前项目是否用得上无关。装到上百个 skill 时，这份「菜单」本身就要吃掉近万 token，而且几十个职责相近的条目会持续互相稀释路由的准确度。

## 怎么解决

利用一条 Claude Code 原生机制：

> frontmatter 里写了 `disable-model-invocation: true` 的 skill，description 不进启动上下文，但 `/skill-name` 手工调用照常。

于是把 skills 目录重排成两层：

```
~/.claude/skills/
├── skill-scene/              # 本 skill，常驻
│   └── SCENE-INDEX.md        # scene 与 skill 的名称对应（生成物）
├── scene-software-delivery/
│   └── SKILL.md              # 场景入口：参与自动路由，正文链接到本场景的 skill
├── dw-workflow/              # 原地不动，加一行 disable-model-invocation: true
└── lark-doc/                 # 同上
```

模型看到的只剩十来个场景入口。它先判断当前任务属于哪个场景，进入后从场景正文拿到该领域的 skill 清单，按需读取具体那一两份。用户的 `/` 手工调用全程不受影响。

场景目录里只有一个 `SKILL.md`，清单是指向原件的相对链接，不复制也不做软链——skill 本体始终只有一份，上游升级后不会出现两份漂移。

## 前提

Node 22.18 以上（原生运行 TypeScript，无需编译或安装依赖）。22.6 到 22.17 之间运行脚本时加 `--experimental-strip-types`。

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

`restore` 依据 `~/.claude/.skill-scene-state.json` 回滚，只摘掉本工具加过的字段——本来就自带 `disable-model-invocation` 的 skill（那是它自身调用契约的要求）会被原样保留。状态文件不在时脚本拒绝执行，不做推断。

状态文件刻意放在 skills 根目录的父目录，删掉本 skill 也不会丢失还原依据。

## 适用范围

只处理 Claude Code 的 `~/.claude/skills/`。

Cursor 与 Grok Build 共用 `~/.agents/skills/`，Codex 读 `$HOME/.agents/skills` 且用 `agents/openai.yaml` 里的 `allow_implicit_invocation` 控制隐式调用，机制不同。若本机的 skill 是从 `~/.agents/skills/` 软链过来的，打标会同时影响那些工具，`scan` 会把这类 skill 单独报出来，`apply --skip-symlinks` 可以跳过它们。
