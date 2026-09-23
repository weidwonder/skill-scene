# skill-scene

**English** · [简体中文](README.zh-CN.md)

Collate an oversized skill library into a handful of scenes, so startup injection drops from hundreds of descriptions to a dozen.

## The problem

At the start of every session Claude Code injects the `name` and `description` of every skill under `~/.claude/skills/` into the system prompt, whether or not the current project could use them. Once you have a hundred-odd skills, that menu alone costs close to ten thousand tokens — and dozens of entries with overlapping responsibilities keep diluting routing accuracy.

## The approach

Claude Code supports a per-skill listing state. `skillOverrides` in `settings.json` sets it by skill name, and the four states mean:

| State | Startup listing | Model invocation | `/name` by the user |
|-------|----------------|------------------|---------------------|
| `on` (default) | name + description | yes | yes |
| `name-only` | **name only** | **yes** | yes |
| `user-invocable-only` | absent | no | yes |
| `off` | absent | no | no |

This mechanism uses `name-only`: the description is no longer injected, while the skill stays in the listing and remains callable through the Skill tool. The skills directory is then rearranged into two layers:

```
~/.claude/skills/
├── skill-scene/              # this skill, always resident
├── scene-software-delivery/
│   └── SKILL.md              # scene entry: routed by the model, lists the scene's skills
├── dw-workflow/              # file untouched, only set to name-only in settings
└── lark-doc/                 # same
```

What the model sees is a dozen scene entries with descriptions, plus a list of bare skill names. It first decides which scene the task falls into, enters it, picks up that domain's skill list with each skill's full description from the scene body, and calls the one or two it needs. The user's `/` invocation is unaffected throughout.

**Collation modifies no skill file.** The configuration lives in `settings.json`, so a kit upgrade that overwrites `SKILL.md` cannot undo collation, and skills symlinked from `~/.agents/skills/` do not affect the other tools sharing that directory.

A scene directory holds a single `SKILL.md`, and its list carries each skill's name and full description — no copied body, no symlink. There is always exactly one copy of a skill, so an upstream upgrade cannot leave a stale second version behind.

A skill that fits no scene is left alone and keeps its description in the listing, but **no more than 15 of them** may stay resident. Past that cap the agent first tries to collate them, then hands whatever is left to the user, who either proposes a new way to collate them or decides to keep them resident. The skills the user agrees to keep are listed by name in the plan's `residue_waiver`, together with the user's reason; if anything outside that list pushes the count over the cap, `apply` refuses to run.

## Requirements

Node 22.18 or newer (runs TypeScript natively, no build step and no dependencies). Between 22.6 and 22.17, pass `--experimental-strip-types` when running the script.

`skillOverrides` requires Claude Code 2.1 or newer.

## Install

Drop the `skill-scene/` directory into `~/.claude/skills/`.

## Usage

```bash
cd ~/.claude/skills/skill-scene/scripts

node scene-tool.ts scan                          # inventory: how many still inject, how many tokens
node scene-tool.ts apply --plan scenes.json --dry-run
node scene-tool.ts apply --plan scenes.json      # collate
node scene-tool.ts verify                        # check consistency and the resident cap
node scene-tool.ts restore                       # roll back
```

The `scenes.json` classification plan is produced by the agent using this skill, following the method in `references/scene-authoring.md`, and is executed only after the user confirms it.

## Restore

`restore` rolls back from `~/.claude/.skill-scene-state.json`, deleting only the `skillOverrides` entries this tool wrote — a skill whose state the user set themselves keeps its value. Without the state file the script refuses to run rather than guessing.

The state file deliberately sits in the parent of the skills root, next to `settings.json`, so deleting this skill does not destroy the basis for rolling back.

## Scope

Only Claude Code's `~/.claude/skills/`.

Two kinds of skill are outside `skillOverrides`: those provided by plugins (any state is treated as `on` for them), and those whose frontmatter already carries `disable-model-invocation: true` (that field locks out both `on` and `name-only` and disables model invocation). The latter never took part in automatic routing anyway, so collation only lists them in a scene and leaves file and configuration untouched.

Cursor and Grok Build share `~/.agents/skills/`, and Codex reads `$HOME/.agents/skills` while controlling implicit invocation through `allow_implicit_invocation` in `agents/openai.yaml` — different mechanisms in each case. This one writes only Claude Code's own `settings.json` and never touches a skill file, so those tools are unaffected.
