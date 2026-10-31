import { describe, it, expect, afterEach } from "vitest";
import { focusables, rememberFocus, trapTab } from "./focusReturn";

afterEach(() => { document.body.innerHTML = ""; });

function html(s: string) {
  document.body.innerHTML = s;
}
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;

describe("rememberFocus", () => {
  it("devolve o foco a quem o tinha quando o overlay fecha com o foco dentro", () => {
    html(`<button id="gatilho"></button><div id="menu"><button id="item"></button></div>`);
    $("#gatilho").focus();
    const ret = rememberFocus();
    $("#item").focus();
    ret.restore({ within: $("#menu") });
    expect(document.activeElement).toBe($("#gatilho"));
  });

  it("não rouba o foco de quem o recebeu fora do overlay (clique em outro lugar)", () => {
    html(`<button id="gatilho"></button><div id="menu"><button id="item"></button></div><input id="busca">`);
    $("#gatilho").focus();
    const ret = rememberFocus();
    $("#busca").focus();
    ret.restore({ within: $("#menu") });
    expect(document.activeElement).toBe($("#busca"));
  });

  it("foco no <body> (overlay já saiu do DOM) também volta", () => {
    html(`<button id="gatilho"></button><div id="menu"><button id="item"></button></div>`);
    $("#gatilho").focus();
    const ret = rememberFocus();
    $("#item").focus();
    const menu = $("#menu");
    menu.remove();
    ret.restore({ within: menu });
    expect(document.activeElement).toBe($("#gatilho"));
  });

  it("quem tinha o foco sumiu ou era o <body>: usa o fallback", () => {
    html(`<button id="pb-queue"></button>`);
    (document.activeElement as HTMLElement | null)?.blur();
    const ret = rememberFocus(() => document.getElementById("pb-queue"));
    ret.restore();
    expect(document.activeElement).toBe($("#pb-queue"));
  });
});

describe("trapTab", () => {
  const tab = (shift = false) => new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, cancelable: true });

  it("Tab no último volta ao primeiro; Shift+Tab no primeiro vai ao último", () => {
    html(`<div id="dlg"><button id="a"></button><button id="b" disabled></button><button id="c"></button></div>`);
    const dlg = $("#dlg");
    $("#c").focus();
    const e1 = tab();
    expect(trapTab(e1, dlg)).toBe(true);
    expect(e1.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe($("#a"));
    const e2 = tab(true);
    trapTab(e2, dlg);
    expect(document.activeElement).toBe($("#c"));
  });

  it("no meio da lista deixa o Tab seguir normal", () => {
    html(`<div id="dlg"><button id="a"></button><button id="b"></button><button id="c"></button></div>`);
    $("#b").focus();
    const e = tab();
    expect(trapTab(e, $("#dlg"))).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it("focusables ignora o que está dentro de [inert]", () => {
    html(`<div id="r"><button id="a"></button><div inert><button id="x"></button></div></div>`);
    expect(focusables($("#r")).map((el) => el.id)).toEqual(["a"]);
  });
});
