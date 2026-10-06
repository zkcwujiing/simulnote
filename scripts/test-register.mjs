/**
 * 把 `scripts/test-hooks.mjs` 注册进 Node 的模块解析链。
 * 用法见 package.json 的 `test` 脚本。
 */
import { register } from 'node:module';

register('./test-hooks.mjs', import.meta.url);
