import type { KeyModifier, MouseButton, ScrollBehavior } from "../types.js";

export type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;

export function cdpParams(given: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(given)) {
    if (value !== undefined) params[key] = value;
  }
  return params;
}

export interface ClickOptions {
  button?: MouseButton;
  clickCount?: number;
  modifiers?: KeyModifier[];
  waitForVisible?: boolean;
  scrollIntoView?: boolean;
  preDelay?: number;
  postDelay?: number;
  timeout?: number;
}

export type DblclickOptions = Omit<ClickOptions, "clickCount">;

export interface HoverOptions {
  waitForVisible?: boolean;
  scrollIntoView?: boolean;
  timeout?: number;
}

export interface PressOptions {
  modifiers?: KeyModifier[];
  delay?: number;
}

export interface MouseClickOptions {
  button?: MouseButton;
  clickCount?: number;
  modifiers?: KeyModifier[];
  preDelay?: number;
  postDelay?: number;
}

export interface ScrollOptions {
  deltaX?: number;
  deltaY?: number;
  duration?: number;
}

export interface ScrollToOptions {
  x?: number;
  y?: number;
  behavior?: ScrollBehavior;
}

export interface DragOptions {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  button?: MouseButton;
}

export class Keyboard {
  readonly #send: Send;

  constructor(send: Send) {
    this.#send = send;
  }

  type(text: string): Promise<any> {
    return this.#send("Human.type", { text });
  }

  press(key: string, options: PressOptions = {}): Promise<any> {
    return this.#send("Human.press", cdpParams({ key, ...options }));
  }
}

export class Mouse {
  readonly #send: Send;

  constructor(send: Send) {
    this.#send = send;
  }

  move(x: number, y: number): Promise<any> {
    return this.#send("Human.moveTo", { x, y });
  }

  click(x: number, y: number, options: MouseClickOptions = {}): Promise<any> {
    return this.#send("Human.click", cdpParams({ x, y, ...options }));
  }

  down(x: number, y: number, options: { button?: MouseButton } = {}): Promise<any> {
    return this.#send("Human.mouseDown", cdpParams({ x, y, ...options }));
  }

  up(x: number, y: number, options: { button?: MouseButton } = {}): Promise<any> {
    return this.#send("Human.mouseUp", cdpParams({ x, y, ...options }));
  }

  wheel(options: { deltaX?: number; deltaY?: number } = {}): Promise<any> {
    return this.#send("Human.wheel", cdpParams({ ...options }));
  }

  drag(options: DragOptions): Promise<any> {
    return this.#send("Human.drag", cdpParams({ ...options }));
  }
}

export abstract class Actions {
  readonly keyboard: Keyboard;
  readonly mouse: Mouse;

  constructor() {
    const send: Send = (method, params) => this.send(method, params);
    this.keyboard = new Keyboard(send);
    this.mouse = new Mouse(send);
  }

  abstract send(method: string, params?: Record<string, unknown>): Promise<any>;

  click(selector: string, options: ClickOptions = {}): Promise<any> {
    return this.send("Human.click", cdpParams({ selector, ...options }));
  }

  dblclick(selector: string, options: DblclickOptions = {}): Promise<any> {
    return this.send("Human.dblclick", cdpParams({ selector, ...options }));
  }

  hover(selector: string, options: HoverOptions = {}): Promise<any> {
    return this.send("Human.moveTo", cdpParams({ selector, ...options }));
  }

  async type(selector: string, text: string): Promise<any> {
    await this.click(selector);
    return this.keyboard.type(text);
  }

  async fill(selector: string, text: string): Promise<any> {
    await this.click(selector, { clickCount: 3 });
    return this.keyboard.type(text);
  }

  scroll(options: ScrollOptions = {}): Promise<any> {
    return this.send("Human.scroll", cdpParams({ ...options }));
  }

  scrollIntoView(
    selector: string,
    options: { behavior?: ScrollBehavior } = {},
  ): Promise<any> {
    return this.send("Human.scrollIntoView", cdpParams({ selector, ...options }));
  }

  scrollTo(options: ScrollToOptions = {}): Promise<any> {
    return this.send("Human.scrollTo", cdpParams({ ...options }));
  }
}
