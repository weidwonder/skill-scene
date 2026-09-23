#!/usr/bin/env node
/**
 * 按场景归集 skill：盘点、执行、校验、还原。
 *
 * 只用 Node 内置模块，靠原生类型剥离直接运行，无需编译或安装依赖。
 * 所有写操作都记录进状态文件，还原以该文件为准。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";

/** settings.json 的 per-skill 清单开关，取值 on / name-only / user-invocable-only / off。 */
const SETTINGS_KEY = "skillOverrides";

/** 本机制用的档位：清单里只留名字、去掉 description，Skill 工具调用照常。 */
const OVERRIDE_VALUE = "name-only";

/** 旧机制打在 frontmatter 上的字段。它连模型调用一起禁掉，且会锁死 settings 的
 *  on/name-only 两档，已不再使用；只在迁移与冲突识别时出现。 */
const FIELD = "disable-model-invocation";

const SETTINGS_FILENAME = "settings.json";
const LOCAL_SETTINGS_FILENAME = "settings.local.json";
const STATE_FILENAME = ".skill-scene-state.json";
/** 旧版本生成过的反查索引。name-only 之后反查改用 grep，不再生成；
 *  这里保留文件名只为清理上一轮留下的那份。 */
const LEGACY_INDEX_FILENAME = "SCENE-INDEX.md";
const SELF_NAME = "skill-scene";
const SCENE_PREFIX = "scene-";
const STATE_VERSION = 3;

/** 常驻（不在任何场景里、仍带 description 进启动清单）的 skill 上限。这是用户定下的
 *  注入预算，不是归类判据：超出时先设法归集，归不进去再交给用户决定，用户同意常驻的
 *  逐个写进方案的 residue_waiver.skills。 */
const RESIDUE_CAP = 15;

/** 这些目录不是普通 skill，归集时一律跳过。
 *  synced 由 claude.ai 同步机制管理，带自己的 manifest，改动会被覆盖。 */
const RESERVED = new Set([SELF_NAME, "synced"]);

type SceneSpec = {
  slug: string;
  title: string;
  description: string;
  skills: string[];
};

type UnassignedSpec = { name: string; reason?: string } | string;

type Plan = {
  scenes: SceneSpec[];
  unassigned?: UnassignedSpec[];
  /** 常驻数超过 RESIDUE_CAP 时，用户同意照常常驻的 skill 与理由。
   *  只豁免点了名的这些，之后新增的常驻必须重新问用户。 */
  residue_waiver?: ResidueWaiver;
};

type ResidueWaiver = { reason: string; skills: string[] };

/** 用户自己设过的 override：保留原值，记录来源文件。 */
type PriorOverride = { name: string; value: string; source: string };

type State = {
  version: number;
  applied_at: string;
  skills_root: string;
  /** 写入 override 的 settings 文件。restore 从这里删。 */
  settings_path: string;
  override_value: string;
  scenes: string[];
  /** 本工具写进 skillOverrides 的条目，restore 时逐个删掉。 */
  overridden: string[];
  /** frontmatter 自带 FIELD 的：模型调用被它禁掉，只在场景清单里露面，
   *  settings 与文件都不动。 */
  self_disabled: string[];
  /** 用户自己设过 override 的：原值保留，本工具不覆盖。 */
  preexisting_overrides: PriorOverride[];
  /** 显式声明不归集的：完全不碰，照常参与自动路由。 */
  untouched: string[];
  /** 迁移时从 frontmatter 摘掉的旧打标。 */
  unmarked_legacy: string[];
  /** 旧版本写过的索引路径，只在清理时读。 */
  index?: string;
  /** 完整方案随状态一起存档：归类决策是唯一的人工输入，
   *  外部那份 scenes.json 丢了也不必重做。 */
  plan: Plan;
};

/** v1 的 marked 是 {name, had_field} 数组，v2 是字符串数组。迁移与还原都要认得。 */
type LegacyMark = { name: string; had_field: boolean };

/** 从两代 marked 结构里取出本工具打过标的名字。
 *  v2 全部由本工具所打；v1 里 had_field 为真的是 skill 自带的，不算。 */
function legacyMarkedByTool(marked: (string | LegacyMark)[]): string[] {
  return marked
    .filter((m) => typeof m === "string" || !m.had_field)
    .map((m) => (typeof m === "string" ? m : m.name));
}

/** 带可操作信息的失败。错误文本要让调用者据以自改，不要只说失败。 */
class ToolError extends Error {}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** 定位 skills 根目录。显式参数 > 环境变量 > 默认位置。 */
function resolveSkillsRoot(arg?: string): string {
  let root: string;
  if (arg) {
    root = expandHome(arg);
  } else if (process.env.CLAUDE_CONFIG_DIR) {
    root = path.join(expandHome(process.env.CLAUDE_CONFIG_DIR), "skills");
  } else {
    root = path.join(os.homedir(), ".claude", "skills");
  }

  if (!isDir(root)) {
    throw new ToolError(
      `skills 根目录不存在: ${root}\n` +
        `用 --skills-root 指定实际位置，或设置 CLAUDE_CONFIG_DIR 环境变量。`,
    );
  }
  return fs.realpathSync(root);
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 配置目录是 skills 根目录的父目录，settings 与状态文件都在这里。 */
function configDir(skillsRoot: string): string {
  return path.dirname(skillsRoot);
}

/** 状态文件与 settings 同级，这样删掉本 skill 也不会丢失还原依据。 */
function statePath(skillsRoot: string): string {
  return path.join(configDir(skillsRoot), STATE_FILENAME);
}

/** 旧状态文件记着索引路径时给出它的绝对位置，用于清理。没有则返回 null。 */
function legacyIndexPath(skillsRoot: string, state: State | null): string | null {
  if (!state) return null;
  return path.join(skillsRoot, state.index ?? path.join(SELF_NAME, LEGACY_INDEX_FILENAME));
}

function settingsPath(skillsRoot: string): string {
  return path.join(configDir(skillsRoot), SETTINGS_FILENAME);
}

function localSettingsPath(skillsRoot: string): string {
  return path.join(configDir(skillsRoot), LOCAL_SETTINGS_FILENAME);
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function readSettings(file: string): Record<string, unknown> {
  if (!isFile(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层不是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ToolError(
      `settings 文件无法解析: ${file}\n  ${(err as Error).message}\n` +
        `先修好这个文件再执行，本工具不会覆盖无法解析的配置。`,
    );
  }
}

function readOverrides(file: string): Record<string, string> {
  const raw = readSettings(file)[SETTINGS_KEY];
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolError(
      `${file} 里的 ${SETTINGS_KEY} 不是对象。它应当是「skill 名 -> 档位」的映射，` +
        `档位取 on / ${OVERRIDE_VALUE} / user-invocable-only / off。`,
    );
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new ToolError(`${file} 里 ${SETTINGS_KEY}.${name} 的值不是字符串: ${String(value)}`);
    }
    out[name] = value;
  }
  return out;
}

/** 合并后的生效档位。settings.local.json 优先级高于 settings.json，
 *  所以本地有条目时，写进 settings.json 的值不会生效。 */
function effectiveOverrides(skillsRoot: string): Record<string, string> {
  return {
    ...readOverrides(settingsPath(skillsRoot)),
    ...readOverrides(localSettingsPath(skillsRoot)),
  };
}

/** 把条目写进 settings.json 的 skillOverrides，其余配置原样保留。 */
function writeOverrides(file: string, entries: Map<string, string>): void {
  const settings = readSettings(file);
  const current = readOverrides(file);
  for (const [name, value] of entries) current[name] = value;
  settings[SETTINGS_KEY] = sortedRecord(current);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** 从 settings.json 删掉指定条目。删空后连 skillOverrides 键一起移除。 */
function dropOverrides(file: string, names: string[]): number {
  if (!isFile(file)) return 0;
  const settings = readSettings(file);
  const current = readOverrides(file);
  let dropped = 0;
  for (const name of names) {
    if (name in current) {
      delete current[name];
      dropped++;
    }
  }
  if (Object.keys(current).length === 0) delete settings[SETTINGS_KEY];
  else settings[SETTINGS_KEY] = sortedRecord(current);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return dropped;
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

/** 返回 frontmatter 行与正文起始行号。没有合法 frontmatter 时 lines 为 null。 */
function splitFrontmatter(text: string): { lines: string[] | null; bodyStart: number } {
  const all = text.split("\n");
  if (all.length === 0 || all[0].trim() !== "---") return { lines: null, bodyStart: 0 };
  for (let i = 1; i < all.length; i++) {
    if (all[i].trim() === "---") return { lines: all.slice(1, i), bodyStart: i + 1 };
  }
  return { lines: null, bodyStart: 0 };
}

/** 字段所在行号（相对 frontmatter），不存在返回 -1。 */
function fieldLineIndex(fm: string[]): number {
  return fm.findIndex((line) => line.trim().startsWith(FIELD + ":"));
}

/** 读一个顶格标量字段，支持折叠块（>- 与 |）。读不到返回空串。 */
function readScalar(fm: string[], key: string): string {
  for (let i = 0; i < fm.length; i++) {
    if (!fm[i].startsWith(key + ":")) continue;
    const raw = fm[i].slice(key.length + 1).trim();
    if (raw && ![">", ">-", "|", "|-"].includes(raw)) {
      return raw.replace(/^["']|["']$/g, "");
    }
    const collected: string[] = [];
    for (const cont of fm.slice(i + 1)) {
      if (cont.trim() && !/^[ \t]/.test(cont)) break;
      collected.push(cont.trim());
    }
    return collected.filter(Boolean).join(" ");
  }
  return "";
}

/** 删除字段所在行。不存在则原样返回。 */
function dropField(text: string): string {
  const { lines: fm } = splitFrontmatter(text);
  if (fm === null) return text;
  const idx = fieldLineIndex(fm);
  if (idx === -1) return text;

  const all = text.split("\n");
  all.splice(idx + 1, 1); // +1 跳过开头的 ---
  return all.join("\n");
}

// ---------------------------------------------------------------------------
// 盘点
// ---------------------------------------------------------------------------

class Skill {
  readonly name: string;
  readonly dir: string;
  readonly md: string;
  readonly isScene: boolean;
  #text: string | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.name = path.basename(dir);
    this.md = path.join(dir, "SKILL.md");
    this.isScene = this.name.startsWith(SCENE_PREFIX);
  }

  get text(): string {
    if (this.#text === null) this.#text = fs.readFileSync(this.md, "utf8");
    return this.#text;
  }

  /** frontmatter 里带 FIELD：模型调用被禁，且 settings 的 name-only 档被锁死。 */
  get hasField(): boolean {
    const { lines } = splitFrontmatter(this.text);
    return lines !== null && fieldLineIndex(lines) !== -1;
  }

  get description(): string {
    const { lines } = splitFrontmatter(this.text);
    return lines ? readScalar(lines, "description") : "";
  }

  /** frontmatter 里声明的 name，斜杠调用用的是它（可能与目录名不同）。 */
  get declaredName(): string {
    const { lines } = splitFrontmatter(this.text);
    return (lines ? readScalar(lines, "name") : "") || this.name;
  }

  write(text: string): void {
    fs.writeFileSync(this.md, text, "utf8");
    this.#text = text;
  }
}

/** 列出 skills 根目录下所有带 SKILL.md 的一级条目。 */
function collect(skillsRoot: string): Skill[] {
  return fs
    .readdirSync(skillsRoot)
    .sort()
    .filter((name) => !name.startsWith(".") && !RESERVED.has(name))
    .map((name) => path.join(skillsRoot, name))
    .filter((dir) => isDir(dir) && isFile(path.join(dir, "SKILL.md")))
    .map((dir) => new Skill(dir));
}

/** 粗估 token 数。英文约 4 字符/token，中文约 1.5，取 3 作为混排估计。 */
function approxTokens(chars: number): number {
  return Math.round(chars / 3);
}

/** description 是否还在启动清单里。两条退出路径都算：
 *  settings 里有非 on 的档位，或 frontmatter 自带 FIELD。 */
function isQuiet(skill: Skill, overrides: Record<string, string>): boolean {
  const value = overrides[skill.name];
  return (value !== undefined && value !== "on") || skill.hasField;
}

/** 常驻：不在任何场景里、description 仍在启动清单里的 skill。
 *  设了 off/user-invocable-only 或自带 FIELD 的不注入，不计入；本 skill 与 synced
 *  不在 collect 的结果里，场景入口由 isScene 排除，插件 skill 本就不在 skills 目录下。 */
function residueOf(
  skills: Skill[],
  overrides: Record<string, string>,
  sceneMembers: Set<string>,
): string[] {
  return skills
    .filter((s) => !s.isScene && !sceneMembers.has(s.name) && !isQuiet(s, overrides))
    .map((s) => s.name)
    .sort();
}

function sceneMembersOf(plan: Plan | undefined): Set<string> {
  return new Set((plan?.scenes ?? []).flatMap((s) => s.skills));
}

/** 常驻超限、且有未经用户同意的常驻时返回它们；不需要处置时返回空数组。 */
function unwaivedResidue(residue: string[], waiver: ResidueWaiver | undefined): string[] {
  if (residue.length <= RESIDUE_CAP) return [];
  const waived = new Set(waiver?.skills ?? []);
  return residue.filter((n) => !waived.has(n));
}

/** 常驻超限时给 Agent 的处置指引。source 标出每个名字为什么常驻，便于逐个判断。 */
function residueGuidance(
  residue: string[],
  unwaived: string[],
  source: (name: string) => string,
): string {
  const waived = residue.filter((n) => !unwaived.includes(n));
  return (
    `常驻（不在任何场景里、仍带 description 注入）的 skill 有 ${residue.length} 个，` +
    `超过上限 ${RESIDUE_CAP}。其中未经用户同意常驻的 ${unwaived.length} 个:\n  ` +
    unwaived.map((n) => `${n}（${source(n)}）`).join("\n  ") +
    (waived.length ? `\n已由 residue_waiver 同意常驻的 ${waived.length} 个: ${waived.join(", ")}` : "") +
    "\n处置（见 references/scene-authoring.md〈常驻上限〉）：先设法把上面这些归进已有场景，" +
    "或为其中服务同一类任务的几个新开一个有独立进入条件的场景；仍归不进去的交给用户决定——" +
    "给出新的归集方式，或同意它们常驻。用户同意的，把名字加进方案的 residue_waiver.skills" +
    "（reason 写用户的理由），然后重新 apply。不要在用户同意之前自己加。"
  );
}

/** 场景正文里照搬 skill 的完整 description。
 *
 *  场景正文不进启动上下文，进入场景后才加载，所以这里省字数省不到任何地方，
 *  反而会让「该调哪个 skill」失去判断依据。只压平换行，不截断。 */
function fullDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

/** 本 skill 自己不参与归集，但它的 description 照常注入，统计时不能漏。 */
function selfInjection(
  skillsRoot: string,
  overrides: Record<string, string>,
): { count: number; chars: number } {
  const dir = path.join(skillsRoot, SELF_NAME);
  if (!isFile(path.join(dir, "SKILL.md"))) return { count: 0, chars: 0 };
  const self = new Skill(dir);
  if (isQuiet(self, overrides)) return { count: 0, chars: 0 };
  return { count: 1, chars: SELF_NAME.length + self.description.length };
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

function cmdScan(root: string, asJson: boolean): number {
  const overrides = effectiveOverrides(root);
  const skills = collect(root);
  const scenes = skills.filter((s) => s.isScene);
  const plain = skills.filter((s) => !s.isScene);
  const quiet = plain.filter((s) => isQuiet(s, overrides));
  const loud = plain.filter((s) => !isQuiet(s, overrides));
  const legacy = plain.filter((s) => s.hasField);

  const self = selfInjection(root, overrides);
  // 常驻上限约束的是归集之后留下的部分。还没归集过时不算常驻，也不报上限，
  // 免得把数量误当成「该发起归集」的理由。
  const state = loadState(root);
  const residue = state ? residueOf(skills, overrides, sceneMembersOf(state.plan)) : null;
  const injected = [...scenes, ...loud];
  const injectedCount = injected.length + self.count;
  const chars =
    injected.reduce((sum, s) => sum + s.name.length + s.description.length, 0) + self.chars;

  // name-only 的 skill 在清单里只留一行名字，这份开销省不掉，要单独报出来。
  const nameOnly = plain.filter((s) => overrides[s.name] === OVERRIDE_VALUE);
  const nameOnlyChars = nameOnly.reduce((sum, s) => sum + s.name.length + 3, 0);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          skills_root: root,
          settings: settingsPath(root),
          scenes: scenes.map((s) => s.name),
          quiet: quiet.map((s) => s.name),
          loud: loud.map((s) => s.name),
          frontmatter_field: legacy.map((s) => s.name),
          injected_count: injectedCount,
          injected_chars: chars,
          injected_tokens_approx: approxTokens(chars),
          name_only_count: nameOnly.length,
          name_only_chars: nameOnlyChars,
          name_only_tokens_approx: approxTokens(nameOnlyChars),
          residue,
          residue_cap: RESIDUE_CAP,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`skills 根目录: ${root}`);
  console.log(`settings     : ${settingsPath(root)}`);
  console.log(`  场景入口     : ${scenes.length}`);
  console.log(`  已退出注入   : ${quiet.length}`);
  console.log(`  仍在注入     : ${loud.length}`);
  if (residue) console.log(`  其中常驻     : ${residue.length}（上限 ${RESIDUE_CAP}）`);
  console.log();
  console.log(
    `当前启动注入 ${injectedCount} 份 description，约 ${chars} 字符 / ${approxTokens(chars)} tokens`,
  );
  if (nameOnly.length) {
    console.log(
      `其中 ${nameOnly.length} 个 ${OVERRIDE_VALUE} 的 skill 只留名字，` +
        `合计约 ${nameOnlyChars} 字符 / ${approxTokens(nameOnlyChars)} tokens`,
    );
  }

  if (legacy.length) {
    console.log();
    console.log(
      `注意：${legacy.length} 个 skill 的 frontmatter 带 ${FIELD}，模型无法用 Skill 工具调用它们。`,
    );
    console.log(
      `旧版本机制打的标属于这种情况，apply 会摘掉；skill 自带的会保留，只列进场景清单。`,
    );
    for (const s of legacy.slice(0, 10)) console.log(`  ${s.name}`);
    if (legacy.length > 10) console.log(`  … 另有 ${legacy.length - 10} 个`);
  }

  if (residue && residue.length > RESIDUE_CAP) {
    console.log();
    console.log(`常驻超过上限 ${RESIDUE_CAP}，运行 verify 查看哪些未经用户同意、以及怎么处置。`);
  }

  // 该不该发起归集取决于这份清单是否已经在妨碍路由，不取决于数量，所以这里只报事实。
  return 0;
}

function loadPlan(planPath: string): Plan {
  const file = expandHome(planPath);
  if (!isFile(file)) throw new ToolError(`方案文件不存在: ${file}`);

  let plan: Plan;
  try {
    plan = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ToolError(`方案文件不是合法 JSON: ${file}\n  ${(err as Error).message}`);
  }

  if (!Array.isArray(plan.scenes) || plan.scenes.length === 0) {
    throw new ToolError("方案缺少非空的 scenes 数组");
  }

  const slugs = new Set<string>();
  const owner = new Map<string, string>();
  for (const scene of plan.scenes) {
    for (const key of ["slug", "title", "description", "skills"] as const) {
      if (!scene[key] || (key === "skills" && scene.skills.length === 0)) {
        throw new ToolError(
          `场景缺少字段 ${key}: ${JSON.stringify(scene).slice(0, 120)}`,
        );
      }
    }
    if (slugs.has(scene.slug)) throw new ToolError(`场景 slug 重复: ${scene.slug}`);
    slugs.add(scene.slug);

    for (const name of scene.skills) {
      const prev = owner.get(name);
      if (prev) {
        throw new ToolError(
          `skill ${name} 同时出现在 ${SCENE_PREFIX}${prev} 和 ${SCENE_PREFIX}${scene.slug}。` +
            `一个 skill 只能有一个主场景，跨场景引用直接按名字调用，不靠重复登记。`,
        );
      }
      owner.set(name, scene.slug);
    }
  }

  const w = plan.residue_waiver as unknown;
  if (w !== undefined) {
    const ok =
      w !== null &&
      typeof w === "object" &&
      typeof (w as ResidueWaiver).reason === "string" &&
      (w as ResidueWaiver).reason.trim() !== "" &&
      Array.isArray((w as ResidueWaiver).skills) &&
      (w as ResidueWaiver).skills.length > 0 &&
      (w as ResidueWaiver).skills.every((n) => typeof n === "string" && n);
    if (!ok) {
      throw new ToolError(
        'residue_waiver 格式应为 {"reason": "<用户的理由>", "skills": ["<用户同意常驻的 skill>", …]}，' +
          "reason 与 skills 都不能为空。它只在用户明确同意某些 skill 常驻后才写。",
      );
    }
  }
  return plan;
}

function unassignedName(item: UnassignedSpec): string {
  return typeof item === "string" ? item : item.name;
}

/** 读旧状态。版本不认识就停下，不在状态不明时重复 apply。 */
function loadState(root: string): State | null {
  const sp = statePath(root);
  if (!isFile(sp)) return null;
  let state: State;
  try {
    state = JSON.parse(fs.readFileSync(sp, "utf8"));
  } catch (err) {
    throw new ToolError(
      `状态文件无法解析: ${sp}\n  ${(err as Error).message}\n` +
        `修好它或先 restore，不要在状态不明时重复 apply。`,
    );
  }
  if (state.version > STATE_VERSION) {
    throw new ToolError(
      `状态文件版本 ${state.version} 比本工具（${STATE_VERSION}）新，先升级 scene-tool.ts`,
    );
  }
  return state;
}

type ApplyOptions = {
  plan: string;
  dryRun: boolean;
  allowUnplanned: boolean;
};

function cmdApply(root: string, opts: ApplyOptions): number {
  const plan = loadPlan(opts.plan);
  const byName = new Map(collect(root).filter((s) => !s.isScene).map((s) => [s.name, s]));

  const planned = plan.scenes.flatMap((s) => s.skills);
  const missing = planned.filter((n) => !byName.has(n));
  if (missing.length) {
    throw new ToolError(
      "方案里这些 skill 在 skills 目录下不存在:\n  " +
        missing.join("\n  ") +
        "\n用目录名而不是 frontmatter 的 name（两者可能不同）。",
    );
  }

  // unassigned 是「看过、决定不归集」的显式记录：一个字都不改，照常参与自动路由。
  // 藏起一个没有场景能带出它的 skill，等于废掉它。
  const untouched = (plan.unassigned ?? []).map(unassignedName).filter((n) => byName.has(n));
  const declared = new Set([...planned, ...untouched]);

  const unplanned = [...byName.keys()].filter((n) => !declared.has(n)).sort();
  if (unplanned.length && !opts.allowUnplanned) {
    throw new ToolError(
      `这 ${unplanned.length} 个 skill 既不在任何场景里，也不在 unassigned 清单里:\n  ` +
        unplanned.join("\n  ") +
        "\n把它们归入场景或写进 unassigned（附 reason）；" +
        "确认要让它们保持现状则加 --allow-unplanned。",
    );
  }

  const prior = loadState(root);
  // 上一轮由本工具写进 settings 的条目。再次 apply 时它们是自己的手笔，不是用户的选择。
  const priorOverridden = new Set(prior?.overridden ?? []);
  // v1/v2 打在 frontmatter 上的标：迁移时要摘掉，否则模型仍然调不动。
  const priorMarked = new Set(legacyMarkedByTool((prior as unknown as { marked?: (string | LegacyMark)[] })?.marked ?? []));

  const userSettings = settingsPath(root);
  const localSettings = localSettingsPath(root);
  const inUser = readOverrides(userSettings);
  const inLocal = readOverrides(localSettings);

  const targets: string[] = [];
  const selfDisabled: string[] = [];
  const preexisting: PriorOverride[] = [];
  const toUnmark: string[] = [];

  for (const name of planned) {
    const skill = byName.get(name)!;

    if (skill.hasField) {
      if (priorMarked.has(name)) {
        // 旧机制打的标。摘掉它，改用 settings 的档位，模型才能重新调用。
        toUnmark.push(name);
      } else {
        // skill 自带该字段，那是它自身调用契约的要求。文件与 settings 都不动，
        // 只把它列进场景清单，并在清单里注明只能由用户手工调用。
        selfDisabled.push(name);
        continue;
      }
    }

    // 用户自己设过档位的（含 off、user-invocable-only），保留用户的选择不覆盖。
    // settings.local.json 本工具从不写，里面的条目都是用户的；它优先级更高，
    // 写进 settings.json 的值反正也会被它盖掉。
    if (name in inLocal) {
      preexisting.push({ name, value: inLocal[name], source: LOCAL_SETTINGS_FILENAME });
      continue;
    }
    // settings.json 里不是 name-only 的值不是本工具写的——包括上一轮本工具写过、
    // 之后被用户改掉的，那也是用户的选择。
    if (name in inUser && inUser[name] !== OVERRIDE_VALUE) {
      preexisting.push({ name, value: inUser[name], source: SETTINGS_FILENAME });
      continue;
    }

    targets.push(name);
  }

  // 上一轮由本工具设了档位、这一轮不再归进场景的：没有场景能带出它，必须摘掉档位、
  // 让 description 回到启动清单，否则它等于被废掉，restore 也再找不到这条记录。
  // 只删值仍是 name-only 的：被用户改成别的值的，是用户的选择，原样保留。
  const targetSet = new Set(targets);
  const stale = [...priorOverridden]
    .filter((n) => !targetSet.has(n) && inUser[n] === OVERRIDE_VALUE)
    .sort();

  // 声明不归集的与未在方案里的都照常常驻，一起计入上限。按本次写入之后的档位计算。
  const userAfter = { ...inUser };
  for (const name of stale) delete userAfter[name];
  for (const name of targets) userAfter[name] = OVERRIDE_VALUE;
  const residue = residueOf([...byName.values()], { ...userAfter, ...inLocal }, new Set(planned));
  const unwaived = unwaivedResidue(residue, plan.residue_waiver);
  const untouchedSet = new Set(untouched);
  const guidance = unwaived.length
    ? residueGuidance(residue, unwaived, (n) =>
        untouchedSet.has(n) ? "写在 unassigned" : "未在方案中，--allow-unplanned 放过",
      )
    : "";
  // 真正执行时在任何写操作之前拒绝；dry-run 先把完整预览打出来再报，
  // 这样给用户看的写入面是全的。
  if (guidance && !opts.dryRun) throw new ToolError(guidance);

  // 上一轮建过、这一轮方案里已没有的场景入口。只删状态文件记录在案的，
  // 用户自己建的 scene-* 目录不归本工具管。新状态不再记录它们，现在不删就永远删不掉了。
  const planDirs = new Set(plan.scenes.map((s) => SCENE_PREFIX + s.slug));
  const staleScenes = (prior?.scenes ?? [])
    .filter((d) => !planDirs.has(d) && isDir(path.join(root, d)))
    .sort();

  if (opts.dryRun) {
    console.log(`[dry-run] 将建立 ${plan.scenes.length} 个场景入口`);
    console.log(`[dry-run] 将写入 ${targets.length} 条 ${SETTINGS_KEY}=${OVERRIDE_VALUE} 到 ${userSettings}`);
    if (stale.length) {
      console.log(`[dry-run] 将删掉上一轮写入、这一轮已不在场景里的档位 ${stale.length} 个: ${stale.join(", ")}`);
    }
    if (staleScenes.length) {
      console.log(`[dry-run] 将删除方案里已没有的场景入口 ${staleScenes.length} 个: ${staleScenes.join(", ")}`);
    }
    if (toUnmark.length) {
      console.log(`[dry-run] 将摘掉旧机制打在 frontmatter 上的 ${FIELD} ${toUnmark.length} 个`);
    }
    if (selfDisabled.length) {
      console.log(`[dry-run] 自带 ${FIELD}、只进场景清单不改任何配置 ${selfDisabled.length} 个`);
    }
    if (preexisting.length) {
      console.log(`[dry-run] 用户已设过档位、保留原值 ${preexisting.length} 个:`);
      for (const p of preexisting) console.log(`           ${p.name} = ${p.value} (${p.source})`);
    }
    console.log(`[dry-run] 声明不归集、保持原样 ${untouched.length} 个`);
    if (unplanned.length) console.log(`[dry-run] 未在方案中、保持原样 ${unplanned.length} 个`);
    console.log(`[dry-run] ${residueSummary(residue, plan.residue_waiver)}`);
    if (guidance) {
      console.error(`\n错误: ${guidance}`);
      return 1;
    }
    return 0;
  }

  // --- 写操作从这里开始 ---
  const lockedNames = new Set(selfDisabled);

  for (const name of toUnmark) {
    const skill = byName.get(name)!;
    skill.write(dropField(skill.text));
  }

  const state: State = {
    version: STATE_VERSION,
    applied_at: new Date().toISOString(),
    skills_root: root,
    settings_path: userSettings,
    override_value: OVERRIDE_VALUE,
    scenes: [],
    overridden: [...targets].sort(),
    self_disabled: selfDisabled.sort(),
    preexisting_overrides: preexisting,
    untouched,
    unmarked_legacy: toUnmark.sort(),
    plan,
  };

  for (const scene of plan.scenes) {
    const dirName = SCENE_PREFIX + scene.slug;
    const sceneDir = path.join(root, dirName);
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(
      path.join(sceneDir, "SKILL.md"),
      renderScene(scene, byName, lockedNames),
      "utf8",
    );
    state.scenes.push(dirName);
  }

  for (const dirName of staleScenes) {
    fs.rmSync(path.join(root, dirName), { recursive: true, force: true });
  }

  if (stale.length) dropOverrides(userSettings, stale);
  writeOverrides(userSettings, new Map(state.overridden.map((n) => [n, OVERRIDE_VALUE])));

  // 上一轮可能生成过反查索引。name-only 之后反查改用 grep，顺手把旧产物清掉。
  const staleIndex = legacyIndexPath(root, prior);
  if (staleIndex && isFile(staleIndex)) {
    fs.unlinkSync(staleIndex);
    console.log(`删除旧版本的反查索引: ${staleIndex}`);
  }

  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2) + "\n", "utf8");

  console.log(`建立场景入口 ${state.scenes.length} 个`);
  console.log(`写入 ${state.overridden.length} 条 ${SETTINGS_KEY}=${OVERRIDE_VALUE}: ${userSettings}`);
  console.log("这些 skill 的 description 不再进启动清单，清单里只留名字，Skill 工具照常可调。");
  if (stale.length) {
    console.log(`删掉已移出场景的档位 ${stale.length} 个，它们的 description 回到启动清单: ${stale.join(", ")}`);
  }
  if (staleScenes.length) {
    console.log(`删除方案里已没有的场景入口 ${staleScenes.length} 个: ${staleScenes.join(", ")}`);
  }
  if (toUnmark.length) {
    console.log(`摘掉旧机制的 frontmatter ${FIELD} ${toUnmark.length} 个（它会禁掉模型调用）`);
  }
  if (selfDisabled.length) {
    console.log(
      `自带 ${FIELD}、只进场景清单 ${selfDisabled.length} 个: ${selfDisabled.join(", ")}`,
    );
  }
  if (preexisting.length) {
    console.log(`用户已设过档位、保留原值 ${preexisting.length} 个:`);
    for (const p of preexisting) console.log(`  ${p.name} = ${p.value} (${p.source})`);
  }
  console.log(`声明不归集、保持原样 ${untouched.length} 个`);
  console.log(residueSummary(residue, plan.residue_waiver));
  console.log(`状态: ${statePath(root)}`);
  console.log("改动即时生效，不必重开会话。");
  return 0;
}

function residueSummary(residue: string[], waiver: ResidueWaiver | undefined): string {
  const line = `常驻 ${residue.length} 个（上限 ${RESIDUE_CAP}）`;
  if (residue.length <= RESIDUE_CAP || !waiver) return line;
  const waived = residue.filter((n) => waiver.skills.includes(n));
  return `${line}，经用户同意常驻 ${waived.length} 个: ${waived.join(", ")}；理由: ${waiver.reason}`;
}

function renderScene(
  scene: SceneSpec,
  byName: Map<string, Skill>,
  locked: Set<string>,
): string {
  const rows = scene.skills
    .map((n) => {
      const skill = byName.get(n)!;
      const note = locked.has(n)
        ? `（frontmatter 自带 ${FIELD}，模型调不动：请用户手工 \`/${skill.declaredName}\`）`
        : "";
      return `- **${n}**${note}\n  ${fullDescription(skill.description)}`;
    })
    .join("\n");

  return `---
name: ${SCENE_PREFIX}${scene.slug}
description: "${scene.description}"
---

# ${scene.title}

## 本场景的 skill

用 Skill 工具按名字调用，和平常调用 skill 没有区别——它们只是 description 不在启动清单里，调用本身不受限制。

${rows}

按当前这一步的需要调用其中一两个，不要全部拉进来。

## 不在本场景的

需要的能力不在上面的清单里时：

- 只要那一个 skill，直接按名字用 Skill 工具调用，不必管它归在哪个场景。
- 整段工作要转到另一个领域，按各 \`scene-*\` 的 description 选那个场景进去。要反查某个 skill 归谁管，\`grep -l "<skill-name>" <skills 根目录>/scene-*/SKILL.md\`。
`;
}

function cmdRestore(root: string): number {
  const sp = statePath(root);
  const state = loadState(root);
  if (!state) {
    throw new ToolError(
      `状态文件不存在: ${sp}\n` +
        `没有它就无法区分哪些配置是本工具写的、哪些是用户自己设的，` +
        `无差别删除会一并抹掉用户的选择。\n` +
        `处置见 references/collation.md〈状态文件丢失〉。`,
    );
  }

  const byName = new Map(collect(root).map((s) => [s.name, s]));

  // v3：删 settings 里本工具写的条目。值已被用户改掉的是用户的选择，原样保留。
  const target = state.settings_path ?? settingsPath(root);
  const current = readOverrides(target);
  const ours = (state.overridden ?? []).filter((n) => current[n] === OVERRIDE_VALUE);
  const changed = (state.overridden ?? []).filter(
    (n) => n in current && current[n] !== OVERRIDE_VALUE,
  );
  const dropped = dropOverrides(target, ours);

  // v1/v2：摘掉打在 frontmatter 上的旧标。
  const legacyMarks = legacyMarkedByTool(
    (state as unknown as { marked?: (string | LegacyMark)[] }).marked ?? [],
  );
  let unmarked = 0;
  for (const name of legacyMarks) {
    const skill = byName.get(name);
    if (!skill) {
      console.log(`  跳过 ${name}：目录已不存在`);
      continue;
    }
    skill.write(dropField(skill.text));
    unmarked++;
  }

  let removed = 0;
  for (const dirName of state.scenes ?? []) {
    const sceneDir = path.join(root, dirName);
    if (isDir(sceneDir)) {
      fs.rmSync(sceneDir, { recursive: true, force: true });
      removed++;
    }
  }

  const index = legacyIndexPath(root, state);
  if (index && isFile(index)) fs.unlinkSync(index);
  fs.unlinkSync(sp);

  if (dropped) console.log(`删除 ${SETTINGS_KEY} 条目 ${dropped} 个: ${target}`);
  if (changed.length) {
    console.log(`原样保留已被用户改成别的档位的 ${changed.length} 个: ${changed.join(", ")}`);
  }
  if (unmarked) console.log(`摘除旧机制的 frontmatter ${FIELD} ${unmarked} 个`);
  if ((state.self_disabled ?? []).length) {
    console.log(`原样保留自带 ${FIELD} 的 ${state.self_disabled.length} 个`);
  }
  if ((state.preexisting_overrides ?? []).length) {
    console.log(`原样保留用户自设档位 ${state.preexisting_overrides.length} 个`);
  }
  console.log(`删除场景入口 ${removed} 个，状态文件已清除`);
  console.log("改动即时生效，不必重开会话。");
  return 0;
}

function cmdVerify(root: string): number {
  const sp = statePath(root);
  const state = loadState(root);
  if (!state) {
    console.log(`未归集（状态文件不存在: ${sp}）`);
    return 0;
  }

  const byName = new Map(collect(root).map((s) => [s.name, s]));
  const overrides = effectiveOverrides(root);
  const problems: string[] = [];

  for (const dirName of state.scenes ?? []) {
    if (!isFile(path.join(root, dirName, "SKILL.md"))) {
      problems.push(`场景入口缺失: ${dirName}/SKILL.md`);
    }
  }

  for (const name of state.overridden ?? []) {
    const skill = byName.get(name);
    if (!skill) {
      problems.push(`已记录但目录不存在: ${name}`);
      continue;
    }
    const value = overrides[name];
    if (value !== OVERRIDE_VALUE) {
      problems.push(
        `${SETTINGS_KEY} 档位不对: ${name} = ${value ?? "(缺失)"}，应为 ${OVERRIDE_VALUE}`,
      );
    }
    // kit 升级可能把这个字段带回来，它会禁掉模型调用并锁死 name-only 档。
    if (skill.hasField) {
      problems.push(`frontmatter 又出现 ${FIELD}（可能被升级带回）: ${name}`);
    }
  }

  // untouched 与 self_disabled 是「已知且刻意不动」的，不能被当成漏网的新 skill。
  const tracked = new Set<string>([
    ...(state.overridden ?? []),
    ...(state.self_disabled ?? []),
    ...(state.preexisting_overrides ?? []).map((p) => p.name),
    ...(state.untouched ?? []),
    ...(state.scenes ?? []),
  ]);
  const newcomers = [...byName.values()]
    .filter((s) => !s.isScene && !tracked.has(s.name) && !isQuiet(s, overrides))
    .map((s) => s.name)
    .sort();
  if (newcomers.length) {
    problems.push(
      `${newcomers.length} 个新 skill 未归集: ` +
        newcomers.slice(0, 10).join(", ") +
        (newcomers.length > 10 ? " …" : ""),
    );
  }

  // residue_waiver 只豁免用户点过名的那些，之后多出来的常驻仍要按上限处置。
  const residue = residueOf([...byName.values()], overrides, sceneMembersOf(state.plan));
  const unwaived = unwaivedResidue(residue, state.plan?.residue_waiver);
  if (unwaived.length) {
    const untouchedSet = new Set(state.untouched ?? []);
    const guidance = residueGuidance(residue, unwaived, (n) =>
      untouchedSet.has(n) ? "写在 unassigned" : "新装或未在方案中",
    );
    problems.push(guidance.replace(/\n/g, "\n    "));
  }

  if (problems.length === 0) {
    console.log("一致。");
    return 0;
  }
  console.log("发现问题：");
  for (const p of problems) console.log(`  - ${p}`);
  return 1;
}

// ---------------------------------------------------------------------------

const USAGE = `用法: node scene-tool.ts <命令> [选项]

命令:
  scan                盘点现状与注入体积
  apply --plan <f>    按方案执行归集
  restore             按状态文件还原
  verify              校验归集状态一致性与常驻上限

选项:
  --skills-root <d>   skills 根目录（默认 ~/.claude/skills）
  --json              scan 输出 JSON
  --dry-run           apply 只预览，不写任何文件
  --allow-unplanned   apply 允许方案未覆盖的 skill 保持现状
`;

function main(): number {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        "skills-root": { type: "string" },
        plan: { type: "string" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "allow-unplanned": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (err) {
    console.error(`错误: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  const root = resolveSkillsRoot(values["skills-root"] as string | undefined);

  switch (command) {
    case "scan":
      return cmdScan(root, Boolean(values.json));
    case "apply":
      if (!values.plan) throw new ToolError("apply 需要 --plan <scenes.json>");
      return cmdApply(root, {
        plan: values.plan as string,
        dryRun: Boolean(values["dry-run"]),
        allowUnplanned: Boolean(values["allow-unplanned"]),
      });
    case "restore":
      return cmdRestore(root);
    case "verify":
      return cmdVerify(root);
    default:
      console.error(`未知命令: ${command}\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exit(main());
} catch (err) {
  if (err instanceof ToolError) {
    console.error(`错误: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
