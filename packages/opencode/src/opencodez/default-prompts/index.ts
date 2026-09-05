import CODEX_GPT_5_2 from "./core/codex_gpt_5_2.md" with { type: "text" }
import CODEX_GPT_5_2_CODEX from "./core/codex_gpt_5_2_codex.md" with { type: "text" }
import CODEX_GPT_5_3_CODEX from "./core/codex_gpt_5_3_codex.md" with { type: "text" }
import CODEX_GPT_5_4 from "./core/codex_gpt_5_4.md" with { type: "text" }
import CODEX_GPT_5_4_MINI from "./core/codex_gpt_5_4_mini.md" with { type: "text" }
import CODEX_GPT_5_5 from "./core/codex_gpt_5_5.md" with { type: "text" }
import CODEX_GPT_5_6_LUNA_TERRA from "./core/codex_gpt_5_6_luna_terra.md" with { type: "text" }
import CODEX_GPT_6_ASTRA from "./core/codex_gpt_6_astra.md" with { type: "text" }

export const defaultPromptAssets = {
  core: {
    "codex_gpt_5_2.md": CODEX_GPT_5_2,
    "codex_gpt_5_2_codex.md": CODEX_GPT_5_2_CODEX,
    "codex_gpt_5_3_codex.md": CODEX_GPT_5_3_CODEX,
    "codex_gpt_5_4.md": CODEX_GPT_5_4,
    "codex_gpt_5_4_mini.md": CODEX_GPT_5_4_MINI,
    "codex_gpt_5_5.md": CODEX_GPT_5_5,
    "codex_gpt_5_6_luna_terra.md": CODEX_GPT_5_6_LUNA_TERRA,
    "codex_gpt_5_6_sol.md": CODEX_GPT_5_6_LUNA_TERRA,
    "codex_gpt_6_astra.md": CODEX_GPT_6_ASTRA,
  },
} as const
