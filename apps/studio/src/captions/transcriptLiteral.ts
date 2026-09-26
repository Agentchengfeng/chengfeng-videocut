import { parseGsapScriptAcornForWrite } from "@hyperframes/parsers/gsap-parser-acorn";

export class CaptionSourceError extends Error {}

// The installed browser-safe parser exposes Acorn's AST without executing source.
// Only data literals at Program level or the legacy direct IIFE body are accepted.
interface Node { type: string; [key: string]: any }
const named = (node: Node) => node.type === "VariableDeclarator" && node.id?.type === "Identifier" && /^(TRANSCRIPT|script)$/.test(node.id.name);

function readArray(node: Node): Record<string, unknown>[] {
  if (node?.type !== "ArrayExpression") throw new CaptionSourceError("AST_TRANSCRIPT_NOT_LITERAL_ARRAY");
  return node.elements.map((element: Node | null) => {
    if (element?.type !== "ObjectExpression") throw new CaptionSourceError("AST_WORD_NOT_LITERAL_OBJECT");
    const value: Record<string, unknown> = Object.create(null);
    for (const property of element.properties) {
      if (property.type !== "Property" || property.kind !== "init" || property.method || property.computed || property.shorthand) throw new CaptionSourceError("AST_PROPERTY_UNSUPPORTED");
      const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? property.key.value : null;
      if (typeof key !== "string" || Object.hasOwn(value, key)) throw new CaptionSourceError("AST_PROPERTY_KEY_INVALID");
      const literal = property.value;
      if (literal.type === "Literal" && !literal.regex && (typeof literal.value === "string" || typeof literal.value === "number")) value[key] = literal.value;
      else if (literal.type === "UnaryExpression" && literal.operator === "-" && literal.argument.type === "Literal" && typeof literal.argument.value === "number") value[key] = -literal.argument.value;
      else throw new CaptionSourceError("AST_VALUE_EXPRESSION_UNSUPPORTED");
    }
    return value;
  });
}

export function readTranscriptLiteral(source: string): unknown {
  // Raw JS must not mistake strings containing HTML for actual script elements.
  let scripts = [source];
  if (source.trimStart().startsWith("<")) {
    // Studio supplies the inert browser parser. Node-only HTML callers fail
    // closed rather than substituting regex or executing a document.
    if (typeof DOMParser === "undefined") throw new CaptionSourceError("HTML_DOM_PARSER_UNAVAILABLE");
    const doc = new DOMParser().parseFromString(source, "text/html");
    const classicTypes = new Set(["", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);
    scripts = [...doc.querySelectorAll("script")]
      .filter(script => !script.closest("template") && !script.hasAttribute("src") && !script.hasAttribute("nomodule")
        && classicTypes.has((script.getAttribute("type") ?? "").trim().toLowerCase()))
      .map(script => script.textContent ?? "");
  }
  if (!scripts.length) throw new CaptionSourceError("HTML_NO_SUPPORTED_INLINE_SCRIPT");
  const declarations: Node[] = [];
  for (const script of scripts) {
    const parsed = parseGsapScriptAcornForWrite(script);
    if (!parsed) throw new CaptionSourceError("AST_PARSE_FAILED");
    const ast = parsed.ast as Node;
    const allowed = new Set<Node>();
    const bodies: Node[][] = [ast.body];
    // The old generator emits one immediately invoked, zero-argument function.
    const iifes = ast.body.filter((statement: Node) => {
      const call = statement.type === "ExpressionStatement" ? statement.expression : null;
      return call?.type === "CallExpression" && call.arguments.length === 0
        && call.callee.type === "FunctionExpression" && !call.callee.id
        && !call.callee.async && !call.callee.generator && call.callee.params.length === 0;
    });
    if (iifes.length === 1) bodies.push(iifes[0].expression.callee.body.body);
    for (const body of bodies) for (const statement of body) {
      if (statement.type === "VariableDeclaration") for (const declaration of statement.declarations) {
        if (named(declaration)) allowed.add(declaration);
      }
    }
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(visit); return; }
      const current = node as Node;
      if (named(current)) {
        if (!allowed.has(current)) throw new CaptionSourceError("AST_DECLARATION_SCOPE_UNSUPPORTED");
        declarations.push(current);
      }
      for (const [key, child] of Object.entries(current)) if (key !== "loc" && key !== "value") visit(child);
    };
    visit(ast);
  }
  if (declarations.length !== 1) throw new CaptionSourceError("AST_DECLARATION_MISSING_OR_AMBIGUOUS");
  return readArray(declarations[0].init);
}
