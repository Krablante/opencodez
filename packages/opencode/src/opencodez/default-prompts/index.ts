import CODEX_GPT_5_2 from "./core/codex_gpt_5_2.md" with { type: "text" }
import CODEX_GPT_5_4 from "./core/codex_gpt_5_4.md" with { type: "text" }
import CODEX_GPT_5_5 from "./core/codex_gpt_5_5.md" with { type: "text" }
import CODEX_PRAGMATIC from "./tone/codex_pragmatic.md" with { type: "text" }
import GPT55 from "./templates/gpt55.jsonc" with { type: "text" }

export const defaultPromptAssets = {
  core: {
    "codex_gpt_5_2.md": CODEX_GPT_5_2,
    "codex_gpt_5_4.md": CODEX_GPT_5_4,
    "codex_gpt_5_5.md": CODEX_GPT_5_5,
  },
  tone: {
    "codex_pragmatic.md": CODEX_PRAGMATIC,
  },
  templates: {
    "gpt55.jsonc": GPT55,
  },
} as const
