# 归集与还原的执行

仅当要执行归集、还原，或排查归集后的异常时读本文件。

脚本是 `scripts/scene-tool.ts`，只用 Node 内置模块，靠原生类型剥离直接运行，不需要编译也不需要安装依赖。下文的 `scene-tool.ts` 均指该路径。

Node 22.18 以上直接 `node scene-tool.ts`。22.6 到 22.17 之间要加 `--experimental-strip-types`；低于 22.6 不支持运行 TypeScript，升级 Node 即可。

skills 根目录的定位顺序是：`--skills-root` 参数、`CLAUDE_CONFIG_DIR` 环境变量、`~/.claude/skills`。

## 一、归集

### 第 1 步：盘点

```bash
node scene-tool.ts scan
```

输出里有三个数要看：仍在注入的数量、估算的 token 体积、软链 skill 的数量。前两个用来跟用户说明收益，第三个决定下一步要不要问一个额外的问题。

### 第 2 步：产出方案

按 [scene-authoring.md](scene-authoring.md) 做归类，写出 `scenes.json`。

方案里每个 skill 只能有一个主场景。同一个 skill 出现在两个场景里，脚本会拒绝执行——跨场景使用靠 `SCENE-INDEX.md` 解决，不靠重复登记。

### 第 3 步：用户确认

**这一步不能跳过，也不能用"我先做了你再看"代替。**归集会改写上百个文件。

拿给用户确认三件事：

1. **场景划分**：几个场景、各自收了哪些 skill。
2. **取舍结果**：哪些 skill 被判为同职责而落选，理由是什么。
3. **软链的处置**（`scan` 报了软链时才问）：软链 skill 的本体在 skills 根目录之外，`~/.agents/skills/` 是 Cursor 和 Grok Build 共用的全局 skill 目录。打标会同时影响它们——Cursor 支持同一个字段、行为一致，Grok Build 的行为未经验证。要保守就加 `--skip-symlinks`，代价是这些 skill 的注入省不掉。

先 dry-run 给用户看规模：

```bash
node scene-tool.ts apply --plan scenes.json --dry-run
```

### 第 4 步：执行

```bash
node scene-tool.ts apply --plan scenes.json
```

可选参数：

- `--skip-symlinks`：不打标软链 skill。
- `--allow-unplanned`：允许方案未覆盖的 skill 保持现状。默认情况下有遗漏就停下报错，避免静默漏掉。

执行完把结果报给用户：建了几个场景、打标几个、跳过几个、索引和状态文件在哪。**改动即时生效，不必重开会话**，可以当场验证。

## 二、状态文件

位置是 skills 根目录的**父目录**下的 `.skill-scene-state.json`（默认 `~/.claude/.skill-scene-state.json`）。

放在父目录是刻意的：删掉本 skill 时状态文件不受影响，否则卸载即失去还原依据。

结构：

```json
{
  "version": 2,
  "applied_at": "2026-09-22T04:10:00+00:00",
  "skills_root": "/Users/x/.claude/skills",
  "scenes": ["scene-software-delivery"],
  "marked": ["dw-workflow", "dw-worktree"],
  "self_disabled": ["ak-ask"],
  "untouched": ["ak-bro"],
  "skipped_symlinks": [],
  "index": "skill-scene/SCENE-INDEX.md",
  "plan": { "scenes": [], "unassigned": [] }
}
```

三份名单对应三种处置：

- `marked` —— 本工具打的标，还原时全部摘掉。能进这份名单的一定原本没有该字段。
- `self_disabled` —— 方案把它们收进了场景，但它们自带该字段。只在场景清单里露面，文件一个字没改，还原时也不动。
- `untouched` —— 声明不归集的。从头到尾没碰过，列在这里只是让 `verify` 别把它们当成漏网的新 skill。

v1 的 `marked` 是 `{name, had_field}` 数组，`restore` 仍认得，会按 `had_field` 区分该摘哪些。

## 三、还原

```bash
node scene-tool.ts restore
```

它做三件事：摘掉 `marked` 名单里所有 skill 的字段、删除所有场景入口目录与索引、删除状态文件。`self_disabled` 与 `untouched` 两份名单从头到尾没被改过，还原时自然也不碰。

## 四、故障处置

### 状态文件丢失

`restore` 会拒绝执行。这是刻意的：有些 skill 本来就带 `disable-model-invocation: true`——那是它自身调用契约的要求，典型的是正文依赖 `$ARGUMENTS` 的 skill，模型自动触发时拿不到参数，这个 skill 根本跑不起来。无差别删除会把这类设计一起抹掉。

没有状态文件时的处置：

1. 用 `SCENE-INDEX.md` 恢复出被管理的 skill 清单（索引还在的话）。
2. 逐个人工确认哪些是自带的。判据是看它的正文是否依赖 `$ARGUMENTS`、是否有 `argument-hint`、动作是否不可逆——这三类大概率是自带的。
3. 拿这份清单给用户确认后再动手，不要自己拍板。

### 打标丢失

kit 升级会覆盖它管理的 skill 文件，连带把打标冲掉。症状是注入量莫名回升。

```bash
node scene-tool.ts verify
```

它会列出"打标丢失"的条目。重新执行 `apply --plan scenes.json` 即可补回，该命令对已打标的 skill 是幂等的。

### 装了新 skill

`verify` 会把未归集的新 skill 列出来。处置是把它们加进 `scenes.json` 的对应场景或 `unassigned`，重新 `apply`。

新 skill 在被归集之前照常参与自动路由，不会失效，所以这件事不紧急，可以攒一批再做。

### 场景入口被误删

场景目录里只有一个 `SKILL.md`，没有任何独有内容，重新 `apply` 就能重建。

### scenes.json 丢了

归类决策是整套归集里唯一的人工输入，所以 `apply` 会把完整方案存进状态文件的 `plan` 字段。把它取出来另存即可，不必重做归类：

```bash
node -e 'console.log(JSON.stringify(require(process.env.HOME+"/.claude/.skill-scene-state.json").plan,null,2))' > scenes.json
```

## 五、跨平台

脚本用 `node:path` 拼接路径，Windows 与 POSIX 通用。

一处平台差异：`scan` 对软链 skill 的识别依赖符号链接。Windows 上若 skill 是以目录联接（junction）或副本方式安装的，`scan` 不会把它们报成软链，此时打标只影响本机 Claude Code，不存在波及其他工具的问题。
