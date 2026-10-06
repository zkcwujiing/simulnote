/**
 * 单元测试用的模块解析钩子（Node 内置 `module.register`，**不引入任何依赖**）。
 *
 * 为什么需要它：源码里的导入是 Vite 风格的 —— `@/lib/xxx` 这种别名、以及不带
 * 扩展名的相对导入（`./facts`）。Node 自带的类型擦除（Node 22.6+，Node 23.6 起
 * 默认开启）能直接跑 `.ts`，但它的解析器不认别名、也要求写全扩展名。
 * 与其为了跑两个纯函数单测去装 vitest（几百个包），不如补一个 30 行的钩子。
 *
 * 覆盖两种情况：
 *   1. `@/...`      → `<仓库根>/src/...`
 *   2. 无扩展名     → 依次尝试 `.ts` / `.tsx` / `index.ts` / `.js` / `.json`
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const EXT_TRIES = ['.ts', '.tsx', '/index.ts', '/index.tsx', '.js', '.mjs', '.json'];

function hasExtension(p) {
  return /\.[cm]?[jt]sx?$/.test(p) || /\.json$/.test(p);
}

function resolveFile(base) {
  if (hasExtension(base) && existsSync(base)) return base;
  for (const ext of EXT_TRIES) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // 1) `@/xxx` 别名
  if (specifier.startsWith('@/')) {
    const found = resolveFile(join(SRC, specifier.slice(2)));
    if (found) return nextResolve(pathToFileURL(found).href, context);
    return nextResolve(pathToFileURL(join(SRC, specifier.slice(2))).href, context);
  }

  // 2) 相对导入补扩展名
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL));
    const found = resolveFile(join(base, specifier));
    if (found) return nextResolve(pathToFileURL(found).href, context);
  }

  return nextResolve(specifier, context);
}
