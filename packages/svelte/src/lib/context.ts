import { getContext, setContext } from 'svelte';
import type { Llm2dActor } from '@llm2d/pixi';

const KEY = '@@llm2d_actor';

export function setContextLlm2d(actor: Llm2dActor): void {
  setContext(KEY, actor);
}

/** The actor of the closest enclosing <Llm2dProvider>. */
export function getContextLlm2d(): Llm2dActor {
  const actor = getContext<Llm2dActor | undefined>(KEY);
  if (!actor) throw new Error('LLM2D components must be placed inside <Llm2dProvider>.');
  return actor;
}
