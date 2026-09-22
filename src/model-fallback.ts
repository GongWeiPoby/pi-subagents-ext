/** Next backup model. Keys are `provider/modelId`. Cycles and self-maps stop. */

export function nextModelFallback(
  current: string,
  fallbacks: Record<string, string> | undefined,
  tried: ReadonlySet<string>,
): string | undefined {
  const next = fallbacks?.[current]?.trim();
  if (!next || next === current || tried.has(next)) return undefined;
  return next;
}

export function modelKeyOf(model: { provider: string; id: string } | undefined): string | undefined {
  if (!model?.provider || !model.id) return undefined;
  return `${model.provider}/${model.id}`;
}
