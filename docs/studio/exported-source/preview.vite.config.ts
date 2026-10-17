import { mergeConfig } from "vite";
import base from "./vite.config";
export default (env) => mergeConfig(
  typeof base === "function" ? base(env) : base,
  { server: { allowedHosts: true } });
