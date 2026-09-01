/** Shared contracts used by the bundled task client, RPC server, and manager registry. */

export const SUBAGENTS_RPC_PROTOCOL_VERSION = 3;

export const STRUCTURED_OUTPUT_MIGRATION_ERROR =
  "options.structuredOutput is no longer supported; workflow children return text/Markdown. "
  + "Migrate structured results to line-oriented text or Markdown.";
