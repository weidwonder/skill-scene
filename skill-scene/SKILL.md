---
name: skill-scene
description: "把过多的 skill 按场景归集：少数场景入口参与模型的自动路由，skill 本体退出启动注入但保留斜杠手工调用。用户嫌 skill 太多、启动上下文被吃满、要整理或归集技能时使用；skills 目录下出现 scene-* 入口、要在场景里找到并使用 skill 时使用；用户问某个 skill 归在哪个场景、为什么某个 skill 不见了、怎么恢复原样时使用。不负责单个 skill 的写法质量（那是 skill-principle 的职责），不决定某个 skill 该不该装，只处理 Claude Code 的 skills 目录。"
---

# Skill Scene

把 skills 目录重排成两层：少数 `scene-*` 入口参与模型的自动路由，其余 skill 退出启动注入、改由场景带出。用户的斜杠手工调用全程不受影响。

**非目标**：不评价单个 skill 写得好不好、description 触发得动触发不动——那是 `skill-principle`；不决定某个 skill 该不该安装或卸载；不处理 agents、commands、plugins 的注入。

**适用范围只有 Claude Code 的 skills 目录。** Cursor 与 Grok Build 共用 `~/.agents/skills/`，Codex 用 `agents/openai.yaml` 的 `allow_implicit_invocation` 控制隐式调用，机制各不相同，本 skill 不管。但本机的 skill 若是从 `~/.agents/skills/` 软链过来的，打标会波及那些工具——这一条的处置在 [references/collation.md](references/collation.md) 第 3 步。

## 归属表

| 事实类别 | 它的家 | 什么时候读 |
|---------|--------|-----------|
| 机制约束、三条硬事实 | 本文件〈机制约束〉 | 触发即读 |
| 日常在场景里找 skill、跨场景引用 | 本文件 A 节 | 触发即读 |
| 场景怎么划、scene SKILL.md 怎么写 | [references/scene-authoring.md](references/scene-authoring.md) | 仅当要生成或调整场景划分时 |
| 归集/还原的执行步骤与脚本用法 | [references/collation.md](references/collation.md) | 仅当要执行归集、还原或排查归集故障时 |
| 归集后每个 skill 归哪个场景 | 本 skill 目录下的 `SCENE-INDEX.md`（由脚本生成） | 仅当要找的 skill 不在当前场景内时 |

## 机制约束

这三条决定了整套机制为什么这样设计，动手前必须知道：

1. **「能被模型自动选中」和「description 常驻启动上下文」是同一件事。** description 存在的唯一目的就是给模型做匹配判断。所以让一个 skill 省下注入，代价必然是它失去被模型自动选中的资格，没有中间态。
2. **`disable-model-invocation: true` 让 description 不进启动上下文，但 `/skill-name` 手工调用不受影响。** 这是本机制的支点：模型侧安静，用户侧照常。
3. **skill 本体只有一份，场景只持有指向它的链接。** 场景目录里只有 `SKILL.md` 一个文件，正文用相对链接指向 `../<skill-name>/SKILL.md`。任何形式的复制都会制造第二份真相，ak 之类的工具升级后就会出现场景里是旧版、原位是新版。

补充两条操作前提：

- 改动 skills 目录当前会话即时生效，不必重开会话。
- 场景内的 skill 用 **Read 读取全文**，不是用 Skill 工具调用——它们已经退出模型可调用范围。读到的 markdown 就是完整指令，照它执行即可。

## A. 在已归集的环境里工作

`skills/` 下出现 `scene-*` 入口，说明这台机器已经归集过。

### A1. 选场景

像平常选 skill 一样选场景：读各 `scene-*` 的 description，判断当前任务落在哪个场景，调用那一个。场景的 SKILL.md 正文会列出它名下的 skill 清单。

一次任务通常只进一个场景。任务确实横跨两个领域时（比如"把这个 bug 的修复过程写成飞书文档"），分别进入两个场景，不要试图在一个场景里硬凑。

### A2. 用场景内的 skill

场景正文的清单每项都是一条指向原件的相对链接（`../<skill-name>/SKILL.md`）。把它对着刚读的那份场景文件的目录解析成绝对路径，再 Read。

skills 根目录默认是 `~/.claude/skills`，设了 `CLAUDE_CONFIG_DIR` 时则是该目录下的 `skills`——不要把默认位置当成定死的。

读到的永远是最新版，因为场景持有的是链接而不是副本。

只读当前这一步真正需要的那一两个，不要把整个场景的 skill 全部读进来——那等于把刚省下的注入又花回去。

### A3. 跨场景引用

场景内的 skill 经常会点名另一个场景的 skill（例如开发流程里写着「修 bug 用 dw-bug-diagnosis」）。两种走法，按目的选：

**只要那一个 skill 的内容** —— 直接按名字读，不用管它属于哪个场景：

```
Read ~/.claude/skills/<skill-name>/SKILL.md
```

skill 本体都平铺在 `skills/` 顶层，路径由名字直接推出来。

**整个工作重心要转移过去** —— 先查它的归属，再进那个场景：

```
Read ~/.claude/skills/skill-scene/SCENE-INDEX.md
```

这份索引一行一个场景，后面跟它名下的 skill 名，只有对应关系没有别的。进入那个场景能同时带出该领域的其他约定，比单读一个 skill 完整。

判断依据：接下来只用这一个 skill 的一两条规则，走第一种；接下来一连串动作都属于那个领域，走第二种。

### A4. 用户要手工调用

任何 skill 都还能用 `/skill-name` 调，归集不影响这条路。用户问「某个 skill 怎么不见了」时，说明它只是退出了自动路由，`/` 菜单里仍在，并告诉他它归在哪个场景。

## B. 什么时候提议归集

skills 目录下**未归集**的 skill（即顶层、且没有 `disable-model-invocation: true` 的）超过 25 个时，值得提一句。不要每轮都提，一个会话里最多提一次，用户说不用就不再提。

提的时候给出实际数字，不要只说"有点多"：

```bash
node <skill 根目录>/scripts/scene-tool.ts scan
```

它会报出未归集数量与这些 description 的实际体积。拿这个数字跟用户说。

用户主动说"skill 太多""上下文被吃满""整理一下技能"时，直接进入 C 节，不必再提议。

## C. 执行归集

**归集会改写 skills 目录，必须用户确认方案后才执行。** 完整步骤、脚本参数与故障处置在 [references/collation.md](references/collation.md)，开始执行前读它。

骨架是四步：

1. `scene-tool.ts scan` 盘点现状。
2. 按 [references/scene-authoring.md](references/scene-authoring.md) 的方法做归类，产出 `scenes.json`。
3. 把归类方案给用户看，逐项确认。**用户没确认之前不执行任何写操作。**
4. `scene-tool.ts apply --plan scenes.json` 执行，然后把结果报给用户。

## D. 还原

用户要恢复原样、或要卸载本机制时：

```bash
node <skill 根目录>/scripts/scene-tool.ts restore
```

它按状态文件 `~/.claude/.skill-scene-state.json` 回滚：删掉 `scene-*` 目录与 `SCENE-INDEX.md`，并只摘掉本机制加过的 `disable-model-invocation`。

**状态文件丢失时脚本会报错停下，不要猜着还原。** 有些 skill 本来就自带 `disable-model-invocation: true`（那是它自身调用契约的要求，例如正文依赖 `$ARGUMENTS` 的 skill），无差别删除会破坏它们的设计。处置见 [references/collation.md](references/collation.md)〈状态文件丢失〉。

## 案例

**案例 1 — 归集后的一次普通开发任务**：用户说"给 agent_fs 加个断点续传"。读到 `scene-software-delivery` 的 description 匹配，调用它；场景正文列出 `dw-prd`、`dw-workflow`、`dw-worktree` 等清单；当前要先出 spec，于是只 Read 了 `~/.claude/skills/dw-workflow/SKILL.md` 一份，按它走流程。中途要建 worktree 时再 Read `dw-worktree`。全程没有读其余六个。

**案例 2 — 跨场景引用**：在开发场景里，`dw-workflow` 写着"修复后的评审用 dw-review-gate"。`dw-review-gate` 就在同场景内，直接读。后来又遇到"把评审结论发到群里"，这属于飞书领域且接下来还要查群、发消息、传附件，于是读 `SCENE-INDEX.md` 查到 `lark-im` 属于 `scene-lark-collab`，进入该场景而不是单读 `lark-im`。

**案例 3 — 用户发现 skill 不见了**：用户问"我的 ak-seo 呢，怎么搜不到了"。答：它没被删，只是退出了自动路由，`/ak:seo` 仍可直接调；它归在 `scene-growth-conversion`，进那个场景我也能用它。
