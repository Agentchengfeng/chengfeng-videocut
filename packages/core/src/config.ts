/**
 * The product's own configuration, kept once per machine.
 *
 * Everything here used to be an environment variable and nothing else, which
 * meant it existed only in whichever shell happened to export it. The cost of
 * that showed up as a hole nobody could see: the product requires a cloud
 * transcription key, the Skills assume it is present, four contract documents
 * never mention it, and `doctor` does not look for it. A shell that lacks it
 * fails at the moment of the call, with an error about a missing adapter.
 *
 * A file in the product's own home is read the same way no matter who started
 * the process — a Skill through Codex, a terminal, or the LaunchAgent, whose
 * environment is four fixed variables and cannot inherit a profile at all.
 *
 * ```text
 * 环境变量     临时覆盖、CI、多账号切换        最高优先级
 * 配置文件     这台机器的常设值                其次
 * 内置默认     resourceId / modelName          兜底
 * ```
 *
 * Deliberately not encrypted. A 0600 file in the user's home is what tools of
 * this kind do; anything stronger belongs in the Keychain, and half-encryption
 * only buys the feeling of safety. Deliberately not per-project either: project
 * directories are shared and packaged — the bug reporter already has to strip
 * credentials out of them.
 */

export const PRODUCT_CONFIG_FILE = "config.json" as const;

export interface TranscriptionConfig {
  provider?: "volcengine";
  apiKey?: string;
  resourceId?: string;
  modelName?: string;
}

export interface ProductConfig {
  transcription?: TranscriptionConfig;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Read a config document, keeping only fields this version understands.
 *
 * A malformed or half-written file yields an empty config rather than throwing.
 * Configuration is not the point of any command that reads it, and failing the
 * edit someone is in the middle of because a settings file has a stray comma
 * would be the wrong trade — the command that actually needs a key still says
 * so, by name, when it comes to use it.
 */
export function parseProductConfig(value: unknown): ProductConfig {
  if (!isObject(value)) return {};
  const transcription = isObject(value.transcription) ? value.transcription : undefined;
  if (!transcription) return {};
  const provider = optionalString(transcription.provider);
  return {
    transcription: {
      ...(provider === "volcengine" ? { provider } : {}),
      ...(optionalString(transcription.apiKey)
        ? { apiKey: optionalString(transcription.apiKey) as string }
        : {}),
      ...(optionalString(transcription.resourceId)
        ? { resourceId: optionalString(transcription.resourceId) as string }
        : {}),
      ...(optionalString(transcription.modelName)
        ? { modelName: optionalString(transcription.modelName) as string }
        : {}),
    },
  };
}

/** Every setting this product stores, and where each one comes from. */
export const CONFIG_FIELDS = [
  {
    path: "transcription.apiKey",
    env: "VOLCENGINE_API_KEY",
    secret: true,
    required: true,
    describe: "云端转录凭据",
  },
  {
    path: "transcription.resourceId",
    env: "VOLCENGINE_ASR_RESOURCE_ID",
    secret: false,
    required: false,
    describe: "云端转录资源 id",
  },
  {
    path: "transcription.modelName",
    env: "VOLCENGINE_ASR_MODEL_NAME",
    secret: false,
    required: false,
    describe: "云端转录模型",
  },
] as const;

export type ConfigFieldPath = (typeof CONFIG_FIELDS)[number]["path"];

export function configField(path: string): (typeof CONFIG_FIELDS)[number] | null {
  return CONFIG_FIELDS.find((field) => field.path === path) ?? null;
}

/** Where one setting's value came from, so `doctor` can say more than "missing". */
export type ConfigSource = "env" | "config" | "default" | "none";

export interface ResolvedSetting {
  value: string | undefined;
  source: ConfigSource;
}

/**
 * Resolve one setting: environment first, then the file, then the built-in.
 *
 * Environment wins so a value can be overridden for one command without editing
 * anything — a second account, a CI run, a key being rotated.
 */
export function resolveSetting(
  path: ConfigFieldPath,
  config: ProductConfig,
  environment: Record<string, string | undefined>,
  fallback?: string,
): ResolvedSetting {
  const field = configField(path);
  if (!field) return { value: fallback, source: fallback === undefined ? "none" : "default" };
  const fromEnv = optionalString(environment[field.env]);
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  const [, key] = path.split(".") as [string, keyof TranscriptionConfig];
  const fromFile = optionalString(config.transcription?.[key]);
  if (fromFile !== undefined) return { value: fromFile, source: "config" };
  return fallback === undefined
    ? { value: undefined, source: "none" }
    : { value: fallback, source: "default" };
}

/** Put one setting into a config document without disturbing the others. */
export function withSetting(
  config: ProductConfig,
  path: ConfigFieldPath,
  value: string,
): ProductConfig {
  const [, key] = path.split(".") as [string, keyof TranscriptionConfig];
  return {
    ...config,
    transcription: {
      provider: "volcengine",
      ...config.transcription,
      [key]: value,
    },
  };
}

/**
 * How a secret is shown when a command reports what is configured.
 *
 * Enough to tell one key from another, never enough to use. Commands print
 * their own arguments in logs and event files, so a stored secret must have
 * exactly one readable form and this is it.
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}${"•".repeat(6)}${trimmed.slice(-4)}`;
}
