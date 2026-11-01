import { mount } from 'svelte';
import { registerLlm2dLoader } from '@llm2d/svelte';
import Root from './Root.svelte';

// Teach PixiJS Assets to load *.l2d.json before pixi-svelte's AssetsLoader runs.
registerLlm2dLoader();

mount(Root, { target: document.getElementById('app')! });
