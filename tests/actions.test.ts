import { expect, test } from "vitest";
import { Actions, cdpParams } from "../src/browser/actions.js";

class Recorder extends Actions {
  readonly calls: [string, unknown][] = [];
  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    this.calls.push([method, params]);
    return { sent: method };
  }
}

test("cdpParams drops undefined only", () => {
  expect(cdpParams({ a: 1, b: undefined, c: null, d: false })).toEqual({
    a: 1,
    c: null,
    d: false,
  });
});

test("selector actions map to Human.* with camelCase options", async () => {
  const page = new Recorder();
  await page.click("#a", {
    clickCount: 2,
    modifiers: ["Shift"],
    preDelay: 10,
    timeout: 5,
  });
  await page.dblclick("#b", { button: "right" });
  await page.hover("#c", { scrollIntoView: false });
  await page.scroll({ deltaY: 300, duration: 200 });
  await page.scrollIntoView("#d", { behavior: "smooth" });
  await page.scrollTo({ y: 0 });
  expect(page.calls).toEqual([
    [
      "Human.click",
      { selector: "#a", clickCount: 2, modifiers: ["Shift"], preDelay: 10, timeout: 5 },
    ],
    ["Human.dblclick", { selector: "#b", button: "right" }],
    ["Human.moveTo", { selector: "#c", scrollIntoView: false }],
    ["Human.scroll", { deltaY: 300, duration: 200 }],
    ["Human.scrollIntoView", { selector: "#d", behavior: "smooth" }],
    ["Human.scrollTo", { y: 0 }],
  ]);
});

test("type clicks then types, fill triple-clicks first", async () => {
  const page = new Recorder();
  expect(await page.type("#q", "hello")).toEqual({ sent: "Human.type" });
  await page.fill("#q", "over");
  expect(page.calls).toEqual([
    ["Human.click", { selector: "#q" }],
    ["Human.type", { text: "hello" }],
    ["Human.click", { selector: "#q", clickCount: 3 }],
    ["Human.type", { text: "over" }],
  ]);
});

test("keyboard and mouse", async () => {
  const page = new Recorder();
  await page.keyboard.type("x");
  await page.keyboard.press("Enter", { modifiers: ["Control"], delay: 50 });
  await page.mouse.move(1, 2);
  await page.mouse.click(3, 4, { button: "middle", clickCount: 1 });
  await page.mouse.down(5, 6);
  await page.mouse.up(5, 6, { button: "left" });
  await page.mouse.wheel({ deltaY: -100 });
  await page.mouse.drag({ startX: 0, startY: 0, endX: 10, endY: 10 });
  expect(page.calls).toEqual([
    ["Human.type", { text: "x" }],
    ["Human.press", { key: "Enter", modifiers: ["Control"], delay: 50 }],
    ["Human.moveTo", { x: 1, y: 2 }],
    ["Human.click", { x: 3, y: 4, button: "middle", clickCount: 1 }],
    ["Human.mouseDown", { x: 5, y: 6 }],
    ["Human.mouseUp", { x: 5, y: 6, button: "left" }],
    ["Human.wheel", { deltaY: -100 }],
    ["Human.drag", { startX: 0, startY: 0, endX: 10, endY: 10 }],
  ]);
});
