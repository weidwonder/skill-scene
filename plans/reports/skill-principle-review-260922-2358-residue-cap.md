# skill-scene 未提交改动评审：常驻上限与两处再次 apply 修复

- 评审对象：`skill-scene/` 相对 `c3c09ec` 的未提交改动（README.md、README.zh-CN.md、SKILL.md、references/collation.md、references/scene-authoring.md、scripts/scene-tool.ts）
- 评审依据：skill-principle 原则库（1.x / 2.x / 3.x 中与本次改动相关的条目）
- 实测：在 scratchpad 临时 skills 根目录（26 个 skill、2 个场景）上跑了 scan / apply / apply --dry-run / verify；对 `~/.claude/skills` 只跑了 scan 与 verify（结果为「一致。」，旧状态文件没有 `residue` 字段也能正常读取，向后兼容没问题）
- 只评审，没有改仓库里的任何文件

## 结论

三项意图都已落地，也都实测验证过：超出上限且没有 waiver 时 apply（含 dry-run）会拒绝；上一轮写入、这一轮已不在场景里的档位会被删除；状态文件记录过的旧场景目录会被删除，用户自建的 `scene-*` 不受影响。

但「豁免只覆盖当时名单」这条在 **apply 端没有强制**；此外还有一处模板会让 Agent 原样照抄后直接绕过上限。两者都会让「交用户决定」这道闸门失效。文档方面的问题是同一套处置流程写了四遍，而且 scan 在归集之前也显示「超上限」，和 B 节「判据不是数量」相冲突。

---

## 必须改

### M1 [P0] scenes.json 示例把 `residue_waiver` 写成了非空占位串，照抄就能绕过上限
- 位置：`skill-scene/references/scene-authoring.md:69`
- 问题：示例 JSON 里是 `"residue_waiver": "（可选）常驻超过 15 个时，用户决定让它们照常常驻的理由"`。这是非空字符串，能通过 `loadPlan` 的校验。实测把这段示例原样放进方案后，dry-run 输出 `不归集且仍在注入 26 个（上限 15），用户决定常驻: （可选）常驻超过 15 个时…`，退出码 0。Agent 照模板产出 scenes.json 是常规做法，这样上限会被无声豁免，和同文件 :79「不要在用户拍板之前自己填」直接矛盾（2.2、2.3）。
- 建议：从示例 JSON 里删掉这一行，字段只在 :79 的「字段约束」里说明。如果确实要示范，就另起一个小代码块，标题写明「仅在用户决定常驻后添加」，并用一条明显是用户原话的理由做例子。

### M2 [P0/P1，需用户判决] waiver 在 apply 端不绑定名单，再次 apply 时会自动覆盖新增的常驻 skill
- 位置：`skill-scene/scripts/scene-tool.ts:676-679`（apply 只检查 `waiver` 是否非空）；文档承诺在 `scene-authoring.md:49`、`collation.md:104`、`collation.md:153`
- 问题：文档说「豁免只覆盖这一次 apply 时的那份常驻名单」，但只有 verify 按 `state.residue` 执行这条规则，apply 不执行。实测步骤：先带 waiver apply（常驻 20），再装 new1、new2；verify 能正确报出。接着 Agent 按 collation.md:151 的处置，把它们写进 `unassigned` 再 apply，旧 waiver 随方案带过去，apply 直接通过（常驻 22，退出码 0）；之后 verify 又报「一致。」。新增的两个没有经过用户决定就被豁免了。从 `state.plan` 恢复 scenes.json（collation.md:161-165）也会把旧 waiver 一起带回来。这是隐式依赖（2.12），也是在靠 Agent 自觉兜住一条硬约束，违背全局规则里的「显式声明」。
- 建议（两种，前一种是推荐方案，但会改动方案 schema，涉及用户先前的设计决定，请用户拍板）：
  1. **推荐**：waiver 显式列出名单，例如 `"residue_waiver": { "reason": "…", "skills": ["u01", …] }`。apply 时如果常驻数超限、且常驻名单里有不在 `skills` 中的名字，就拒绝执行并单独列出这些名字；verify 也改为对照 `plan.residue_waiver.skills`（这样 `state.residue` 可以不要，或者只留作记录）。豁免范围写在用户确认过的方案里，不依赖 Agent 记得去改 waiver。
  2. **最小改法**（保持字符串 schema）：apply 时如果已有上一轮状态、方案带 waiver、常驻数超限，并且常驻里出现了 `prior.residue` 之外的名字，就拒绝执行，错误信息列出这些新增名字，要求重新请用户决定。但这种做法仍需一个「用户已重新确认」的显式信号，否则 Agent 会卡住。所以还是推荐方案 1。

### M3 [P1] 删除 stale 档位时不看当前值，会抹掉用户后来自己改的档位
- 位置：`skill-scene/scripts/scene-tool.ts:668-669`、`:753`
- 问题：本次修复的意图是删掉「本工具设了 name-only」的档位，但 `stale` 只看 `prior.overridden`，不核对 settings.json 里的当前值。实测：apply 之后用户手动把 b3 改成 `off`，下一轮把 b3 移进 `unassigned`，apply 就把 `b3: off` 删掉了。dry-run 只报「将删掉…档位 4 个: a1, b1, b2, b3」，看不出其中一个是用户的值。结果是 b3 回到启动清单，还计入了常驻数。这和 collation.md:101「用户自己设过档位的，原值保留不覆盖」的口径不一致（2.3）。
- 建议：只删 `inUser[n] === OVERRIDE_VALUE` 的条目；值已被改掉的，归入 `preexisting_overrides` 保留原值，并在 dry-run 和结果里单独列出。restore（:853）也有同样的问题（这是既有行为），可以一起修。

### M4 [P1] 归集之前 scan 也显示「不归集 N（上限 15）」，和 B 节「判据不是数量」冲突
- 位置：`skill-scene/scripts/scene-tool.ts:435-436, 477`；`skill-scene/SKILL.md:80, 84-88`
- 问题：没有状态文件时 `sceneMembersOf(undefined)` 是空集，所有仍在注入的 skill 都算成「不归集」。实测在从没归集过的目录上，scan 输出 `其中不归集 : 26（上限 15）`。SKILL.md B 节要 Agent 先跑 scan 再开口，而 B 节的判据是「不是 skill 的数量」。Agent 看到「超上限」很容易把数量当成提议归集的理由，也可能直接把「26 > 15」报给用户。此外，还没做过归类判断时就叫「不归集」，语义也不对。脚本注释 :501-502 自己也说「常驻上限约束的是归集之后留下的部分」，但这一行输出并没有按这个口径显示。
- 建议：scan 只在状态文件存在时输出这一行（JSON 里 `residue` 在未归集时给 `null`）。同时在 SKILL.md B 节补一句，说明已归集环境里 scan / verify 报出常驻超限时怎么处理（见 M5），把它和「是否发起首次归集」的判据分开。

### M5 [P1] 上限的事后把关依赖 verify，但 SKILL.md 没说什么时候跑 verify；verify 报错信息在已有 waiver 时会误导
- 位置：`skill-scene/SKILL.md` 全文（只有 :35 顺带提到 verify）；`collation.md:149-153`；`scene-tool.ts:389-399, 952-957`
- 问题：
  - 用户的设计是「之后新增的超限由 verify 报出」，但 SKILL.md 主干从没让 Agent 跑 verify，collation.md 里 verify 只出现在「故障处置」。于是事后把关只有在碰巧排查故障时才会生效（2.12 隐式依赖）。
  - verify 复用 `residueGuidance`，把 22 个名字全部列出来，没有标出哪些已被豁免、哪些是新增的。结尾还是「决定常驻则在方案里写 residue_waiver」，可是方案里已经有 waiver 了，Agent 不知道该改什么，也不知道要重新 apply。结果就是 M2 那条路径：原样 apply 就通过了（2.9，错误信息不足以让 Agent 自己改对）。
- 建议：
  - SKILL.md（A 节开头或 B 节）加一句触发条件：在已归集的环境里，用户说装了新 skill、或者 scan 显示常驻超上限时，跑 `verify`，按 scene-authoring〈常驻上限〉处置。
  - verify 的报错把「未豁免的新增常驻」单独列出来，并写明处置：把它们归进场景或写进 `unassigned`，再请用户决定，重新 apply。配合 M2 方案 1，还要写明「把用户同意常驻的名字加进 `residue_waiver.skills`」。

---

## 可选（建议考虑）

### O1 [P1] 同一套三步处置写了四遍，事实归属散乱（2.5 / 2.18）
- 位置：`SKILL.md:105`（完整复述三步）、`collation.md:27`（再次复述顺序）、`scene-authoring.md:43-49`（真正的家）、`collation.md:54` 与 `scene-authoring.md:47`（「apply 会拒绝」两处都写了）、`collation.md:153` 与 `scene-authoring.md:49`（「verify 会重新报」两处都写了）
- 问题：判断流程的家应该在 scene-authoring〈常驻上限〉，脚本行为的家应该在 collation（归属表 SKILL.md:21 规定「脚本用法」住 collation）。现在两边互相越界，SKILL.md 又整段复述了一遍。以后改一处，其余几处就会写岔。
- 建议：
  - SKILL.md:105 缩成一句关键事实加指针，例如：「常驻（不归集且仍注入）最多 15 个；超出时先设法归集，归不进的交用户决定，见 scene-authoring〈常驻上限〉。」并挪进骨架第 2、3 步（见 O3）。
  - collation.md:27 只保留「上限与处置见 scene-authoring〈常驻上限〉」这个指针。
  - scene-authoring 只写定义、「预算而非判据」和三步决策，:47 与 :49 里描述 apply / verify 行为的半句改成指向 collation 第 4 步和〈装了新 skill〉。
  - 数字 15 可以只在 SKILL.md（关键事实）和 scene-authoring（家）里出现，collation 的 :37、:52、:153 改说「常驻上限」，免得以后改上限时漏改。

### O2 [P2] 「不归集」一词身兼两义，术语漂移（2.16）
- 位置：`SKILL.md:105`「不归集的最多留 15 个」；`scene-authoring.md:27-33`（§三「不归集」= `unassigned`，「完全不动它」）；`collation.md:102`（「声明不归集」= untouched）；脚本输出「不归集且仍在注入」
- 问题：原文里「不归集」指的是写进 `unassigned` 的那批。新规则的计数口径却是：`unassigned` 与 `--allow-unplanned` 放过的，减去用户设了 off 或自带字段的。Agent 读到「不归集的最多 15 个」，很可能直接数 `unassigned` 的条目：多算进 off 的，漏掉 unplanned 的。
- 建议：新概念统一叫「常驻」或「常驻名单」，与状态字段 `residue` 对应，首次出现时给定义（scene-authoring:39 已经有定义）。SKILL.md:105 的小标题改成「常驻（不归集且仍注入）最多 15 个」，「不归集」只用来指 `unassigned`。

### O3 [P2] SKILL.md 新段落游离在四步骨架之外（2.16 / 2.17）
- 位置：`SKILL.md:98-105`
- 问题：上限这条约束作用于第 2 步（产出方案）和第 3 步（用户确认），但它被放在编号列表之后，成了一段独立粗体段落，打断了「骨架四步」的结构，Agent 也不容易把它对应到具体哪一步。
- 建议：把这句关键事实并进第 2 步或第 3 步的文字（例如第 3 步写成「…逐项确认，含常驻名单；超上限的交用户决定」），删掉这段独立段落。归属表 :20 那一行可以相应改为「场景怎么划、常驻上限的处置、scene SKILL.md 怎么写」。

### O4 [P2] 计数口径漏说了哪些不算
- 位置：`scene-authoring.md:39`
- 问题：计数时排除了 skill-scene 自身、`synced/` 和各 `scene-*` 入口（`RESERVED` 与 `isScene`），插件 skill 也不在 skills 目录里。但文档只列了「off / user-invocable-only / 自带字段不计入」。Agent 手工数时会把 skill-scene 自己算进去，和脚本对不上。
- 建议：补半句「skill-scene 自身、`scene-*` 入口与插件提供的 skill 不计入」；并在 collation 第 3 步写明以 `apply --dry-run` 输出的常驻数为准，不要手数。

### O5 [P2] dry-run 超限时直接抛错，看不到其余预览
- 位置：`scene-tool.ts:677-679`（在 dry-run 分支之前 throw）；`collation.md:40-44, 54`
- 问题：collation 第 3 步正是「先 dry-run 给用户看规模」和「请用户决定常驻」的地方。超限时 dry-run 只输出名单，看不到这一轮会删掉哪些 stale 档位和旧场景目录，Agent 没法一次把完整写入面给用户看。
- 建议：dry-run 模式下先把完整预览打印出来，最后输出超限指引并以非零退出；真正 apply 时再在写入之前拒绝。另外，带 waiver 时 `residueSummary`（:793-796）只报数量，建议同时列出名单，并标出相对上一轮新增的名字，方便用户核对。

### O6 [P2] 错误信息可以更利于 Agent 自己改正
- 位置：`scene-tool.ts:389-399`
- 建议：按来源给常驻名单分组（`unassigned` / `--allow-unplanned` 放过的 / 上一轮 stale 回落的），末尾加上指针「处置见 references/scene-authoring.md〈常驻上限〉」，和 `cmdRestore` 报错里指向 collation 的写法保持一致。

### O7 [P2] 小口径问题
- `collation.md:153`「按〈常驻上限〉的顺序处置」少了文件名，而〈常驻上限〉在 scene-authoring.md 里，跨文件指针应写成 `[scene-authoring.md](scene-authoring.md)〈常驻上限〉`（2.18「指针要能直接跳到」）。
- `collation.md:60` 汇报清单没有提到本次新增的输出（常驻数与 waiver、删掉的 stale 档位、删掉的旧场景目录），建议补上。其中「索引」是既有的过时说法（索引已不再生成），可以一并删掉。
- `scene-authoring.md:9` 写着「不要用 skill 数量当判据」，新规则与它的关系在 :41 已经交代清楚。可以在 :9 后补一个括号指针「常驻上限是注入预算，不是划分判据，见下文〈常驻上限〉」，免得 Agent 先读到 §一 时产生疑问。
- `scene-authoring.md` 全文原本只用 `##` 一级小节，这是第一处 `###`。可以接受；如果要保持一致，可以改成 §三 末尾的粗体小段。
- 2.8 案例：新的三步处置流程没有案例。可以在 SKILL.md 案例区或 scene-authoring 里补一个 3-4 行的案例，例如：归集后常驻 19 个，把 3 个归进已有场景、为 2 个新开一个场景，剩下 14 个，不需要 waiver；或者剩 17 个，用户决定常驻，写入 waiver。

### O8 README 对等性：通过
- `README.md:39` 与 `README.zh-CN.md:39` 的语义逐句对应：上限 15、先归集、交用户决定（新的归集方式 / 常驻）、写 `residue_waiver` 记下理由、否则 apply 拒绝。两份都没有写 verify 的事后把关和两处修复，口径一致；这些属于使用细节，不放进 README 是合理的。唯一可以考虑的是 Usage 里 `verify` 的注释（:59），现在它也检查常驻上限，可以改成 "check consistency and the resident cap" 和「校验一致性与常驻上限」。

---

## 已核对且无问题的点
- 上限与「不要用数量当判据」的关系：`scene-authoring.md:41` 已经明确「是注入预算，不是归类判据，不能为了压数字硬塞」，处置第 1 步也沿用了 §一 的互斥进入条件判据，口径一致。问题只出在 scan 的展示时机（M4）。
- stale 场景目录删除只针对 `prior.scenes`，实测用户自建的 `scene-mine` 保留了下来；settings 里的其他键（`other`）也原样保留。
- `residue_waiver` 为空白串时，报错信息清楚、可以据以改正。
- 旧状态文件（没有 `residue` 字段）下，verify 与 scan 都能正常运行（在 `~/.claude/skills` 只读实测）。
- SKILL.md 共 125 行，references 体积都在阈值内；frontmatter 没有改动。

Status: DONE_WITH_CONCERNS
Summary: 三项意图都已落实，实测也生效；但模板占位串（M1）和 apply 端 waiver 不绑定名单（M2）都能让超限豁免绕过用户决定，另外 stale 删除会抹掉用户后改的档位（M3），scan 在归集前就显示超限（M4）。
Concerns/Blockers: M2 的推荐改法要改 `residue_waiver` 的 schema（字符串改成 {reason, skills}），这会改变用户先前的设计决定，需要用户拍板。
