import CODEX_GPT_5_2 from "./core/codex_gpt_5_2.md" with { type: "text" }
import CODEX_GPT_5_2_CODEX from "./core/codex_gpt_5_2_codex.md" with { type: "text" }
import CODEX_GPT_5_3_CODEX from "./core/codex_gpt_5_3_codex.md" with { type: "text" }
import CODEX_GPT_5_4 from "./core/codex_gpt_5_4.md" with { type: "text" }
import CODEX_GPT_5_4_MINI from "./core/codex_gpt_5_4_mini.md" with { type: "text" }
import CODEX_GPT_5_5 from "./core/codex_gpt_5_5.md" with { type: "text" }
import CODEX_FRIENDLY from "./tone/codex_friendly.md" with { type: "text" }
import CODEX_PRAGMATIC from "./tone/codex_pragmatic.md" with { type: "text" }
import GPT55 from "./templates/gpt55.jsonc" with { type: "text" }

export const defaultPromptAssets = {
  core: {
    "codex_gpt_5_2.md": CODEX_GPT_5_2,
    "codex_gpt_5_2_codex.md": CODEX_GPT_5_2_CODEX,
    "codex_gpt_5_3_codex.md": CODEX_GPT_5_3_CODEX,
    "codex_gpt_5_4.md": CODEX_GPT_5_4,
    "codex_gpt_5_4_mini.md": CODEX_GPT_5_4_MINI,
    "codex_gpt_5_5.md": CODEX_GPT_5_5,
  },
  tone: {
    "codex_friendly.md": CODEX_FRIENDLY,
    "codex_pragmatic.md": CODEX_PRAGMATIC,
  },
  templates: {
    "gpt55.jsonc": GPT55,
  },
} as const
