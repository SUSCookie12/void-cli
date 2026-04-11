/**
 * Ink expects the same exports as `yoga-wasm-web/auto`. We use the ASM build so the
 * layout engine loads synchronously (no WASM file, no top-level await) — required for
 * esbuild CJS output and for `pkg` + `require()` without dynamic `import()`.
 */
import asm from 'yoga-wasm-web/asm';

const Yoga = asm();
export default Yoga;
