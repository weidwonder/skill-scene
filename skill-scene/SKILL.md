---
name: skill-scene
description: "把过多的 skill 按场景归集：少数场景入口参与模型的自动路由，其余 skill 的 description 退出启动注入、改由场景带出，调用方式不变。用户嫌 skill 太多、启动上下文被吃满、要整理或归集技能时使用；skills 目录下出现 scene-* 入口、要在场景里找到并使用 skill 时使用；用户问某个 skill 归在哪个场景、为什么某个 skill 不见了、怎么恢复原样时使用。不负责单个 skill 的写法质量（那是 skill-principle 的职责），不决定某个 skill 该不该装，只处理 Claude Code 的 skills 目录。"
---

# Skill Scene

把 skills 目录重排成两层：少数 `scene-*` 入口参与模型的自动路由，其余 skill 的 description 退出启动注入、改由场景带出。它们的调用方式完全不变——模型用 Skill 工具、用户用 `/name`，都照旧。

**非目标**：不评价单个 skill 写得好不好、description 触发得动触发不动——那是 `skill-principle`；不决定某个 skill 该不该安装或卸载；不处理 agents、commands、plugins 的注入。

**适用范围只有 Claude Code 的 skills 目录。** Cursor 与 Grok Build 共用 `~/.agents/skills/`，Codex 用 `agents/openai.yaml` 的 `allow_implicit_invocation` 控制隐式调用，机制各不相同，本 skill 不管。归集只写 Claude Code 自己的 `settings.json`、不碰 skill 文件，所以软链过来的 skill 也不会波及那些工具。

## 归属表

| 事实类别 | 它的家 | 什么时候读 |
|---------|--------|-----------|
| 机制约束、四条硬事实 | 本文件〈机制约束〉 | 触发即读 |
| 日常在场景里找 skill、跨场景引用 | 本文件 A 节 | 触发即读 |
| 场景怎么划、常驻上限的处置、scene SKILL.md 怎么写 | [references/scene-authoring.md](references/scene-authoring.md) | 仅当要生成或调整场景划分时 |
| 归集/还原的执行步骤与脚本用法 | [references/collation.md](references/collation.md) | 仅当要执行归集、还原或排查归集故障时 |

## 机制约束

这四条决定了整套机制为什么这样设计，动手前必须知道：

1. **清单档位有三态，不是开关。** `settings.json` 的 `skillOverrides` 按 skill 名逐个设档：`on` 是名字加 description、模型可调；`name-only` 只留名字、**模型照样可调**；`user-invocable-only` 从模型清单里消失、只剩用户 `/name`；`off` 两边都没有。本机制用的是 `name-only`——省掉 description 这份注入，但不动模型的调用资格。
2. **`name-only` 的 skill 用 Skill 工具正常调用。** 它和平常调 skill 没有任何区别。省下的只是 description，代价是模型光看清单已认不出它能干什么，得靠场景正文给出判据——这正是场景存在的理由。
3. **frontmatter 的 `disable-model-invocation: true` 是另一回事，本机制不用它。** 该字段会连模型调用一起禁掉（Skill 工具报 `disable-model-invocation` 并要求转交用户手工调用），而且会锁死 `on`/`name-only` 两档，使清单档位无从设置。skill 自带该字段是它自身调用契约的要求（典型是正文依赖 `$ARGUMENTS`），这种 skill 只列进场景清单、配置与文件都不动，并在清单里注明只能由用户手工调用。
4. **skill 本体只有一份，场景只持有它的名字与 description。** 场景目录里只有 `SKILL.md` 一个文件，清单照搬各 skill 的完整 description。任何形式的复制正文都会制造第二份真相，ak 之类的工具升级后就会出现场景里是旧版、原位是新版。

补充三条操作前提：

- 改动 skills 目录与 `settings.json` 当前会话即时生效，不必重开会话。
- 归集**不修改任何 skill 文件**。所以 kit 升级覆盖 SKILL.md 冲不掉归集，`verify` 也不需要检查打标是否还在。
- 两类 skill 设不了档位：插件提供的（对它们任何档位都按 `on` 处理）、以及上面第 3 条那种自带字段的。

## A. 在已归集的环境里工作

`skills/` 下出现 `scene-*` 入口，说明这台机器已经归集过。

### A1. 选场景

像平常选 skill 一样选场景：读各 `scene-*` 的 description，判断当前任务落在哪个场景，调用那一个。场景的 SKILL.md 正文会列出它名下的 skill 清单。

一次任务通常只进一个场景。任务确实横跨两个领域时（比如"把这个 bug 的修复过程写成飞书文档"），分别进入两个场景，不要试图在一个场景里硬凑。

### A2. 用场景内的 skill

场景正文的清单每项是一个 skill 名加它的完整 description。挑中哪个，就**用 Skill 工具按名字调用**，和平常调 skill 没有区别。

只调当前这一步真正需要的那一两个，不要把整个场景的 skill 全部拉进来——那等于把刚省下的注入又花回去。

清单里注明「模型调不动」的那几个（frontmatter 自带 `disable-model-invocation`），只能由用户手工 `/name` 调用。需要它们时把这句告诉用户，不要试图代跑。

### A3. 跨场景引用

场景内的 skill 经常会点名另一个场景的 skill（例如开发流程里写着「修 bug 用 dw-bug-diagnosis」）。两种走法，按目的选：

**只要那一个 skill** —— 直接按名字用 Skill 工具调用，不用管它属于哪个场景。所有 skill 都还在清单里（只是没有 description），名字就是调用所需的全部。

**整个工作重心要转移过去** —— 按各 `scene-*` 的 description 选那个场景进去，和平常选场景一样。进入场景能同时带出该领域的其他约定，比单调一个 skill 完整。

拿不准某个 skill 归谁管时反查一次即可，不必记：

```bash
grep -l "<skill-name>" <skills 根目录>/scene-*/SKILL.md
```

skills 根目录默认是 `~/.claude/skills`，设了 `CLAUDE_CONFIG_DIR` 时则是该目录下的 `skills`——不要把默认位置当成定死的。

判断依据：接下来只用这一个 skill 的一两条规则，走第一种；接下来一连串动作都属于那个领域，走第二种。

### A4. 用户问某个 skill 去哪了

它没被删也没被禁：只是 description 不再进启动清单，所以模型光看清单认不出它能干什么。`/` 菜单照旧，模型也照旧能调。告诉用户它归在哪个场景即可。

## B. 什么时候提议归集

判据不是 skill 的数量，而是**这份清单是否已经在妨碍判断**：同一件事出现好几个候选、名字相近但职责不明、你得逐条比对才能选出该用哪个——这时候归集能同时省下注入和减少犹豫。

先拿到实际数字再开口，不要只说"有点多"：

```bash
node <skill 根目录>/scripts/scene-tool.ts scan
```

它会报出未归集的数量和这些 description 的实际体积，把这两个数字给用户，由他判断值不值得做。

一个会话里最多提一次，用户说不用就不再提。

用户主动说"skill 太多""上下文被吃满""整理一下技能"时，直接进入 C 节，不必再提议。

已经归集过的环境里，用户说装了新 skill、或 `scan` 报出常驻超过上限时，跑一次 `scene-tool.ts verify`。它会列出还没归集的新 skill 和未经用户同意的常驻，报错里写着处置方法；照着补进方案，重新走 C 节的第 3、4 步。

## C. 执行归集

**归集会新建场景目录并改写 `settings.json`，必须用户确认方案后才执行。** 完整步骤、脚本参数与故障处置在 [references/collation.md](references/collation.md)，开始执行前读它。

骨架是四步：

1. `scene-tool.ts scan` 盘点现状。
2. 按 [references/scene-authoring.md](references/scene-authoring.md) 的方法做归类，产出 `scenes.json`。**常驻**（不在任何场景里、仍带 description 进启动清单的）最多 15 个，超出时先设法归集，见该文件〈常驻上限〉。
3. 把归类方案给用户看，逐项确认，包括常驻名单。常驻仍超上限时，由用户决定是换一种归集方式，还是同意它们常驻。**用户没确认之前不执行任何写操作。**
4. `scene-tool.ts apply --plan scenes.json` 执行，然后把结果报给用户。

## D. 还原

用户要恢复原样、或要卸载本机制时：

```bash
node <skill 根目录>/scripts/scene-tool.ts restore
```

它按状态文件 `~/.claude/.skill-scene-state.json` 回滚：删掉 `scene-*` 目录，并从 `settings.json` 的 `skillOverrides` 里删掉本机制写入、值仍是 `name-only` 的条目。用户自己设过档位的、自带 `disable-model-invocation` 的、以及声明不归集的，从头到尾没被改过，还原时也不碰。

**状态文件丢失时脚本会报错停下，不要猜着还原。** `skillOverrides` 里可能混着用户自己设的档位（他可能刻意把某个 skill 设成 `off`），无差别清空会把这些选择一起抹掉。处置见 [references/collation.md](references/collation.md)〈状态文件丢失〉。

## 案例

**案例 1 — 归集后的一次普通开发任务**：用户说"给 agent_fs 加个断点续传"。读到 `scene-software-delivery` 的 description 匹配，调用它；场景正文列出 `dw-prd`、`dw-workflow`、`dw-worktree` 等清单及各自的完整 description；当前要先出 spec，于是只调了 `dw-workflow` 一个，按它走流程。中途要建 worktree 时再调 `dw-worktree`。全程没有碰其余六个。

**案例 2 — 跨场景引用**：在开发场景里，`dw-workflow` 写着"修复后的评审用 dw-review-gate"。`dw-review-gate` 就在同场景内，直接调。后来又遇到"把评审结论发到群里"，这属于飞书领域且接下来还要查群、发消息、传附件，于是按 description 进了 `scene-lark-collab`，而不是单调 `lark-im`。

**案例 3 — 用户发现 skill 不见了**：用户问"我的 ak-seo 呢，怎么搜不到了"。答：它没被删也没被禁用，只是 description 不再进启动清单，所以我光看清单认不出它做什么；`/ak:seo` 照旧可调，我也照旧能调它。它归在 `scene-growth-conversion`，进那个场景我就拿到它的完整 description 了。
