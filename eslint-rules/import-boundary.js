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

export default {
  rules: {
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
