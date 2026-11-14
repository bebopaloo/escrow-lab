import { dirname, relative, resolve, sep } from "node:path";

const areas = ["modules", "adapters"];
const message = "Import a module or an adapter through its index.ts only.";

/** Return [area, name, rest] for a path below apps/api/src/{modules,adapters}/, or null. */
function locate(path, srcRoot) {
  const parts = relative(srcRoot, path).split(sep);
  const [area, name, ...rest] = parts;
  if (area === undefined || name === undefined || rest.length === 0) return null;
  if (!areas.includes(area) || area.startsWith("..")) return null;
  return { area, name, rest: rest.join("/") };
}

const stripExt = (path) => path.replace(/\.[cm]?[jt]s$/, "");

/** True when a path is an adapter index.ts, an adapter fake.ts or adapters/fake-core.ts. */
function isFakeEntry(path, srcRoot) {
  const parts = relative(srcRoot, path).split(sep);
  if (parts[0] !== "adapters") return false;
  if (parts.length === 2) return stripExt(parts[1]) === "fake-core";
  if (parts.length === 3) return ["index", "fake", ""].includes(stripExt(parts[2]));
  return false;
}

export default {
  rules: {
    "no-dynamic-fake-import": {
      meta: { type: "problem", schema: [] },
      create(context) {
        const file = context.filename;
        const srcRoot = resolve(context.cwd, "apps/api/src");
        return {
          ImportExpression: (node) => {
            const source = node.source;
            let specifier = null;
            if (source.type === "Literal" && typeof source.value === "string") {
              specifier = source.value;
            } else if (source.type === "TemplateLiteral" && source.expressions.length === 0) {
              specifier = source.quasis[0]?.value.cooked ?? null;
            }
            if (specifier === null) {
              context.report({
                node,
                message: "A dynamic import needs a literal source, so a lint rule can check it.",
              });
              return;
            }
            if (!specifier.startsWith(".")) return;
            if (isFakeEntry(resolve(dirname(file), specifier), srcRoot)) {
              context.report({
                node,
                message: "Only test code can dynamically import an adapter or a fake.",
              });
            }
          },
        };
      },
    },
    "import-boundary": {
      meta: { type: "problem", schema: [] },
      create(context) {
        const file = context.filename;
        const srcRoot = resolve(context.cwd, "apps/api/src");
        const own = locate(file, srcRoot);

        function check(node, source) {
          if (!source || typeof source.value !== "string") return;
          const specifier = source.value;
          if (!specifier.startsWith(".")) return;
          const target = locate(resolve(dirname(file), specifier), srcRoot);
          if (!target) return;
          if (own?.area === target.area && own.name === target.name) return;
          if (target.rest === "index.ts") return;
          context.report({ node, message });
        }

        return {
          ImportDeclaration: (node) => check(node, node.source),
          ExportNamedDeclaration: (node) => check(node, node.source),
          ExportAllDeclaration: (node) => check(node, node.source),
          ImportExpression: (node) => {
            check(node, node.source.type === "Literal" ? node.source : null);
          },
        };
      },
    },
  },
};
