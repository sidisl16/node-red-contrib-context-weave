'use strict';

function libraryIsLocal(options) {
  if (!options) return false;
  // Older flow exports may predate the privacy field. Apply the library editor default.
  const policy = options.privacy || options.privacyPolicy || 'local-only';
  return options.localOnly === true || policy === 'local-only';
}

function inheritPolicy(ctx) {
  const entries = Array.isArray(ctx.cfg.libraries) ? ctx.cfg.libraries : [];
  const libraries = [ctx.library, ...entries.map(e => ctx.RED.nodes.getNode(e?.library || e))];
  if (libraries.some(lib => libraryIsLocal(lib?.options)) ||
      ctx.cw.conversation?.localOnly === true ||
      ctx.cw.evidence?.some?.(e => e?.privacy === 'local-only')) ctx.cw.localOnly = true;
}

module.exports = {libraryIsLocal, inheritPolicy};
