// What a Session's Harness is kept from in its Sandbox, from wherever it would come: a Variable,
// the Login environment, or the Sandbox's own. Claude Code runs on its Creator's setup token alone
// (ADR 0026), and pi reaches every Provider through the Hub's Gateway alone (ADR 0029). The Runner
// keeps these out of the Harness's own process, and pi's Claude bridge keeps Claude Code's out of
// the Claude Code it runs. Other processes in the Sandbox still get them.

/**
 * The variables that would sign Claude Code in some other way than its Creator's setup token, or
 * send its requests somewhere else.
 */
export const ClaudeCodeSignInVariables: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]

/**
 * Every variable pi-ai reads a Provider's key from (its `findEnvKeys`), as the pi-ai of the pi the
 * Runner pins has them, which the Runner's tests check: with one, pi would call that Provider
 * itself, around the Gateway, on whoever's key it is.
 * Ambient credentials pi-ai also takes, such as AWS's for Amazon Bedrock and Google's Application
 * Default Credentials, aren't keys of a Provider kndl connects, and stay for the Repo's own tools.
 */
export const PiProviderKeyVariables: ReadonlyArray<string> = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "BASETEN_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "META_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "TOGETHER_API_KEY",
  "TYPESAFE_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
]
