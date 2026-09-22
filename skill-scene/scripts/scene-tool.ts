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

const FIELD = "disable-model-invocation";
const STATE_FILENAME = ".skill-scene-state.json";
const INDEX_FILENAME = "SCENE-INDEX.md";
const SELF_NAME = "skill-scene";
const SCENE_PREFIX = "scene-";
const STATE_VERSION = 1;

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
};

type MarkRecord = { name: string; had_field: boolean };

type State = {
  version: number;
  applied_at: string;
  skills_root: string;
  scenes: string[];
  marked: MarkRecord[];
  skipped_symlinks: string[];
  index?: string;
  /** 完整方案随状态一起存档：归类决策是唯一的人工输入，
   *  外部那份 scenes.json 丢了也不必重做。 */
  plan: Plan;
};

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

/** 状态文件放在 skills 根目录的父目录，这样删掉本 skill 也不会丢失还原依据。 */
function statePath(skillsRoot: string): string {
  return path.join(path.dirname(skillsRoot), STATE_FILENAME);
}

/** 索引跟着本 skill 走：agent 已经知道本 skill 的位置，查归属不必再记一个路径。 */
function indexPath(skillsRoot: string): string {
  const home = path.join(skillsRoot, SELF_NAME);
  if (!isDir(home)) {
    throw new ToolError(
      `未找到本 skill 的安装目录: ${home}\n` +
        `索引要生成在它下面。先把 ${SELF_NAME} 安装到 skills 根目录，再执行。`,
    );
  }
  return path.join(home, INDEX_FILENAME);
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

/** 插入字段。已存在则原样返回。插在 frontmatter 末尾，不动其他行。 */
function addField(text: string): string {
  const { lines: fm, bodyStart } = splitFrontmatter(text);
  if (fm === null) {
    throw new ToolError("没有合法的 YAML frontmatter（首行不是 --- 或缺少闭合的 ---）");
  }
  if (fieldLineIndex(fm) !== -1) return text;

  const all = text.split("\n");
  all.splice(bodyStart - 1, 0, `${FIELD}: true`); // 闭合的 --- 之前
  return all.join("\n");
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
  /** 软链指向 skills 根之外时，改它会波及共用该目录的其他 runtime。 */
  readonly isSymlink: boolean;
  #text: string | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.name = path.basename(dir);
    this.md = path.join(dir, "SKILL.md");
    this.isScene = this.name.startsWith(SCENE_PREFIX);
    this.isSymlink = fs.lstatSync(dir).isSymbolicLink();
  }

  get text(): string {
    if (this.#text === null) this.#text = fs.readFileSync(this.md, "utf8");
    return this.#text;
  }

  get marked(): boolean {
    const { lines } = splitFrontmatter(this.text);
    return lines !== null && fieldLineIndex(lines) !== -1;
  }

  get description(): string {
    const { lines } = splitFrontmatter(this.text);
    return lines ? readScalar(lines, "description") : "";
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

/** 场景正文里照搬 skill 的完整 description。
 *
 *  场景正文不进启动上下文，进入场景后才加载，所以这里省字数省不到任何地方，
 *  反而会让「该读哪个 skill」失去判断依据。只压平换行，不截断。 */
function fullDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim();
}

/** 本 skill 自己不参与归集，但它的 description 照常注入，统计时不能漏。 */
function selfInjection(skillsRoot: string): { count: number; chars: number } {
  const dir = path.join(skillsRoot, SELF_NAME);
  if (!isFile(path.join(dir, "SKILL.md"))) return { count: 0, chars: 0 };
  const self = new Skill(dir);
  if (self.marked) return { count: 0, chars: 0 };
  return { count: 1, chars: SELF_NAME.length + self.description.length };
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

function cmdScan(root: string, asJson: boolean): number {
  const skills = collect(root);
  const scenes = skills.filter((s) => s.isScene);
  const plain = skills.filter((s) => !s.isScene);
  const marked = plain.filter((s) => s.marked);
  const unmarked = plain.filter((s) => !s.marked);
  const symlinked = unmarked.filter((s) => s.isSymlink);

  const self = selfInjection(root);
  const injected = [...scenes, ...unmarked];
  const injectedCount = injected.length + self.count;
  const chars =
    injected.reduce((sum, s) => sum + s.name.length + s.description.length, 0) + self.chars;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          skills_root: root,
          scenes: scenes.map((s) => s.name),
          marked: marked.map((s) => s.name),
          unmarked: unmarked.map((s) => s.name),
          symlinked_unmarked: symlinked.map((s) => s.name),
          injected_count: injectedCount,
          injected_chars: chars,
          injected_tokens_approx: approxTokens(chars),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`skills 根目录: ${root}`);
  console.log(`  场景入口     : ${scenes.length}`);
  console.log(`  已退出注入   : ${marked.length}`);
  console.log(`  仍在注入     : ${unmarked.length}`);
  console.log();
  console.log(
    `当前启动注入 ${injectedCount} 份 description，约 ${chars} 字符 / ${approxTokens(chars)} tokens`,
  );

  if (symlinked.length) {
    console.log();
    console.log(`注意：${symlinked.length} 个仍在注入的 skill 是软链，指向 skills 根之外。`);
    console.log("改动它们会波及共用该目录的其他工具（Cursor、Grok Build 读 ~/.agents/skills）。");
    for (const s of symlinked.slice(0, 10)) {
      console.log(`  ${s.name} -> ${fs.readlinkSync(s.dir)}`);
    }
    if (symlinked.length > 10) console.log(`  … 另有 ${symlinked.length - 10} 个`);
  }

  if (unmarked.length > 25) {
    console.log();
    console.log(`未归集数量 ${unmarked.length} 已超过 25，值得做一次归集。`);
  }
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
            `一个 skill 只能有一个主场景，跨场景引用靠 ${INDEX_FILENAME} 解决。`,
        );
      }
      owner.set(name, scene.slug);
    }
  }
  return plan;
}

function unassignedName(item: UnassignedSpec): string {
  return typeof item === "string" ? item : item.name;
}

type ApplyOptions = {
  plan: string;
  dryRun: boolean;
  skipSymlinks: boolean;
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

  const excluded = (plan.unassigned ?? []).map(unassignedName).filter((n) => byName.has(n));
  const targets = new Set([...planned, ...excluded]);

  const unplanned = [...byName.keys()].filter((n) => !targets.has(n)).sort();
  if (unplanned.length && !opts.allowUnplanned) {
    throw new ToolError(
      `这 ${unplanned.length} 个 skill 既不在任何场景里，也不在 unassigned 清单里:\n  ` +
        unplanned.join("\n  ") +
        "\n把它们归入场景或写进 unassigned（附 reason）；" +
        "确认要让它们保持现状则加 --allow-unplanned。",
    );
  }

  const skipped: string[] = [];
  if (opts.skipSymlinks) {
    for (const name of [...targets]) {
      if (byName.get(name)!.isSymlink) {
        skipped.push(name);
        targets.delete(name);
      }
    }
    skipped.sort();
  }

  // 提前校验索引落点，避免建完场景才发现无处可写。
  const index = indexPath(root);

  if (opts.dryRun) {
    console.log(`[dry-run] 将建立 ${plan.scenes.length} 个场景入口`);
    console.log(`[dry-run] 将打标 ${targets.size} 个 skill`);
    if (skipped.length) console.log(`[dry-run] 跳过 ${skipped.length} 个软链 skill`);
    if (unplanned.length) console.log(`[dry-run] 保持现状 ${unplanned.length} 个`);
    return 0;
  }

  // 已归集过时沿用原有的 had_field 记录。重新探测会把上一轮自己打的标
  // 误判成「skill 自带」，那样 restore 就再也摘不掉它了。
  const prior = new Map<string, boolean>();
  if (isFile(statePath(root))) {
    try {
      const old: State = JSON.parse(fs.readFileSync(statePath(root), "utf8"));
      for (const m of old.marked ?? []) prior.set(m.name, m.had_field);
    } catch (err) {
      throw new ToolError(
        `状态文件无法解析: ${statePath(root)}\n  ${(err as Error).message}\n` +
          `修好它或先 restore，不要在状态不明时重复 apply。`,
      );
    }
  }

  // --- 写操作从这里开始 ---
  const state: State = {
    version: STATE_VERSION,
    applied_at: new Date().toISOString(),
    skills_root: root,
    scenes: [],
    marked: [],
    skipped_symlinks: skipped,
    plan,
  };

  for (const scene of plan.scenes) {
    const dirName = SCENE_PREFIX + scene.slug;
    const sceneDir = path.join(root, dirName);
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, "SKILL.md"), renderScene(scene, byName), "utf8");
    state.scenes.push(dirName);
  }

  for (const name of [...targets].sort()) {
    const skill = byName.get(name)!;
    const had = prior.has(name) ? prior.get(name)! : skill.marked;
    if (!skill.marked) {
      try {
        skill.write(addField(skill.text));
      } catch (err) {
        throw new ToolError(`${name}/SKILL.md 打标失败: ${(err as Error).message}`);
      }
    }
    state.marked.push({ name, had_field: had });
  }

  fs.writeFileSync(index, renderIndex(plan), "utf8");
  state.index = path.relative(root, index);
  fs.writeFileSync(statePath(root), JSON.stringify(state, null, 2), "utf8");

  const newly = state.marked.filter((m) => !m.had_field).length;
  console.log(`建立场景入口 ${state.scenes.length} 个`);
  console.log(`打标 ${newly} 个（另有 ${state.marked.length - newly} 个本来就带该字段，已记录不动）`);
  if (skipped.length) {
    console.log(
      `跳过软链 ${skipped.length} 个: ${skipped.slice(0, 5).join(", ")}` +
        (skipped.length > 5 ? " …" : ""),
    );
  }
  console.log(`索引: ${index}`);
  console.log(`状态: ${statePath(root)}`);
  console.log("改动即时生效，不必重开会话。");
  return 0;
}

function renderScene(scene: SceneSpec, byName: Map<string, Skill>): string {
  const rows = scene.skills
    .map((n) => `- **[${n}](../${n}/SKILL.md)**\n  ${fullDescription(byName.get(n)!.description)}`)
    .join("\n");

  return `---
name: ${SCENE_PREFIX}${scene.slug}
description: "${scene.description}"
---

# ${scene.title}

## 本场景的 skill

${rows}

按当前这一步的需要读取其中一两个，不要全部读入。

## 不在本场景的

需要的能力不在上面的清单里时：

- 只要那一个 skill 的内容，直接 \`Read\` 它的 \`SKILL.md\`，路径是 skills 根目录下的同名目录。
- 整段工作要转到另一个领域，先读 \`../${SELF_NAME}/${INDEX_FILENAME}\` 查它属于哪个场景，再进那个场景。
`;
}

/** scene 与 skill 的名称对应，不写任何别的东西。 */
function renderIndex(plan: Plan): string {
  const lines = ["<!-- 由 scene-tool.ts 生成，勿手改 -->", "# scene -> skills", ""];
  for (const scene of plan.scenes) {
    lines.push(`${SCENE_PREFIX}${scene.slug}: ${scene.skills.join(" ")}`);
  }
  const unassigned = plan.unassigned ?? [];
  if (unassigned.length) {
    lines.push("", `(none): ${unassigned.map(unassignedName).join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

function cmdRestore(root: string): number {
  const sp = statePath(root);
  if (!isFile(sp)) {
    throw new ToolError(
      `状态文件不存在: ${sp}\n` +
        `没有它就无法区分哪些 ${FIELD} 是本工具加的、哪些是 skill 自带的，` +
        `无差别删除会破坏后者的调用契约。\n` +
        `处置见 references/collation.md〈状态文件丢失〉。`,
    );
  }

  const state: State = JSON.parse(fs.readFileSync(sp, "utf8"));
  if (state.version !== STATE_VERSION) {
    throw new ToolError(`状态文件版本 ${state.version} 不被支持（本工具为 ${STATE_VERSION}）`);
  }

  const byName = new Map(collect(root).map((s) => [s.name, s]));
  let unmarked = 0;
  let kept = 0;

  for (const item of state.marked ?? []) {
    if (item.had_field) {
      kept++;
      continue;
    }
    const skill = byName.get(item.name);
    if (!skill) {
      console.log(`  跳过 ${item.name}：目录已不存在`);
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

  const index = path.join(root, state.index ?? path.join(SELF_NAME, INDEX_FILENAME));
  if (isFile(index)) fs.unlinkSync(index);
  fs.unlinkSync(sp);

  console.log(`摘除打标 ${unmarked} 个`);
  console.log(`保留自带该字段的 ${kept} 个`);
  console.log(`删除场景入口 ${removed} 个，索引与状态文件已清除`);
  console.log("改动即时生效，不必重开会话。");
  return 0;
}

function cmdVerify(root: string): number {
  const sp = statePath(root);
  if (!isFile(sp)) {
    console.log(`未归集（状态文件不存在: ${sp}）`);
    return 0;
  }

  const state: State = JSON.parse(fs.readFileSync(sp, "utf8"));
  const byName = new Map(collect(root).map((s) => [s.name, s]));
  const problems: string[] = [];

  for (const dirName of state.scenes ?? []) {
    if (!isFile(path.join(root, dirName, "SKILL.md"))) {
      problems.push(`场景入口缺失: ${dirName}/SKILL.md`);
    }
  }

  for (const item of state.marked ?? []) {
    const skill = byName.get(item.name);
    if (!skill) problems.push(`已记录但目录不存在: ${item.name}`);
    else if (!skill.marked) problems.push(`打标丢失（可能被升级覆盖）: ${item.name}`);
  }

  const tracked = new Set<string>([
    ...(state.marked ?? []).map((m) => m.name),
    ...(state.scenes ?? []),
  ]);
  const newcomers = [...byName.values()]
    .filter((s) => !s.isScene && !tracked.has(s.name) && !s.marked)
    .map((s) => s.name)
    .sort();
  if (newcomers.length) {
    problems.push(
      `${newcomers.length} 个新 skill 未归集: ` +
        newcomers.slice(0, 10).join(", ") +
        (newcomers.length > 10 ? " …" : ""),
    );
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
  verify              校验归集状态一致性

选项:
  --skills-root <d>   skills 根目录（默认 ~/.claude/skills）
  --json              scan 输出 JSON
  --dry-run           apply 只预览，不写任何文件
  --skip-symlinks     apply 不打标软链 skill，避免波及共用该目录的其他工具
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
        "skip-symlinks": { type: "boolean" },
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
        skipSymlinks: Boolean(values["skip-symlinks"]),
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
