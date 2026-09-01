/**
 * lib/count-child.js — a nested workflow, invoked by compose.js.
 *
 * A child is an ordinary workflow: it needs its own `export const meta =`
 * declaration, which is exactly what marks a file in a workflows directory as
 * runnable rather than as some unrelated script that happens to live there.
 *
 * args: { root?: string }
 */
export const meta = {
  name: 'count-child',
  description: 'Count the source files under a directory',
}

const root = args?.root ?? 'src/'

const found = await agent(`List every source file under ${root}. Return one path per line, nothing else.`, {
  label: 'scan',
})

// Keep the handoff deterministic: blank lines do not represent source files.
return typeof found === 'string'
  ? found.split('\n').filter(line => line.trim().length > 0).length
  : 0
