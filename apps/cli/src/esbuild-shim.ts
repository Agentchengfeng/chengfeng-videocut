/**
 * Portable subset of esbuild used by the bundled Studio server.
 *
 * The upstream server uses transformSync only as a parser-safe way to
 * normalize inline JavaScript. Bundling the native esbuild package would bake
 * this machine's node_modules path and platform binary into the public CLI, so
 * the GitHub build aliases that dependency to this Bun-native implementation.
 */

export interface TransformOptions {
  loader?: "js" | "jsx" | "ts" | "tsx";
  minify?: boolean;
  legalComments?: string;
}

export interface TransformResult {
  code: string;
  map: string;
  warnings: never[];
}

export function transformSync(source: string, options: TransformOptions = {}): TransformResult {
  const loader = options.loader === "jsx" || options.loader === "ts" || options.loader === "tsx"
    ? options.loader
    : "js";
  const transpiler = new Bun.Transpiler({ loader });
  return {
    code: transpiler.transformSync(source),
    map: "",
    warnings: [],
  };
}

export function buildSync(): never {
  throw new Error(
    "Runtime source compilation is unavailable in the portable build; use the bundled /api/runtime.js asset.",
  );
}

export default { transformSync, buildSync };
