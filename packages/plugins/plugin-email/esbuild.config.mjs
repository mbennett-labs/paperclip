import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// CJS dependencies (imapflow, nodemailer) use dynamic require() of Node
// builtins; esbuild ESM output needs a createRequire shim.
const workerOptions = {
  ...presets.esbuild.worker,
  banner: {
    js: 'import { createRequire as __pluginCreateRequire } from "node:module"; const require = __pluginCreateRequire(import.meta.url);',
  },
};

const workerCtx = await esbuild.context(workerOptions);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
}
