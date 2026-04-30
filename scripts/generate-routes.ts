import { Generator, getConfig } from "@tanstack/router-generator";

const config = await getConfig({}, process.cwd());
const generator = new Generator({ config, root: process.cwd() });
await generator.run();
console.log("[generate-routes] wrote", config.generatedRouteTree);
