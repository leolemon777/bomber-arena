// The HUD: one candy-pill card per bomber across the top, the round timer, and the start and
// result screens. Chinese text; hints follow <html data-input> (keys or touch).
const ICON = {
  bomb: `<svg viewBox="0 0 20 20"><circle cx="9" cy="12" r="6.5" fill="#1d1f26"/><rect x="7" y="3.6" width="4" height="3" rx="1" fill="#e0b13a"/><path d="M11 4 q3-3 5-1" stroke="#c99a5a" stroke-width="1.6" fill="none"/><circle cx="7" cy="10" r="1.6" fill="#fff" opacity=".5"/></svg>`,
  fire: `<svg viewBox="0 0 20 20"><path d="M10 1.5c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2.4 1.3-3.6 2.4-4.8.2 1.6.8 2.4 1.6 2.7C8.5 6.5 9 4 10 1.5z" fill="#ff8a1f"/><path d="M10 9c.6 2 2.4 2.6 2.4 4.6a2.4 2.4 0 0 1-4.8 0c0-1.3.9-2 1.4-2.6.4.8.6 1 1 1.1C9.8 11 9.7 10 10 9z" fill="#ffe36b"/></svg>`,
  shoe: `<svg viewBox="0 0 20 20"><path d="M2 14.5V9l5-1 2 2.5c2 .2 5 1 7.5 2.6.9.6 1 1.5 1 2.4H2z" fill="#e8322f"/><rect x="2" y="14.6" width="15.5" height="2.6" rx="1.2" fill="#fff"/><path d="M7 7.5c1-3 3.5-4.5 6-4-1.2 1-2 2.3-2.4 3.9" fill="#ffd23f"/></svg>`,
};

const CSS = `
.bb { position:absolute; inset:0; font-family: "Arial Rounded MT Bold","PingFang SC","Microsoft YaHei",system-ui,sans-serif; color:#fff; }
.bb * { box-sizing:border-box; }
.bb-top { position:absolute; top:calc(10px + env(safe-area-inset-top)); left:50%; transform:translateX(-50%); display:flex; gap:8px; align-items:center; }
.bb-card { display:flex; align-items:center; gap:6px; padding:5px 10px 5px 5px; border-radius:999px; background:rgba(255,255,255,.92);
  box-shadow:0 3px 0 rgba(0,0,0,.18); color:#2a2d36; font-weight:800; font-size:12px; transition:opacity .3s, filter .3s; }
.bb-card.out { opacity:.45; filter:grayscale(1); }
.bb-card .face { width:26px; height:26px; border-radius:50%; border:3px solid #fff; box-shadow:0 0 0 2px rgba(0,0,0,.12) inset; position:relative; overflow:hidden; }
.bb-card .face::after { content:""; position:absolute; left:50%; top:0; width:5px; height:100%; transform:translateX(-50%); background:#fff; }
.bb-card .stat { display:flex; align-items:center; gap:1px; }
.bb-card svg { width:15px; height:15px; }
.bb-card .name { font-size:11px; margin-right:2px; white-space:nowrap; }
.bb-timer { min-width:64px; text-align:center; padding:6px 12px; border-radius:999px; background:#2a2d36; color:#fff; font-weight:900; font-size:17px;
  box-shadow:0 3px 0 rgba(0,0,0,.25); font-variant-numeric:tabular-nums; }
.bb-timer.low { background:#e8322f; }
.bb-screen { position:absolute; inset:0; display:grid; place-items:center; background:radial-gradient(ellipse at center, rgba(20,30,50,.35), rgba(20,30,50,.6)); }
.bb-panel { text-align:center; padding:26px 34px 24px; border-radius:28px; background:#fff; color:#2a2d36; box-shadow:0 8px 0 rgba(0,0,0,.2); max-width:min(92vw,420px); }
.bb-panel h1 { margin:0; font-size:44px; font-weight:900; color:#e8322f; letter-spacing:4px;
  text-shadow:0 4px 0 #b51f1d, 0 0 0 #000; -webkit-text-stroke:2px #fff; paint-order:stroke fill; }
.bb-panel h2 { margin:0 0 6px; font-size:40px; font-weight:900; }
.bb-panel p { margin:10px 0 0; font-size:14px; color:#5a5f6e; line-height:1.6; }
.bb-panel .stripe { width:64px; height:8px; border-radius:4px; margin:12px auto 4px; background:linear-gradient(90deg,#e8322f 40%,#fff 40% 60%,#e8322f 60%); box-shadow:0 0 0 2px #e8322f; }
.bb-go { margin-top:18px; display:inline-block; padding:12px 26px; border-radius:999px; background:#e8322f; color:#fff; font-weight:900; font-size:18px;
  box-shadow:0 5px 0 #b51f1d; cursor:pointer; border:none; font-family:inherit; }
.bb-go:active { transform:translateY(3px); box-shadow:0 2px 0 #b51f1d; }
.bb-legend { display:flex; justify-content:center; gap:14px; margin-top:12px; font-size:12px; color:#5a5f6e; }
.bb-legend span { display:flex; align-items:center; gap:4px; } .bb-legend svg { width:18px; height:18px; }
html[data-input=touch] .bb .k, html:not([data-input=touch]) .bb .t { display:none; }
@media (max-width:640px) { .bb-card .name { display:none; } .bb-card { padding-right:7px; gap:4px; } .bb-top { gap:4px; } .bb-panel h1 { font-size:34px; } }
`;

export function createHud(ui, { onStart }) {
  const root = document.createElement("div");
  root.className = "bb";
  root.innerHTML = `<style>${CSS}</style><div class="bb-top"></div><div class="bb-screen hit"></div>`;
  ui.append(root);
  const top = root.querySelector(".bb-top");
  const screen = root.querySelector(".bb-screen");
  screen.addEventListener("click", (e) => {
    if (e.target.closest(".bb-go")) onStart();
  });
  let cards = [];
  let timer;

  function setActors(actors) {
    top.innerHTML = "";
    cards = actors.map((a, i) => {
      const el = document.createElement("div");
      el.className = "bb-card";
      el.innerHTML = `<div class="face" style="background:${a.css}"></div><span class="name">${a.name}</span>
        <span class="stat">${ICON.bomb}<b data-b></b></span><span class="stat">${ICON.fire}<b data-f></b></span><span class="stat">${ICON.shoe}<b data-s></b></span>`;
      if (i === 2) {
        timer = document.createElement("div");
        timer.className = "bb-timer";
        top.append(timer);
      }
      top.append(el);
      return { el, b: el.querySelector("[data-b]"), f: el.querySelector("[data-f]"), s: el.querySelector("[data-s]") };
    });
    if (!timer || !timer.isConnected) {
      timer = document.createElement("div");
      timer.className = "bb-timer";
      top.insertBefore(timer, cards[1]?.el.nextSibling ?? null);
    }
  }

  function show(html) {
    screen.innerHTML = html;
    screen.style.display = html ? "grid" : "none";
  }

  return {
    setActors,
    tick(actors, timeLeft) {
      actors.forEach((a, i) => {
        const c = cards[i];
        if (!c) return;
        c.el.classList.toggle("out", !a.alive);
        c.b.textContent = a.bombsMax;
        c.f.textContent = a.range;
        c.s.textContent = a.speedLv + 1;
      });
      const t = Math.max(0, Math.ceil(timeLeft));
      timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
      timer.classList.toggle("low", t <= 30);
    },
    start() {
      show(`<div class="bb-panel"><h1>炸弹乱斗</h1><div class="stripe"></div>
        <p>放炸弹炸开箱子、捡道具，把对手都炸出局！<br>最后留在场上的人获胜。</p>
        <div class="bb-legend"><span>${ICON.bomb}多一颗炸弹</span><span>${ICON.fire}火力 +1</span><span>${ICON.shoe}速度 +1</span></div>
        <p class="k">方向键 / WASD 移动 · 空格 放炸弹 · Esc 暂停</p><p class="t">左手摇杆移动 · 右手按钮放炸弹</p>
        <button class="bb-go">开始游戏</button></div>`);
    },
    result(kind) {
      const text = { win: ["胜利！", "#2fb35a", "你是最后的赢家"], lose: ["出局了", "#e8322f", "被炸飞啦，再来一局？"], draw: ["平局", "#4a7bd6", "时间到 / 同归于尽"] }[kind];
      show(`<div class="bb-panel"><h2 style="color:${text[1]}">${text[0]}</h2><p>${text[2]}</p>
        <button class="bb-go">再来一局</button><p class="k" style="font-size:12px">或按 空格</p></div>`);
    },
    paused(on) {
      show(on ? `<div class="bb-panel"><h2>暂停</h2><p class="k">按 Esc 继续</p><p class="t">点暂停按钮继续</p></div>` : "");
    },
    hide() {
      show("");
    },
    dispose() {
      root.remove();
    },
  };
}
