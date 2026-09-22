# 归集与还原的执行

仅当要执行归集、还原，或排查归集后的异常时读本文件。

脚本是 `scripts/scene-tool.ts`，只用 Node 内置模块，靠原生类型剥离直接运行，不需要编译也不需要安装依赖。下文的 `scene-tool.ts` 均指该路径。

Node 22.18 以上直接 `node scene-tool.ts`。22.6 到 22.17 之间要加 `--experimental-strip-types`；低于 22.6 不支持运行 TypeScript，升级 Node 即可。

skills 根目录的定位顺序是：`--skills-root` 参数、`CLAUDE_CONFIG_DIR` 环境变量、`~/.claude/skills`。`settings.json` 与状态文件都在它的父目录下。

## 一、归集

### 第 1 步：盘点

```bash
node scene-tool.ts scan
```

输出里有三处要看：仍在注入的数量、估算的 token 体积、以及 frontmatter 带 `disable-model-invocation` 的清单。前两个用来跟用户说明收益；第三个是需要区别处置的那批——旧版本机制打的标由 `apply` 自动摘掉，skill 自带的保留原样。

### 第 2 步：产出方案

按 [scene-authoring.md](scene-authoring.md) 做归类，写出 `scenes.json`。

方案里每个 skill 只能有一个主场景。同一个 skill 出现在两个场景里，脚本会拒绝执行——跨场景使用直接按名字调用，不靠重复登记。

### 第 3 步：用户确认

**这一步不能跳过，也不能用"我先做了你再看"代替。**

拿给用户确认三件事：

1. **场景划分**：几个场景、各自收了哪些 skill。
2. **取舍结果**：哪些 skill 被判为同职责而落选，理由是什么。
3. **写入面**：会新建 `scene-*` 目录、在 `settings.json` 里加 `skillOverrides` 条目、写状态文件。skill 文件本身不动（唯一例外是摘掉旧版本机制留下的 `disable-model-invocation`，`dry-run` 会报出个数）。

先 dry-run 给用户看规模：

```bash
node scene-tool.ts apply --plan scenes.json --dry-run
```

### 第 4 步：执行

```bash
node scene-tool.ts apply --plan scenes.json
```

可选参数 `--allow-unplanned`：允许方案未覆盖的 skill 保持现状。默认情况下有遗漏就停下报错，避免静默漏掉。

执行完把结果报给用户：建了几个场景、写了几条档位、保留了哪些原值、索引和状态文件在哪。**改动即时生效，不必重开会话**，可以当场验证。

### 档位的语义

`skillOverrides` 写的是 `name-only`：skill 留在启动清单里但只有名字，description 不再注入，Skill 工具调用不受影响。另外两档本机制不用——`user-invocable-only` 会让模型调不动，`off` 连用户也调不了。

两类 skill 设不了档位，`apply` 分别处置：

- **插件提供的**（`codex:*`、`anthropic-skills:*` 这类）：任何档位对它们都按 `on` 处理，写了也没用。它们本来也不在 skills 目录下，不进归集。
- **frontmatter 自带 `disable-model-invocation: true` 的**：该字段锁死 `on`/`name-only` 两档，且禁掉模型调用。文件与配置都不动，只把它列进场景清单，并在清单里注明只能由用户手工 `/name` 调用。

## 二、状态文件

位置是 skills 根目录的**父目录**下的 `.skill-scene-state.json`（默认 `~/.claude/.skill-scene-state.json`），与 `settings.json` 同级。

放在父目录是刻意的：删掉本 skill 时状态文件不受影响，否则卸载即失去还原依据。

结构：

```json
{
  "version": 3,
  "applied_at": "2026-09-22T04:10:00+00:00",
  "skills_root": "/Users/x/.claude/skills",
  "settings_path": "/Users/x/.claude/settings.json",
  "override_value": "name-only",
  "scenes": ["scene-software-delivery"],
  "overridden": ["dw-workflow", "dw-worktree"],
  "self_disabled": ["ak-ask"],
  "preexisting_overrides": [{ "name": "ak-play", "value": "off", "source": "settings.json" }],
  "untouched": ["ak-bro"],
  "unmarked_legacy": ["dw-workflow"],
  "plan": { "scenes": [], "unassigned": [] }
}
```

四份名单对应四种处置：

- `overridden` —— 本工具写进 `skillOverrides` 的条目，还原时逐个删掉。
- `self_disabled` —— frontmatter 自带 `disable-model-invocation` 的。只在场景清单里露面，文件与配置都没改。
- `preexisting_overrides` —— 用户自己设过档位的。原值保留不覆盖，还原时也不动。
- `untouched` —— 声明不归集的。从头到尾没碰过，列在这里只是让 `verify` 别把它们当成漏网的新 skill。

`unmarked_legacy` 记录迁移时从 frontmatter 摘掉的旧打标，只作留痕。旧状态文件里的 `index` 字段指向已废弃的 `SCENE-INDEX.md`，`apply` 与 `restore` 只用它来清理那份旧产物。

v1（`marked` 是 `{name, had_field}` 数组）与 v2（`marked` 是字符串数组）的状态文件仍被认得：`apply` 会把其中本工具打过的标摘掉再改用档位，`restore` 也会一并处理。

## 三、还原

```bash
node scene-tool.ts restore
```

它做三件事：从 `settings.json` 删掉 `overridden` 名单里的条目（删空后连 `skillOverrides` 键一起移除）、删除所有场景入口目录、删除状态文件。旧版本生成过 `SCENE-INDEX.md` 反查索引，状态文件里记着它时一并删掉。遇到 v1/v2 状态文件时额外摘掉当年打在 frontmatter 上的标。`self_disabled`、`preexisting_overrides`、`untouched` 三份名单从头到尾没被改过，还原时自然也不碰。

## 四、故障处置

### 状态文件丢失

`restore` 会拒绝执行。这是刻意的：`skillOverrides` 里可能混着用户自己设的档位——他可能刻意把某个 skill 设成 `off`——无差别清空会把这些选择一起抹掉。

没有状态文件时的处置：

1. 用各 `scene-*/SKILL.md` 的清单恢复出被管理的 skill 名单。
2. 把 `settings.json` 里 `skillOverrides` 的现状拿出来，与这份清单对照：清单内、值为 `name-only` 的，基本可判为本机制所写；清单外的、或值是 `off`/`user-invocable-only` 的，是用户自己设的。
3. 拿这份判断给用户确认后再动手，不要自己拍板。

### 模型报 "cannot be used with Skill tool due to disable-model-invocation"

说明这个 skill 的 frontmatter 里有那个字段，不是本机制的档位在起作用。两种来源：

- **kit 升级把字段带回来了**（旧版本机制曾经打在文件里，上游或备份覆盖回来）。`verify` 会报出来，重新 `apply` 即可摘掉。
- **skill 自带**。那是它自身调用契约的要求，不要摘。需要它时请用户手工 `/name` 调用。

### 档位丢失或被改动

症状是注入量莫名回升，或某个 skill 又开始带 description 出现在清单里。

```bash
node scene-tool.ts verify
```

它逐条比对 `overridden` 名单的生效档位，报出缺失或值不对的条目。重新 `apply` 即可补回，该命令对已设好的条目是幂等的。

注意 `settings.local.json` 的优先级高于 `settings.json`：本地文件里给同一个 skill 设了别的档位时，写进 `settings.json` 的值不会生效。`apply` 会把这种情况记进 `preexisting_overrides` 并跳过，不去覆盖。

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

`settings.json` 的位置跟着 skills 根目录的父目录走，所以设了 `CLAUDE_CONFIG_DIR` 的机器上会写到该目录下，不会串到 `~/.claude`。

归集不修改 skill 文件，因此软链（或 Windows 上的目录联接）安装的 skill 不需要特殊处置：改动只落在 Claude Code 自己的配置里，共用 `~/.agents/skills/` 的其他工具不受影响。
